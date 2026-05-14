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
2. **The trading partner's validation errors.** Don't guess structurally. Pull them with [`fetch-validations`](../fetch-validations/SKILL.md) — `GET /v2/organizations/{orgId}/transactions/{txId}/validations` returns a structured list of `dataPath` / `message` / `allowedValues` triples. The endpoint accepts the public `orderful-api-key` (no UI JWT required, despite older notes). When you also need to know what the partner's guideline strips vs. requires (the "why" behind a validation error), pull `GET /v2/guideline-sets/{id}/guidelines?convertToOrderfulPath=true` — paths there match the validation `dataPath` shape. The Errors tab in the Orderful UI is a fallback, not the primary input.
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
| Same segment, different schema at different HL levels | Some partners encode different rules for the *same* segment depending on which HL it's in. Sally's 856 TD5 is the canonical example: at the Shipment HL it expects TD502/TD503/TD505 (SCAC qualifier + code + carrier routing); at the Order HL it expects only TD506 (`shipmentOrderStatusCode: "CL"` or `"PR"` — order completion). Putting Shipment-shaped TD5 at the Order HL fires "Segment is mandatory" because the actual required field (TD506) is missing. Always check whether per-HL rule variants exist before assuming the segment shape is uniform. |
| Empty arrays trigger rejection at strict validators | The SuiteApp emits some optional segments as `[]` empty arrays (e.g. `referenceInformation: []` at Pack HL, `N1_loop: []` at 856 Order HL, `SAC_loop: []` on 810 when no discount). Strict schemas (Ulta in particular) reject empty array keys as malformed. Either drop the key entirely (`~> | path | {}, ['emptyKey'] |`) or populate it with a valid entry. |
| Mosaic JSON field naming for repeated UOM elements | Composite segments with multiple "Unit Or Basis for Measurement Code" elements (PAL, TD1) follow occurrence-order numbering. For PAL: `unitOrBasisForMeasurementCode` (no suffix) = PAL06 / unit weight UOM (often unused); `unitOrBasisForMeasurementCode1` = PAL10 / UOM for L/W/H (required when length is present); `unitOrBasisForMeasurementCode2` = PAL12 / UOM for grossWeightPerPack. The numbering counts occurrences, not positions — verify against the live message before authoring. |

### Step 2.5 — Know what's in your input context (per document type)

The JSONata input root is not the same across document types. Confirmed shapes:

- **Outbound 855** (from SO): `salesOrders[]` populated with the source SO and its line items; `customer` populated; `itemFulfillments[]` and `invoices[]` empty.
- **Outbound 856** (from IF): `itemFulfillments[]` populated; `customer` populated; **`salesOrders[]` is empty** even though the IF was created from an SO. (This is a SuiteApp gap — see NS-942 in the product backlog.) `itemFulfillments[0].salesOrderId` is *also* not exposed despite being on the IF model — see NS-943.
- **Outbound 810** (from Invoice): `invoices[]` populated; `customer` populated; `salesOrders[]` and `itemFulfillments[]` empty.

When the document type is 856 and you need SO custbody fields (e.g. `custbody_orderful_edi_po_date`, `custbody_orderful_latest_delivery`), the workaround is `$lookupSingleSuiteQL` joining `transactionline.createdfrom` (with `mainline = 'T'`):

```jsonata
$ifId := $string(itemFulfillments[0].id);
$soRow := $lookupSingleSuiteQL(
  "SELECT t.custbody_orderful_edi_po_date AS po_date "
  & "FROM transactionline tl "
  & "INNER JOIN transaction t ON tl.createdfrom = t.id "
  & "WHERE tl.transaction = " & $ifId & " AND tl.mainline = 'T'"
);
$poDateStr := $soRow.po_date;
```

