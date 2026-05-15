---
name: audit-outbound-rules
description: Audit a customer's per-relationship outbound transformation rules at /v2/rules and flag any whitelist that's narrower than the partner's published spec. Run this BEFORE writing JSONata for a new outbound document type — misconfigured rules silently strip required EDI segments at send time, surfacing as "missing field" validation errors that NS-stored messages and /v3/validate both contradict. Use when the user says "audit the rules", "check outbound rules", "the post-fact validations show missing X but the message has it", "before we write outbound JSONata", or any time you're starting outbound work for a customer / partner / doc type that hasn't been validated end-to-end yet.
---

# Audit Outbound Rules

Orderful has a per-relationship rule engine that mutates outbound messages **between** the SuiteApp send and Orderful's partner-spec validation. The mutations are encoded as a function-call AST stored against `(ownerId, relationshipId, transactionTypeId, direction)`. The most common rule shape is a `whenThen` that applies `REMOVE` when an entry's variant key is not in a small whitelist — i.e. "drop entries that don't match this allowlist."

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

The expressions are nested objects of the form `{type: "Function", value: {id: <fn>, arguments: [...]}}`. The function IDs observed in Orderful's rule engine (May 2026):

| Function ID | Pseudo-name | Meaning |
|---|---|---|
| 38 | `whenThen` | If arg0 returns true, apply arg1 (or chain into a 3rd arg as else) |
| 41 | `NOT` | Negate the wrapped condition |
| 39 | `AND` | Combine multiple conditions |
| 22 | `eq` / equality | Test value equality |
| 55 | `isInArray` | True if `arg1` value is contained in `arg0` array |
| 57 | `REMOVE` | Delete this entry from the path-matched array (no args) |
| 58 | `pathSegments` | Build a nested path reference (used for variant-key lookups) |

A canonical "remove entries not in whitelist" rule looks like:

```
whenThen(
  NOT(isInArray(["BM"], <ref to qualifier value>)),
  REMOVE()
)
```

Read literally: "if the qualifier value is NOT in the whitelist, remove this entry." Equivalent to `keep only entries with qualifier IN ['BM']`.

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
    const fname = ({38: 'whenThen', 41: 'NOT', 55: 'isInArray', 57: 'REMOVE', 58: 'pathSegments', 22: 'eq', 39: 'AND'})[fid] || `fn${fid}`;
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

## Behaviour rules

1. **Always run audit BEFORE writing outbound JSONata.** It's the cheapest pre-flight available and prevents hours of debugging "missing segment" errors that NS-side messages contradict.
2. **Always backup before PATCH.** Save the full original rule JSON to `~/orderful-onboarding/<slug>/rule-backups/<timestamp>-rule-<id>-original.json`. Two copies of mistakes are recoverable; one copy is not.
3. **Get explicit user approval before PATCHing.** Modifying a rule is a write to shared customer config. Surface the proposed before/after diff and ask "go ahead?" — don't just push.
4. **Don't widen a whitelist beyond the partner's spec.** If the spec mandates `[BM, CN]`, set the whitelist to `[BM, CN]` (or `[BM, CN, LO]` if the spec also documents conditional values). Don't add codes the spec doesn't cover — those entries shouldn't be flowing in the first place.
5. **If you can't decode a rule cleanly, don't edit it.** If the rule's expression doesn't match the canonical "whitelist + REMOVE" pattern (e.g., it has multiple AND conditions, nested whenThens with HL-level gating, or function IDs you don't recognize), surface the rendered AST to the user and stop. Edits to non-canonical rules can break behavior in subtle ways.
6. **Prefer fixing the rule over working around it in JSONata.** A whitelist-too-narrow rule is a misconfiguration; the fix is a rule edit, not a JSONata workaround. Working around it in JSONata leaves the next contractor confused about why their JSONata is producing weird structures.

## Common gotchas

- **`/v3/validate` accepts the body but `/v2/.../validations` reports errors.** This is exactly the rules-stripping-fields pattern. `/v3/validate` runs PRE-rule; `/v2/validations` reports POST-rule. The disagreement is the diagnostic.
- **NS-stored message has the segments but Orderful's `/v3/transactions/{id}/message` doesn't.** Same pattern. The NS message field captures what the SuiteApp sent; the Orderful display endpoint shows the post-rule, post-normalize state.
- **`transactionTypeId` is not stable across orgs.** Resolve by reading the relationship's `transactionType.name` from `/v3/relationships`, not by hardcoding.
- **Rules are scoped by `relationshipId`, not by `partnerOrgId`.** A customer can have multiple relationships with the same partner across doc types; each has its own rule set.

## Reference material

- [`reference/outbound-jsonata.md`](../../reference/outbound-jsonata.md) — outbound JSONata patterns; rules-audit is Step 0 before writing JSONata
- Partner guidelines pulled by [`fetch-guidelines`](../fetch-guidelines/SKILL.md) — needed to compare allowlists against partner-spec mandatory codes
- Orderful's `/v2/rules` API — undocumented publicly; the function-AST decoder above is observational, drawn from rules in the wild as of mid-2026
