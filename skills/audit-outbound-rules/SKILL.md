---
name: audit-outbound-rules
description: Audit a customer's per-relationship outbound transformation rules at /v2/rules and flag any whitelist that's narrower than the partner's published spec. Run this BEFORE writing JSONata for a new outbound document type — misconfigured rules silently strip required EDI segments at send time, surfacing as "missing field" validation errors that NS-stored messages and /v3/validate both contradict. Use when the user says "audit the rules", "check outbound rules", "the post-fact validations show missing X but the message has it", "before we write outbound JSONata", or any time you're starting outbound work for a customer / partner / doc type that hasn't been validated end-to-end yet.
---

# Audit Outbound Rules

Orderful has a per-relationship rule engine that mutates outbound messages **between** the SuiteApp send and Orderful's partner-spec validation. The mutations are encoded as a function-call AST stored against `(ownerId, relationshipId, transactionTypeId, direction)`. The most common rule shape is a `whenThen` that applies `REMOVE` when an entry's variant key is not in a small whitelist — i.e. "drop entries that don't match this allowlist."

But whitelist+REMOVE is not the only shape. Rules can also **invert** values the SuiteApp already emitted correctly (reciprocal cross-assignments on sibling fields), **transform** values (substr, numeric ops), and **ADD** segments the SuiteApp never sent — or re-add ones the ECT JSONata deleted. A defect that looks like "the connector emitted the wrong structure" is frequently a rule inverting or re-materializing structure after the connector's output was correct. See ["Rule shapes beyond whitelist+REMOVE"](#rule-shapes-beyond-whitelistremove) below.

When the allowlist is narrower than the partner's published spec, those rules silently strip required segments. The resulting validation errors say things like "Loop with entityIdentifierCode SF is required" or "Segment with referenceIdentificationQualifier CN is required" — even though the NS-stored message clearly has those entries and `/v3/validate` accepts the same body without complaint.

This is the highest-leverage pre-flight check on any outbound onboarding. **Run it before you write JSONata.**

## When to use this skill

Trigger when the user says any of:
- "audit the rules" / "check outbound rules" / "audit /v2/rules"
- "before we start outbound JSONata for `<customer>`"
- "the validator is reporting a missing segment that the NS message has"
- "post-fact validations are wrong"
- "starting outbound work for `<customer>`/`<partner>`/`<docType>`"

Also trigger PROACTIVELY at the start of `writing-outbound-jsonata` for any customer where you haven't already audited rules.

## Inputs the skill needs

- The customer's Orderful `ownerId` (from `~/orderful-onboarding/<slug>/.env` as `ORDERFUL_ORG_ID`).
- The customer's `ORDERFUL_API_KEY`.
- The `transactionTypeId` for the doc type you're investigating (e.g., 12 for 856 in some accounts, 17 in others — these IDs are not stable across orgs; resolve by inspecting the rules' `transactionTypeId` field and matching to the relationship's `transactionType.name`).
- The partner relationship ID (from `/v3/relationships`) that names the counterparty + doc type you're working on.
- The local partner-guideline JSON pulled by `fetch-guidelines` (e.g., `out_856_SHIP_NOTICE_MANIFEST_<Partner>_<gsId>.json`). Without this, you can't compare the rule's allowlist against the spec.

## The recipe

### Step 1 — Pull and decode all rules for the relationship

```http
GET https://api.orderful.com/v2/rules
Headers: orderful-api-key: <ORDERFUL_API_KEY>
```

Filter to the customer + relationship + direction:

```js
all.filter(r =>
  r.ownerId === Number(orgId) &&
  r.relationshipId === <relId> &&
  r.direction === 'out'
)
```

Each rule has:
- `path` — the JSON path the rule applies to (e.g., `transactionSets.*.HL_loop.*.referenceInformation.*`)
- `liveExpression`, `testExpression` — function-AST objects (also accepted on PATCH as JSON strings; see Step 4)
- `transactionTypeId`, `relationshipId`, `direction`, `ownerId`

### Step 2 — Decode the function AST

The expressions are nested objects of the form `{type: "Function", value: {id: <fn>, arguments: [...]}}`. The function IDs observed in Orderful's rule engine (May 2026 base set, plus July 2026 additions 43 / 2 / 44):