**Important**: `createdfrom` is a column on `transactionline` (with `mainline = 'T'` to get the header line), NOT on `transaction`. Trying `SELECT createdfrom FROM transaction` errors with "Field 'createdfrom' for record 'transaction' was not found". This wastes 30+ minutes the first time you hit it.

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
9. **Don't hardcode value fallbacks for partner-specific data.** It's tempting to write `$carrier := $cInfo.carrier ? $cInfo.carrier : "USPS"` so JSONata always emits *something*. Don't. Real missing data should produce a missing field, which Orderful's validator catches loudly — that's how you discover unconfigured shipping mappings, missing warehouse codes, or unmapped ship methods. A silent fallback ships garbage to the partner and removes your only signal that something's wrong. **Qualifiers** (the spec-defined enum codes — `CN`, `GM`, `ZZ`, `SK`, `ST`, `SF`, etc.) are constants and *can* be hardcoded — they're enum values, not customer data. **Qualifier values** (the SCAC, service-level code, warehouse code, address country, tracking number, anything that varies per customer or per shipment) must come from a real record. If the source isn't there, fix the source — don't paper over it with a default.
10. **Prefer SuiteApp-managed lookup records over inline JSONata maps.** If you find yourself writing `$lookup({"130": {"carrier": "USPS"}, "131": {...}}, $shipMethodId)` in the JSONata, stop and check whether the SuiteApp already has a record type for that mapping. For carrier and service-level codes specifically, `customrecord_orderful_shipping_service` ("EDI Shipping Lookup") is the home — the SuiteApp's `generateShipmentHL` queries it via `shippingLookupRepository.queryShipmentLookupByShipItem(shipMethod)` and populates TD503 (SCAC) and TD508 (service level) into `$defaultValues.message.transactionSets[0].HL_loop[…].carrierDetailsRoutingSequenceTransitTime[0]` *before* JSONata runs. Schema: Ship Item (FK to NS shipping item), Carrier (FK), SCAC Code (text), Customer (FK, optional scoping), Service Level (text). **Caveat — the lookup populates *values*, not *shape*.** If the partner's segment requires non-standard qualifiers (e.g. `routingSequenceCode=Z` + `identificationCodeQualifier=ZZ` + `locationQualifier`/`locationIdentifier` instead of `serviceLevelCode`), the JSONata still has to rebuild the segment in the partner's shape — read the values out of `$defaultValues...carrierDetailsRoutingSequenceTransitTime[0]` and slot them in. The "lookup record means no JSONata" assumption breaks for any partner whose segment shape diverges from the standard SuiteApp output. Same pattern applies to other lookup-heavy mappings — check the SuiteApp's source for an existing record type before reinventing in JSONata.
11. **One PR per fix.** If the partner has 6 validation errors, address them iteratively in the same JSONata expression — but if the user wants to also fix an unrelated mapping issue (a different doc type, a different customer), that's a separate session and a separate ECT record.
12. **Never set `custrecord_edi_enab_trans_jsonata_ver` to V1 for new work.** V1 is legacy syntax with limited transform support. V2 is the supported form for everything in this skill.
13. **Watch for schema gaps that JSONata can't fix.** If Orderful's outbound schema for the document type doesn't expose a field the partner requires (e.g. some BSN sub-elements), JSONata cannot inject it — Orderful's schema validator rejects unknown properties. Surface this to the user as a feature request to Orderful, not a JSONata problem.

## Common gotchas

