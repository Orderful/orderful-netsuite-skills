---
name: writing-outbound-jsonata
description: Author and iterate JSONata expressions that fix outbound EDI message validation errors for a specific customer × document type. Combines NetSuite SuiteQL lookups, the Orderful SuiteApp's JSONata engine, and tight reprocess loops. Use when the user says "write JSONata for the X transaction", "fix this 856/810/855", "the partner is rejecting on validation", "help me iterate on advanced mapping", or "the SF segment is wrong on the outbound 856".
---

# Writing Outbound JSONata

JSONata is the SuiteApp's escape hatch for customer-specific outbound message overrides — when the default mapper doesn't satisfy a partner's spec, you author a JSONata expression on the customer's EDI Enabled Transaction Type record (the "Advanced mapping" field) that transforms the default JSON message into a valid one. (The schema in play here is Orderful's JSON form of EDI X12 — *not* Mosaic, which is a separate, newer, simplified schema for common transaction types.)

This skill is the procedure for doing that authoring loop in a way that doesn't waste hours on schema rejection mysteries.

## When to use this skill

Use when the user says any of:

- "write JSONata for the 856/810/855 for customer X"
- "the partner rejected this with `validationStatus: INVALID`"
- "help me fix the Ship From / N1 / TD1 / LIN segment on this outbound transaction"
- "this 856 keeps failing validation, can you iterate on the mapping?"
- "I need to add custom advanced mapping for `<customer>`"
- "can JSONata access `<some NetSuite field>` on the IF / SO / customer?"

Do NOT load this skill for:

- **Inbound** transaction failures (item lookups, ITEM_LOOKUP_MISSING) — that's [`item-lookup`](../item-lookup/SKILL.md).
- Customer enablement / configuration setup — that's [`enable-customer`](../enable-customer/SKILL.md).
- Cases where the fix is a NetSuite data fix (e.g., a missing Location on the IF) rather than a mapping fix. Always raise that option first; JSONata is a band-aid for schema/spec divergence, not for missing source data.

## Prerequisites

The customer must already be enabled for the document type with an EDI Enabled Customer Transaction (ECT) record (`customrecord_orderful_edi_customer_trans`). If the row doesn't exist yet, route to [`enable-customer`](../enable-customer/SKILL.md) first — without an ECT row there's no record to attach JSONata to.

The user must have run [`netsuite-setup`](../netsuite-setup/SKILL.md) for the customer (TBA credentials in `~/orderful-onboarding/<customer-slug>/.env`) so SuiteQL probes work.

## Inputs the skill needs

Before iterating, get clarity on:

1. **The failing transaction.** Either the NS internal id of the `customrecord_orderful_transaction` row OR the Orderful transaction id. We need both sides to compare what was sent vs. what was rejected.
2. **The trading partner's validation errors.** Orderful's `/v3/transactions/{id}/validation-errors` endpoint returns 404 — the API does not expose per-error details. Get the user to **screenshot the Errors tab from the Orderful UI** for that transaction, OR list the errors verbatim. Without this, you're guessing structurally.
3. **The customer × document-type ECT record id.** Query (substitute the customer NS id and document-type display name):
   ```sql
   SELECT id, custrecord_edi_enab_jsonata,
          BUILTIN.DF(custrecord_edi_enab_trans_jsonata_ver) AS ver
   FROM customrecord_orderful_edi_customer_trans
   WHERE custrecord_edi_enab_trans_customer = <customer_id>
     AND BUILTIN.DF(custrecord_edi_enab_trans_document_type) = '<doc-type>'
   ```
4. **Confirm reprocess strategy.** Most outbound flows reprocess by setting `custbody_orderful_ready_to_process_ful = true` on the source IF (or the equivalent flag for other doc types — see Step 6). Confirm the user is OK with us flipping that flag, since it triggers a real send to the partner sandbox.

## The recipe

### Step 0 — Audit the customer's outbound transformation rules first

Before writing or iterating any JSONata, run [`audit-outbound-rules`](../audit-outbound-rules/SKILL.md) for the customer × document type. Per-relationship rules at `/v2/rules` can silently strip required EDI segments AFTER the SuiteApp sends — surfacing as "missing field" validation errors that NS-stored messages and `/v3/validate` both contradict. If a rule's whitelist is narrower than the partner's spec, fixing the rule is the cleaner answer than working around it in JSONata. Skipping this step is the most common source of "I'm sure I sent the right segment, why does the validator say it's missing" mysteries.

### Step 1 — Capture the default-mapper output

Read the failing transaction's saved message from NetSuite (NOT from Orderful's `/message` endpoint — that endpoint **strips fields** during display normalization and is misleading). The NS-side message is the truth:

```sql
SELECT custrecord_ord_tran_message
FROM customrecord_orderful_transaction
WHERE id = <ns_tran_id>
```

The result is a JSON string with this shape:

```json
{
  "sender":   { "isaId": "..." },
  "receiver": { "isaId": "..." },
  "type":     { "name": "856_SHIP_NOTICE_MANIFEST" },
  "stream":   "TEST",
  "message":  { "transactionSets": [ ... ] }
}
```

**Critical**: the actual EDI segments live nested under `message`. The wrapper (`sender`/`receiver`/`type`/`stream`) is part of `$defaultValues` inside JSONata. Orderful's `/v3/transactions/{id}/message` REST endpoint hides this wrapper — paths from the Orderful UI's Rules Editor are *not* the same paths JSONata uses. **Always prepend `message.`** when writing transform paths.

### Step 2 — Map each validation error to a JSON path

For each error in the partner's Errors tab:
- Identify the X12 element (e.g. LIN02, N102, BSN05, TD101)
- Find where the SuiteApp emits it in `message.transactionSets[0]…` — open the saved message and locate the path
- Note whether the field is missing entirely, is the wrong value, or has the wrong field name (Orderful's JSON field names and X12 element names don't always align)

Common gotchas (real ones from production):

| Error class | Where to look |
|---|---|
| `<x>` is not a valid input → only X/Y/Z allowed | The SuiteApp's default value for that element doesn't satisfy the partner's restricted code list. Override to a valid value. |
| Element is mandatory | The SuiteApp leaves it null/absent. Set it from a custom field, a SuiteQL lookup, or a hardcoded value. |
| `must NOT have additional properties - <field>` | This is *Orderful's* schema rejecting the payload before sending. The field name is wrong — find the right Orderful JSON field name in the existing message structure (e.g. `unitOrBasisForMeasurementCode`, not `unitOfMeasureCode`). |
| Validation error nests under a different path than expected | The Orderful UI's Rules Editor shows the *normalized* path. JSONata's path is one level deeper — look at the actual NS-saved message to find the real nesting. Example: `purchaseOrderTypeCode` lives on `HL_loop[<O>].purchaseOrderReference[0]`, NOT on `beginningSegmentForShipNotice[0]`. |

### Step 3 — Write the JSONata transform

Skeleton — see [`reference/outbound-jsonata.md`](../../reference/outbound-jsonata.md) for the full library of patterns:

```jsonata
(
  /* SECTION 1 — bind data via lookups */
  $ifId := $string(itemFulfillments[0].id);
  $someValue := itemFulfillments[0].custbody_<your_field>;

  /* lookupSingleSuiteQL: max 3 JOINs, TOP 1 stays as TOP 1 */
  $someRow := $lookupSingleSuiteQL(
    "SELECT TOP 1 col1, col2 FROM <table> WHERE id = " & $ifId
  );

  /* SECTION 2 — chained transforms on $defaultValues */
  $defaultValues
    ~> | message.transactionSets[0].HL_loop[0].<segment> |
       { "<field>": $someValue, "<otherField>": $someRow.col1 } |
)
```

Key behaviors:

- **`~> | path | replacement |`** does a *shallow merge* of the replacement object into the value at path. Top-level keys you set replace those at target; keys you don't mention are preserved.
- **Inside the replacement, the context is the LOCATED value, not the root.** You CANNOT reference `itemFulfillments[0]` inside the replacement object directly — it won't resolve. Bind root data to `$vars` in Section 1 first, then reference the `$vars` inside the transform.
- **Undefined values cause keys to be omitted.** If `$someValue` is null, the key is dropped from the result entirely (this can be a feature OR a footgun depending on whether the partner requires the field).
- **Path expressions can fan out across arrays.** `message.transactionSets[0].HL_loop.itemIdentification[0]` matches every HL entry that has `itemIdentification` (only I-level entries do) and applies the transform to each.