| Function ID | Pseudo-name | Meaning |
|---|---|---|
| 38 | `whenThen` | If arg0 returns true, apply arg1 (or chain into a 3rd arg as else) |
| 41 | `NOT` | Negate the wrapped condition |
| 39 | `AND` | Combine multiple conditions |
| 22 | `eq` / equality | Test value equality |
| 55 | `isInArray` | True if `arg1` value is contained in `arg0` array |
| 57 | `REMOVE` | Delete this entry from the path-matched array (no args) |
| 58 | `pathSegments` | Build a nested path reference (used for variant-key lookups) |
| 43 | `const` / literal | Emit a constant / literal value. **Load-bearing for the value-swap and const-stamp patterns below** — both use `43` to source the assigned value (a literal, or a `pathSegments` reference wrapped as a const). |
| 2 | `substr` | Substring extract on a value |
| 44 | numeric transform | Numeric operation on a value (observed on a weight element; exact semantics unconfirmed) |

A canonical "remove entries not in whitelist" rule looks like:

```
whenThen(
  NOT(isInArray(["BM"], <ref to qualifier value>)),
  REMOVE()
)
```

Read literally: "if the qualifier value is NOT in the whitelist, remove this entry." Equivalent to `keep only entries with qualifier IN ['BM']`.

#### Rule shapes beyond whitelist+REMOVE

Not every rule strips. Two other families show up regularly, and both operate with a `const` (fn `43`) assignment rather than a `REMOVE`. Neither is visibly wrong when read one rule at a time — you have to scan the whole rule SET.

**Value-swap pattern** — a *pair* of rules that cross-assign sibling fields. Rule A sets `<field>.productServiceID = const(<ref: ...productServiceID1>)` and rule B sets `<field>.productServiceID1 = const(<ref: ...productServiceID>)`. Each rule copies one sibling's value into the other; run together, they invert two values the connector already emitted correctly (e.g. LIN buyer-item / vendor-item come out swapped). Teaching point: **a single swap rule looks benign in isolation** — an assignment from one field to another reads like a normal remap. The defect only exists because a *reciprocal* rule assigns the other direction on a sibling field. Always scan the full rule set for reciprocal assignments before clearing a swap-shaped rule as harmless.

**Unconditional const-stamp pattern** — an *unguarded* rule (no `whenThen`, no condition) that stamps a constant onto a fan-out path. Example: `itemIdentification.*.productServiceIDQualifier = const("SK")` on a path that fans out to EVERY HL level (S / O / P / I). Because it is unguarded and fans out, two things happen: (1) it materializes empty segment scaffolds — a qualifier present with no accompanying value — at HL levels that should carry no `itemIdentification` at all; and (2) it can RE-ADD fields the connector's ECT JSONata already deleted, because the rule runs *after* the JSONata. This is a common root cause of "empty LIN segments" and "spurious qualifier-only entries" reports: the connector's mapping is correct, but the unguarded stamp re-inflates structure downstream. When you see qualifier-only itemIdentification entries at S/O/P levels, look for an unguarded `const` stamp on a `*`-fanned path before touching the JSONata.

Both patterns are why editing the ECT JSONata can have **zero visible effect**: the rules post-process the connector's output regardless of what the mapping emitted (see ["Attribute the defect: connector vs. rules"](#attribute-the-defect-connector-vs-rules)).

A helper render function (paste into a Node script):

```js
function render(node, depth = 0) {
  if (!node) return 'null';
  if (node.type === 'Array') return `[${(node.value || []).map(v => JSON.stringify(v)).join(', ')}]`;
  if (node.type === 'Reference') return `<ref:${node.value}>`;
  if (node.type === 'String') return JSON.stringify(node.value);
  if (node.type === 'Function') {
    const fid = node.value?.id;
    const args = (node.value?.arguments || []).map(a => render(a, depth + 1));
    const fname = ({38: 'whenThen', 41: 'NOT', 55: 'isInArray', 57: 'REMOVE', 58: 'pathSegments', 22: 'eq', 39: 'AND', 43: 'const', 2: 'substr', 44: 'numTransform'})[fid] || `fn${fid}`;
    return `${fname}(${args.join(', ')})`;
  }
  return JSON.stringify(node);
}
```

### Step 3 — Cross-reference each rule's allowlist against the partner spec

For each rule that matches the "whitelist + REMOVE" pattern, extract the allowed values array and compare against the partner-guideline JSON:

1. **Identify the variant slot** the rule applies to. The rule's `path` (e.g., `HL_loop.*.referenceInformation.*`) plus the variant-key path (under `pathSegments` if present) tells you which `groupings` in the guideline the rule covers.
2. **List the partner-spec mandatory codes** at those groupings. In the guideline JSON, find rules where `path` ends in the variant key field (e.g., `referenceIdentificationQualifier`) and `parameters.codes` enumerates allowed values. The `use: "mandatory"` rules are the ones that will produce validation errors if their code is not present after rule application.
3. **Flag any whitelist narrower than the union of mandatory codes.** If the rule keeps `[BM]` but the spec mandates BM (slot 1-1) AND CN (slot 1-2), the rule strips CN at send time → the validator will report "CN required, missing".