- **Reprocess fired but nothing new appears.** The `customrecord_orderful_transaction` table's `id` column does NOT auto-number monotonically across the whole table — different sessions allocate from different ranges. Filter by `created` timestamp or by `custrecord_ord_tran_orderful_id` (Orderful's id IS chronological) instead of `id`.
- **`Field 'subsidiary' for record 'transaction' was not found. Reason: NOT_EXPOSED`.** Header-level `transaction.subsidiary` is not exposed for SuiteQL search. Use `transactionline.subsidiary` instead — it's exposed.
- **`Search error occurred: Invalid or unsupported search`.** Often means a JOIN your query is making isn't traversable in SuiteQL (e.g. some `location.subsidiary` paths). Reduce join count or rewrite via the line table.
- **`lookupSuiteQL error: Only up to 3 joins are supported`.** Hard cap. Either denormalize the query (fewer joins) or break into two `$lookupSingleSuiteQL` calls and combine in JSONata.
- **`lookupSuiteQL error: Query results exceeded 1 record`.** The wrapper rewrites your `SELECT` to `SELECT TOP 2` (unless you wrote `TOP 1` explicitly). If 2 rows return, it errors. Add `TOP 1` and an `ORDER BY` to make the query deterministic. Use `$lookupMultiSuiteQL` for legitimate multi-row needs.
- **JSONata evaluated but nothing changed.** Check the version field — if it's null or `V1`, transform syntax may not apply. Set to `V2`. Also check the path includes `message.` — paths copied from the Orderful UI's Rules Editor will not work as-is.
- **The transform applied but Orderful's display doesn't show the field.** Compare against the NS-saved message (`custrecord_ord_tran_message`) — Orderful strips display-only nulls and certain fields it deems redundant. The data was sent; Orderful is just hiding it on the way back.
- **The SuiteApp errored before JSONata ran with "None of the following item fulfillments have cartons".** This is a pre-JSONata check in the 856 generator. Cartons must come from either `customrecord_orderful_carton` OR a configured analytics dataset. If the user changed their packing setup, verify the dataset still returns cartons for the IF in question.
- **`Cannot parse payload. Reason: <path>: must be array`.** A single-match predicate flattens to a scalar — `$x := $defaultValues...N1_loop[partyIdentification[0].entityIdentifierCode = "ST"]` returns an object (not a 1-element array) when exactly one entry matches the filter. If you then assign `$x` back to a list-typed path (e.g. `"N1_loop": $x`), Orderful's schema parser rejects the whole payload before validation runs. Wrap with `$append([], ...)` to force array semantics: `$x := $append([], $defaultValues...N1_loop[partyIdentification[0].entityIdentifierCode = "ST"])`. Same trick works for empty results — `$append([], <0-match predicate>)` yields `[]` instead of `undefined`. Hits any time you keep a subset of a multi-entry default and the subset narrows to 0 or 1 entries.
- **Tracking number isn't a single-table column.** `transaction.trackingnumberlist` looks like a tracking number field but is actually a sublist anchor (an internal id pointing into the tracking-number sublist). The real path for a SuiteQL lookup is: `trackingNumberMap.transaction = <ifId>` → `trackingNumberMap.trackingnumber` (FK) → `trackingNumber.id` → `trackingNumber.trackingnumber` (the actual string). Worked example: `SELECT TOP 1 tn.trackingnumber FROM trackingNumberMap m JOIN trackingNumber tn ON tn.id = m.trackingnumber WHERE m.transaction = <ifId>`.
- **Not every IF custbody field is SuiteQL-queryable.** Some are exposed (e.g., `custbody_shiphawk_shipping_cost`, `custbody_sps_package_data_source`); others (e.g., `custbody_if_otherrefnum`) are NOT — depends on the field's "Show in List" / searchable settings. The IF data passed into JSONata via `itemFulfillments[0]` mirrors what `selectAll()` from `transaction` returns, so anything not SuiteQL-queryable is also not in the JSONata input. When designing JSONata that reads from the IF, verify the field is queryable (`SELECT custbody_x FROM transaction WHERE id = <ifId>`) before relying on it. If not, fall back to standard NS columns (`otherrefnum`, `tranid`, `shipmethod`, etc.) or set the value on a known-queryable field via a UE script.
- **The partner's guideline acts as an allowlist on the X12 output, not just a validator.** A field present in `$defaultValues` but missing from the X12 isn't a bug — the partner's guideline decides what reaches the output via two mechanisms: (a) **explicit deletion** — the path is in the guideline with `use: "notRecommended"` + `notes: "Intentionally left empty"`; (b) **implicit deletion** — the path simply isn't in the guideline at all (the converter strips anything the partner doesn't allowlist). Both render in the Orderful UI as a yellow strike-through indicator next to the value. Fetch the actual rules via `GET /v2/guideline-sets/{id}/guidelines?convertToOrderfulPath=true` — paths match the `dataPath` shape from validation errors. Practical implication: before writing JSONata to *remove* a SuiteApp default the partner rejects, check whether the guideline is already stripping it. Overriding fields the partner doesn't reference is harmless, but writing JSONata to delete fields the guideline already removes is wasted effort. The guideline endpoints accept the public `orderful-api-key` (no UI JWT required).

## Reference material

- [`reference/outbound-jsonata.md`](../../reference/outbound-jsonata.md) — full reference: input/context variables, the wrapped-envelope pattern, transform operator semantics, registered SuiteQL functions, common Orderful JSON field names, schema gotchas, and an annotated worked-example expression covering N1 / TD1 / TD5 / REF / LIN.
- [`reference/record-types.md`](../../reference/record-types.md) — schema for `customrecord_orderful_edi_customer_trans` (where the JSONata field lives), `customrecord_orderful_transaction` (the saved-message field), and related records.