### Step 4 — Test the JSONata locally before pushing

Install the `jsonata` npm package locally, build a test harness that loads the actual NS-saved message as the wrapped envelope, and apply the expression. This is dramatically faster than iterating against NetSuite — local roundtrip is milliseconds vs. ~30 seconds per NetSuite reprocess.

```js
import jsonata from 'jsonata';

// Reconstruct the wrapped shape JSONata sees in NS:
const defaultValues = {
  sender:   { isaId: '<sender-isa-id>' },
  receiver: { isaId: '<receiver-isa-id>' },
  type:     { name: '856_SHIP_NOTICE_MANIFEST' },
  stream:   'TEST',
  message:  /* ...the inner message JSON from NS-saved field... */,
};

// Stand-in for the runtime input — minimal fields the expression references:
const input = {
  itemFulfillments: [{ id: 1234567, custbody_<field>: '...' }],
  customer: { id: 1234567, companyName: 'Acme Foods' },
  salesOrders: [],
  invoices: [],
};

const expression = jsonata(JSONATA_EXPR);
const result = await expression.evaluate(input, { defaultValues });
console.log(JSON.stringify(result.message.transactionSets[0]..., null, 2));
```

`$lookupSingleSuiteQL` won't be available in the local harness (it's runtime-only), so for transforms that depend on lookups, mock the resulting `$var` with a hardcoded value during local testing, then swap back to the lookup before pushing.

### Step 5 — Push to NetSuite

PATCH the ECT record with the expression and version V2:

```http
PATCH /services/rest/record/v1/customrecord_orderful_edi_customer_trans/<ect_id>
Content-Type: application/json

{
  "custrecord_edi_enab_jsonata": "<the expression>",
  "custrecord_edi_enab_trans_jsonata_ver": { "id": "2" }
}
```

V2 is required for the `~> | path | update |` transform syntax. If the version field is empty or set to V1, transforms may evaluate but not apply correctly.

### Step 6 — Reprocess and verify

For outbound 856, flip the run-control flag on the source IF:

```http
PATCH /services/rest/record/v1/itemfulfillment/<if_id>
Content-Type: application/json

{ "custbody_orderful_ready_to_process_ful": true }
```

The SuiteApp's MapReduce picks this up within seconds and creates a new `customrecord_orderful_transaction` row. Poll for the new transaction (NS internal id auto-numbers are NOT strictly increasing across the table — track by `MAX(id)` taken before the trigger, OR by the Orderful transaction id which IS chronological):

```sql
SELECT t.id, BUILTIN.DF(t.custrecord_ord_tran_status) AS status,
       t.custrecord_ord_tran_orderful_id AS orderful_id,
       t.custrecord_ord_tran_error AS error
FROM customrecord_orderful_transaction t
WHERE BUILTIN.DF(t.custrecord_ord_tran_document) = '<doc-type-display>'
  AND t.id > <max_id_before_trigger>
ORDER BY t.id DESC
```

Then check Orderful's side:

```http
GET https://api.orderful.com/v3/transactions/<orderful_id>
Headers: orderful-api-key: ${ORDERFUL_API_KEY}
```

Look for `validationStatus: VALID`. If still `INVALID`, get the next round of errors from the partner UI and loop back to Step 2.

For other doc types, the run-control flag varies — see the IF/SO/Invoice custom body fields for `custbody_orderful_ready_to_process_*`. For 855, the trigger is typically saving the SO with the right status. For 810, it's typically saving the Invoice.

### Step 7 — Hand off

Once VALID, summarize for the user:

- The final JSONata expression (with comments — see the worked example in [`reference/outbound-jsonata.md`](../../reference/outbound-jsonata.md))
- Which fields are sourced dynamically vs. hardcoded
- Any partner-specific assumptions worth flagging to the customer-side stakeholder for review (e.g. "we assumed all orders to this partner are drop-ship — confirm this won't ever be a warehouse-routed PO")

## Behaviour rules