Surface findings to the user in a tight table:

```
rel <relId>, <txTypeName>, direction=out
  rule <id>  path=<...>  allowlist=<as-decoded>  partner-spec mandatory=<set>  status=<OK | NARROWER>
```

### Step 4 — Optional: backup-and-PATCH the misconfigured rules

Only do this with explicit user approval — modifying a customer's rules is a write to shared config, hard to reverse from a script.

For each rule the user wants to fix:

```js
// 1. GET the rule for backup
const original = await fetch(`https://api.orderful.com/v2/rules/${id}`, { headers }).then(r => r.json());

// 2. Save backup to ~/orderful-onboarding/<slug>/rule-backups/<timestamp>-rule-<id>-original.json

// 3. Mutate the array values in liveExpression and testExpression
function mutateArray(node, newValues) {
  if (node?.type === 'Array' && Array.isArray(node.value)) { node.value = newValues; return true; }
  if (node?.type === 'Function' && Array.isArray(node.value?.arguments)) {
    for (const arg of node.value.arguments) if (mutateArray(arg, newValues)) return true;
  }
  return false;
}

// 4. PATCH with ONLY writable fields and EXPRESSIONS AS JSON STRINGS
//    (the API rejects nested objects for liveExpression/testExpression)
const patchBody = {
  ownerId: original.ownerId,
  relationshipId: original.relationshipId,
  transactionTypeId: original.transactionTypeId,
  direction: original.direction,
  path: original.path,
  liveExpression: JSON.stringify(mutated.liveExpression),
  testExpression: JSON.stringify(mutated.testExpression),
};
await fetch(`https://api.orderful.com/v2/rules/${id}`, {
  method: 'PATCH',
  headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify(patchBody),
});
```

The PATCH endpoint rejects: any of the server-managed fields (`id`, `source`, `createdAt`, `updatedAt`), AND nested-object expression bodies (the `liveExpression` and `testExpression` properties must be JSON-stringified).

### Step 5 — Verify and re-fire

After the PATCH:
1. GET the rule again, confirm the new allowlist values.
2. Re-fire the outbound transaction (if there's already a JSONata in place) and pull `/v2/organizations/<orgId>/transactions/<txId>/validations`. Errors that pointed at the previously-stripped variants should disappear.

## Attribute the defect: connector vs. rules

When an outbound payload arrives at the partner structurally wrong — inverted values, spurious empty segments, a field that shouldn't be there — the first question is *who did it*: the connector / ECT JSONata, or Orderful's rules. This recipe answers it deterministically instead of guessing. The technique is to reconstruct the connector's true output OFFLINE and diff it against what Orderful actually received.

1. **Pull the real inputs from NetSuite.** Get the stored inbound message from `custrecord_ord_tran_message` via SuiteQL (the originating 850, say), plus the real SO-line snapshot the connector mapped from — `custcol_orderful_line_ref` and `custcol_orderful_item_identification` on the transaction lines. These are the exact bytes the connector saw.
2. **Run the customer's ECT JSONata OFFLINE, on the SuiteApp's own engine version.** The SuiteApp evaluates with `jsonata@2.0.6`; use the *same* version so engine-version differences can't muddy the diff. It already lives in your local connector checkout's node_modules (e.g. `~/Code/netsuite-connector/node_modules/jsonata`) — require it from there (or pin `jsonata@2.0.6` in your harness). Reconstruct the `$defaultValues` envelope (`{sender, receiver, type, stream, message}`) and the input bindings the expression reads (`inboundOrderfulTransaction.message`, `itemFulfillments`, `salesOrders`, `customer`, etc.). Stub the runtime-only helpers (`$lookupSingleSuiteQL` / `$lookupMultiSuiteQL`) with hardcoded return values matching the real lookup rows. See [`samples/repro-ect-jsonata.mjs`](../../samples/repro-ect-jsonata.mjs) for a runnable harness and [`reference/outbound-jsonata.md`](../../reference/outbound-jsonata.md#local-testing-harness) for the envelope setup — don't restate it here.
3. **Diff the offline output against the Orderful-RECEIVED (post-rule) payload.** Fetch what Orderful actually stored/received (`GET /v3/transactions/{id}`), and compare it field-by-field against your offline result.
4. **The delta IS the rules.** If the offline output is correct but the received payload is wrong, the connector and ECT JSONata are *exonerated* — the mutation happened between send and receipt, which is the rule engine. The fix belongs on the Orderful rule side (see Steps 4–5 above), not in the JSONata.

### Critical corollary — the received payload is POST-rule and cannot prove connector behavior

The Orderful-received payload has already been through the rule engine, so it cannot be used to prove what the connector emitted. Fields that *look* like proof "the JSONata ran" may all be rule-set:

- BSN purpose / structure codes, FOB terms, carrier / SCAC routing, reference qualifiers — any of these can be stamped or rewritten by a rule.

The only reliable **in-payload** proof that the connector's mapping ran is a value the **native builder hardcodes differently** from any rule. Example: the native 856 builder emits BSN `hierarchicalStructureCode` as the literal `'0001'` — so any *other* value in the received payload came from the ECT override, and `'0001'` surviving proves the native path produced it. The other reliable proof is **out-of-band**: the connector's own audit log line `Overriding <docType> JSON message by JSONata`, which fires in the sending Suitelet/UE log when the ECT JSONata is applied. Trust those two; do not infer connector behavior from rule-settable fields in the received payload.

## Behaviour rules

1. **Always run audit BEFORE writing outbound JSONata.** It's the cheapest pre-flight available and prevents hours of debugging "missing segment" errors that NS-side messages contradict.
2. **Always backup before PATCH.** Save the full original rule JSON to `~/orderful-onboarding/<slug>/rule-backups/<timestamp>-rule-<id>-original.json`. Two copies of mistakes are recoverable; one copy is not.
3. **Get explicit user approval before PATCHing.** Modifying a rule is a write to shared customer config. Surface the proposed before/after diff and ask "go ahead?" — don't just push.
4. **Don't widen a whitelist beyond the partner's spec.** If the spec mandates `[BM, CN]`, set the whitelist to `[BM, CN]` (or `[BM, CN, LO]` if the spec also documents conditional values). Don't add codes the spec doesn't cover — those entries shouldn't be flowing in the first place.
5. **If you can't decode a rule cleanly, don't edit it.** If the rule's expression doesn't match the canonical "whitelist + REMOVE" pattern (e.g., it has multiple AND conditions, nested whenThens with HL-level gating, or function IDs you don't recognize), surface the rendered AST to the user and stop. Edits to non-canonical rules can break behavior in subtle ways.
6. **Prefer fixing the rule over working around it in JSONata.** A whitelist-too-narrow rule is a misconfiguration; the fix is a rule edit, not a JSONata workaround. Working around it in JSONata leaves the next contractor confused about why their JSONata is producing weird structures.
7. **Confirm the rule is actually the culprit before editing it — the guideline can strip the same field.** A rule's allow-array is NOT the partner spec; the guideline is (it allowlists the X12 conversion at a later stage than rules). Before you edit a rule to "allow" a qualifier, check the guideline's allowed values for that `dataPath` (`GET /v2/guideline-sets/{id}/guidelines?convertToOrderfulPath=true`). If the guideline doesn't allow the qualifier you're emitting, editing the rule changes nothing — the conversion strips it regardless. Diagnostic: if a rule edit has zero effect on the post-conversion `/message`, the gatekeeper is the guideline, not the rule. Real example: a shipment-level `REF` rule listed `2I`; emitting `REF*2I` and widening that array did nothing because the guideline only allowed `BM` — the rule was never the gate.

## Common gotchas

- **`/v3/validate` accepts the body but `/v2/.../validations` reports errors.** This is exactly the rules-stripping-fields pattern. `/v3/validate` runs PRE-rule; `/v2/validations` reports POST-rule. The disagreement is the diagnostic.
- **NS-stored message has the segments but Orderful's `/v3/transactions/{id}/message` doesn't.** Same pattern. The NS message field captures what the SuiteApp sent; the Orderful display endpoint shows the post-rule, post-normalize state.
- **`transactionTypeId` is not stable across orgs.** Resolve by reading the relationship's `transactionType.name` from `/v3/relationships`, not by hardcoding.
- **Rules are scoped by `relationshipId`, not by `partnerOrgId`.** A customer can have multiple relationships with the same partner across doc types; each has its own rule set.

## Reference material

- [`reference/outbound-jsonata.md`](../../reference/outbound-jsonata.md) — outbound JSONata patterns; rules-audit is Step 0 before writing JSONata
- [`samples/repro-ect-jsonata.mjs`](../../samples/repro-ect-jsonata.mjs) — offline ECT-JSONata repro harness for the connector-vs-rules attribution diff
- Partner guidelines pulled by [`fetch-guidelines`](../fetch-guidelines/SKILL.md) — needed to compare allowlists against partner-spec mandatory codes
- Orderful's `/v2/rules` API — undocumented publicly; the function-AST decoder above is observational, drawn from rules in the wild as of mid-2026