1. **Always offer the data-fix path before the JSONata path.** If the source data on the IF / SO / Customer is wrong (missing Location, wrong subsidiary, missing carton weights), fixing that is structurally cleaner than masking with JSONata. Only proceed with JSONata when the data is correct AND the partner spec diverges from the SuiteApp's default mapping.
2. **Never push JSONata without seeing the partner's actual validation errors.** Schema-level guesses based on message inspection often miss the real rule the partner is enforcing. Insist on the Errors tab screenshot or a verbatim list.
3. **Do not trust Orderful's `/v3/transactions/{id}/message` endpoint as WYSIWYG.** It strips fields during display normalization (e.g. nullable `identificationCodeQualifier` / `identificationCode` on N1 partyIdentification, `weightQualifier` on TD1). Always read `custrecord_ord_tran_message` from NetSuite directly to confirm what was actually sent.
4. **Always include the `message.` prefix in transform paths.** `$defaultValues` is the wrapped envelope. Forgetting this is the #1 cause of "JSONata didn't seem to do anything" — the path matches nothing, the transform is a no-op, and the message goes out unchanged.
5. **Bind root-context values to `$vars` before transforms.** Inside a `~> | path | update |` block, the update's evaluation context is the located value, not the input root. `itemFulfillments[0]` inside the replacement object will return null. Always do `$something := itemFulfillments[0].field` in Section 1 first.
6. **Test locally with the `jsonata` package before each NetSuite reprocess.** A local iteration is sub-second; a NS reprocess loop is ~30 seconds plus governance impact. Don't burn the user's time and unit usage on syntax errors that locally would have surfaced immediately.
7. **Reject ambiguous partner specs.** If the user can't produce specific allowed values for a code (e.g. "the partner requires `purchaseOrderTypeCode` but I don't know what value to use"), do NOT pick a plausible-sounding code and ship it. Push back on the user to get the partner's spec doc, or escalate to the customer-side stakeholder.
8. **Document hardcoded values explicitly.** Anything in the JSONata that isn't sourced from data should have a comment naming the assumption (e.g. `/* DS = drop ship; KN if shipping to partner warehouse */`). Future maintainers need to know what to revisit when the relationship evolves.
9. **One PR per fix.** If the partner has 6 validation errors, address them iteratively in the same JSONata expression — but if the user wants to also fix an unrelated mapping issue (a different doc type, a different customer), that's a separate session and a separate ECT record.
10. **Never set `custrecord_edi_enab_trans_jsonata_ver` to V1 for new work.** V1 is legacy syntax with limited transform support. V2 is the supported form for everything in this skill.
11. **Watch for schema gaps that JSONata can't fix.** If Orderful's outbound schema for the document type doesn't expose a field the partner requires (e.g. some BSN sub-elements), JSONata cannot inject it — Orderful's schema validator rejects unknown properties. Surface this to the user as a feature request to Orderful, not a JSONata problem.
12. **Mock empty/missing source data in NetSuite, never inline literals into JSONata.** If a field is empty, zero, or null in the source record (IF / SO / Customer / Item) during testing, fix it at the data source — patch the NS record, populate a custom record, add a dataset row, set a per-line column. Do NOT bake fallbacks like `$weight ? $weight : "12500"` or hardcoded SSCCs like `"00100000000000000019"` into the expression. The only literals JSONata should contain are partner-spec constants (qualifiers like `BM`/`CN`/`SF`, type codes like `SA`/`KN`, weight UOM `LB`) — values that don't depend on per-record data. A hardcoded data mock either ships to prod (worst outcome — fake values flowing on real EDI) or has to be remembered and stripped later (second-worst — easy to miss in JSONata diffs). Mocking belongs in the system that holds the data, where it's visible to anyone reading the record.

## Common gotchas

- **Reprocess fired but nothing new appears.** The `customrecord_orderful_transaction` table's `id` column does NOT auto-number monotonically across the whole table — different sessions allocate from different ranges. Filter by `created` timestamp or by `custrecord_ord_tran_orderful_id` (Orderful's id IS chronological) instead of `id`.
- **`Field 'subsidiary' for record 'transaction' was not found. Reason: NOT_EXPOSED`.** Header-level `transaction.subsidiary` is not exposed for SuiteQL search. Use `transactionline.subsidiary` instead — it's exposed.
- **`Search error occurred: Invalid or unsupported search`.** Often means a JOIN your query is making isn't traversable in SuiteQL (e.g. some `location.subsidiary` paths). Reduce join count or rewrite via the line table.
- **`lookupSuiteQL error: Only up to 3 joins are supported`.** Hard cap. Either denormalize the query (fewer joins) or break into two `$lookupSingleSuiteQL` calls and combine in JSONata.
- **`lookupSuiteQL error: Query results exceeded 1 record`.** The wrapper rewrites your `SELECT` to `SELECT TOP 2` (unless you wrote `TOP 1` explicitly). If 2 rows return, it errors. Add `TOP 1` and an `ORDER BY` to make the query deterministic. Use `$lookupMultiSuiteQL` for legitimate multi-row needs.
- **JSONata evaluated but nothing changed.** Check the version field — if it's null or `V1`, transform syntax may not apply. Set to `V2`. Also check the path includes `message.` — paths copied from the Orderful UI's Rules Editor will not work as-is.
- **The transform applied but Orderful's display doesn't show the field.** Compare against the NS-saved message (`custrecord_ord_tran_message`) — Orderful strips display-only nulls and certain fields it deems redundant. The data was sent; Orderful is just hiding it on the way back.
- **The SuiteApp errored before JSONata ran with "None of the following item fulfillments have cartons".** This is a pre-JSONata check in the 856 generator. Cartons must come from either `customrecord_orderful_carton` OR a configured analytics dataset. If the user changed their packing setup, verify the dataset still returns cartons for the IF in question.
- **Lambda body syntax error: `Expected "}", got ";"`.** JSONata function bodies must be a single expression. Multiple `$x := ...; $y := ...; ...` bindings inside a `function($arg) { ... }` body raise this error. Wrap the body in a parenthesized expression block: `function($arg) {( $x := ...; $y := ...; result )}`. Common when factoring helper functions out of larger transforms.
- **Path-update operator returns an object instead of an array.** `arr ~> $map(fn)` and `$merge` over a single-element array can collapse the result to a plain object — JSONata's "single-value vs array" coercion. If your transform produces `"carrierDetails": {…}` where the schema expects `"carrierDetails": [{…}]`, the validator will reject it. Two fixes: prefer the path-update operator (`~> | path | obj |`) which preserves the array shape via shallow merge, or wrap your `$map` result in `[…]` to force array preservation.
- **Customer body field is null on EDI-context creates because a UE/Client script is form-gated to UI saves.** Common pattern: a body field like `custbody_*_total_weight` is calculated by a User Event script that only runs on specific customforms / via UI submit, so server-side `record.create` from the SuiteApp leaves it empty. JSONata workaround: coalesce the IF's empty value to the parent SO via `transactionline.createdfrom` subquery: `COALESCE(NULLIF(t.<field>, 0), so.<field>)` where `so.id = (SELECT MAX(tl.createdfrom) FROM transactionline tl WHERE tl.transaction = t.id)`. Header-level `transaction.createdfrom` is not exposed to SuiteQL; the line-level `transactionline.createdfrom` IS exposed and gives you the IF→SO link. Long-term fix is in the customer's UE script (extend the form gate) or a server-side mirror.
- **NSAD formula columns can't reference other formula columns.** When building dataset formulas (e.g., a Mod-10 check digit on an SSCC), you can't define a `Base17` formula column and reference `{Base17}` from a downstream `CheckDigit` formula. Inline the full expression in the single column that the SuiteApp will read. Optimization: precompute the fixed-prefix portion of the weighted sum manually (e.g., for a fixed GS1 company prefix, compute the constant contribution once and only iterate digits over the variable serial portion). For a 17-digit base with an 11-character fixed prefix and a 6-digit variable serial, this drops the SUBSTR count from 17 to 6.

## Reference material

- [`reference/outbound-jsonata.md`](../../reference/outbound-jsonata.md) — full reference: input/context variables, the wrapped-envelope pattern, transform operator semantics, registered SuiteQL functions, common Orderful JSON field names, schema gotchas, and an annotated worked-example expression covering N1 / TD1 / TD5 / REF / LIN.
- [`reference/record-types.md`](../../reference/record-types.md) — schema for `customrecord_orderful_edi_customer_trans` (where the JSONata field lives), `customrecord_orderful_transaction` (the saved-message field), and related records.
