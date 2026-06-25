---
name: build-mock-fulfillments
description: Build a mock Item Fulfillment from a NetSuite Sales Order, pack it with Orderful carton + shipped-item records, and fire the outbound 856 by setting `custbody_orderful_ready_to_process_ful = true`. Starts with a Sales Order outbound-readiness pre-flight so the IF transform doesn't fail silently. Use when running an end-to-end test cycle for a new customer, or when the user says "build the IF and fire the 856", "ship these SOs and send the ASN", "/build-mock-fulfillments", "test the 856 mapping for customer X", or "create test fulfillments" — the procedural counterpart to `bill-and-fire-810` (which handles the Invoice/810 step).
---

# Build Mock Fulfillments and Fire 856s

The IF/856 leg of the standard test cycle: `850 inject → SO created → 855 fired → **IF created + packed → 856 fired** → invoice + 810`. This skill transforms a Sales Order into an Item Fulfillment, packs it the way the SuiteApp's 856 generator expects (carton + shipped-item records, **not** native NetSuite packages), ships it, and fires the outbound 856.

The output is one outbound `customrecord_orderful_transaction` row of document type 856, with the corresponding Orderful transaction visible at `https://ui.orderful.com/transactions/{ofId}`.

It is the sibling of [`bill-and-fire-810`](../bill-and-fire-810/SKILL.md). The most common failure mode — and the reason this skill leads with a pre-flight — is that the SO looks fine in the UI but isn't actually shippable, so the REST transform produces an empty fulfillment and NetSuite rejects it with a misleading error.

## When to use this skill

- "Build the Item Fulfillment for SO 11521567 and fire the 856"
- "We finished the 855 — now ship the orders and send the ASN"
- "/build-mock-fulfillments 11521567"
- "Test the 856 mapping for the new customer"
- End of the fulfillment leg of the test cycle (850 → SO → 855 → **IF → 856**)

Do NOT use this skill when:
- The customer's packing comes from a configured analytics dataset (`custentity_orderful_pkg_data_src` set) rather than carton records — the carton-record steps below don't apply; see [`alternative-packing-source`](../alternative-packing-source/SKILL.md).
- You only want to edit an existing IF — PATCH it directly instead of transforming a new one.

## Prerequisites

- Customer has an outbound 856 ECT (`customrecord_orderful_edi_customer_trans`, document type "856 Ship Notice/Manifest", `custrecord_edi_enab_trans_auto_send_asn = T`). If not, route to [`enable-customer`](../enable-customer/SKILL.md).
- Customer's `~/orderful-onboarding/<slug>/.env` is set up via [`netsuite-setup`](../netsuite-setup/SKILL.md).
- The 850 → SO step is done and (ideally) the 855 has been acked.

## Inputs the skill needs

1. **One or more NS Sales Order IDs** — internal numeric IDs.
2. **Customer slug** — for env loading. Ask if not specified; list `~/orderful-onboarding/`.

## The recipe

### Step 0 — Sales Order outbound-readiness pre-flight

Run this BEFORE the transform. A SO can be `Pending Fulfillment` and still produce an empty Item Fulfillment; the transform then fails with `"You must enter at least one line item for this transaction."` — which says nothing about the real cause. Verify the readiness checklist in [`reference/outbound-source-readiness.md`](../../reference/outbound-source-readiness.md). The high-frequency offenders for the 856:

| Check | SuiteQL / field | Why it bites |
|---|---|---|
| Approved & fulfillable | `BUILTIN.DF(status)` = `Pending Fulfillment` | not transformable otherwise |
| **Single ship route** | `isMultiShipTo` on the SO record (REST) | multi-ship-to splits lines across ship groups; the plain transform selects **zero** lines → empty IF |
| Every shippable line has a **location** | `transactionline.location` per item line | lines with no location aren't fulfillable; also drives the 856 Ship-From |
| Committed / on-hand | `transactionline.quantitycommitted` > 0; `aggregateItemLocation.quantityonhand` at the line location | nothing to ship |
| **Native shipping address populated** | `GET /record/v1/salesOrder/{id}/shippingAddress` → `addr1`/`city`/`state`/`zip` | empty here → empty `N1*ST` on the 856 (and a tripwire for the inbound ship-to write bug — see [`inspect-inbound-diagnostics`](../inspect-inbound-diagnostics/SKILL.md)) |
| Items resolved + unit set | line `item`, `units` | placeholder/unmapped items break the LIN loop |
| Packing source decided | carton records (this skill) vs dataset (`custentity_orderful_pkg_data_src`) | the 856 generator hard-errors `"None of the following item fulfillments have cartons: <ifId>"` if neither yields cartons |

If `isMultiShipTo = true` but the order is logically a single shipment (one destination, split only by shipping method — a frequent artifact of the inbound 850→SO mapping), flip it before transforming:

```http
PATCH /services/rest/record/v1/salesOrder/{soId}
{ "isMultiShipTo": false }
```

If it is genuinely multi-destination, fulfill one ship group per IF (out of scope for the quick test path — handle in the UI or a dedicated script).

### Step 1 — Transform the SO into an Item Fulfillment

```
POST /services/rest/record/v1/salesOrder/{soId}/!transform/itemFulfillment
```

The REST transform does **not** auto-select lines to fulfill — an empty body yields the "at least one line item" error even when the SO is fully committed. Mark each shippable line explicitly. Reference lines by the SO transaction line's unique key (`SELECT uniquekey FROM transactionline WHERE transaction = {soId} AND itemtype = 'InvtPart'`):

```json
{ "item": { "items": [
  { "orderLine": 296500001, "itemreceive": true },
  { "orderLine": 296500002, "itemreceive": true }
] } }
```

The 204 response carries the new Item Fulfillment ID in the `Location` header.

### Step 2 — Pack it: carton + shipped-item records

The SuiteApp's 856 generator builds the pack (P) and item (I) hierarchy levels from its **own** custom records, not from NetSuite's native Packages sublist. Create:

1. One `customrecord_orderful_carton` per carton:
   - `custrecord_orderful_carton_fulfillment` → the IF id
   - `custrecord_orderful_carton_is_pallet` = `false` (carton) / `true` (pallet/tare)
   - `custrecord_orderful_carton_sequence` = carton number
   - `custrecord_orderful_carton_weight`
   - **Marks driver:** `custrecord_orderful_carton_sscc18` (a valid SSCC-18) → emits `MAN*GM` / `MAN*AA`; `custrecord_orderful_carton_tracking` → emits `MAN*CP`. Set the one the partner guideline allows; clear the other so the generator doesn't emit a second, disallowed `MAN`.
2. One `customrecord_orderful_shipped_item` per item in the carton:
   - `custrecord_orderful_shipped_carton` → the carton id
   - `custrecord_orderful_shipped_fulfillment` → the IF id
   - `custrecord_orderful_shipped_item` → the NS item id
   - `custrecord_orderful_shipped_quantity`

`customrecord_orderful_shipped_item` has a required `name` field on create; so does `customrecord_orderful_carton` if the install marks it mandatory — pass `name`/`altName` to avoid `"Please enter value(s) for: Name."`.

### Step 3 — Ship the Item Fulfillment

```http
PATCH /services/rest/record/v1/itemfulfillment/{ifId}
{ "shipStatus": "C" }
```

`shipStatus` `C` = Shipped (the 856 reflects a shipped IF). You can set status and packages in the same PATCH if you also use native packages, but the carton records above are what the 856 generator reads.

### Step 4 — Fire the outbound trigger

```http
PATCH /services/rest/record/v1/itemfulfillment/{ifId}
{ "custbody_orderful_ready_to_process_ful": true }
```

This is the 856 analog of the 810's `custbody_orderful_ready_to_process_inv`. The SuiteApp's outbound MapReduce picks it up within ~30–60 seconds. If a prior attempt left a stale state, toggle the flag `false` then `true` to re-queue.

### Step 5 — Watch for the resulting 856 transaction

The generator writes a `customrecord_orderful_transaction` row keyed by a consolidation key of the form `<direction>-856_ship_notice_manifest-<ifId>`:

```sql
SELECT id, custrecord_ord_tran_orderful_id, BUILTIN.DF(custrecord_ord_tran_status) AS status,
       custrecord_ord_tran_error
FROM customrecord_orderful_transaction
WHERE custrecord_orderful_consolidation_key = '2-856_ship_notice_manifest-<ifId>'
ORDER BY custrecord_ord_tran_orderful_id DESC
```

- Status `Error` with `"None of the following item fulfillments have cartons"` → Step 2 didn't produce cartons for this IF (committed before the carton records existed, or the dataset returned none).
- Status `Error` / `"See Validation Tab for error detail"` → it reached Orderful but failed guideline validation. Pull structured errors with [`fetch-validations`](../fetch-validations/SKILL.md), then fix mapping with [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md). Run [`audit-outbound-rules`](../audit-outbound-rules/SKILL.md) first.

Then confirm on Orderful's side:

```http
GET https://api.orderful.com/v3/transactions/{orderful_id}
Headers: orderful-api-key: ${ORDERFUL_API_KEY}
```

`VALID + DELIVERED` → done.

## Behaviour rules

1. **Always run the Step 0 pre-flight before transforming.** The empty-IF / "at least one line item" failure is almost always a readiness gap (multi-ship-to, missing line location, nothing committed) — not a transform-syntax problem. Diagnosing it after the fact wastes far more time than the pre-flight.
2. **Pack with carton records, not native packages.** The 856 generator ignores the NetSuite Packages sublist; it reads `customrecord_orderful_carton` + `customrecord_orderful_shipped_item` (or a configured analytics dataset). Native packages alone produce the "no cartons" hard error.
3. **One `MAN` driver per carton.** Setting both `_sscc18` and `_tracking` emits two `MAN` segments (`GM` + `CP`); the partner guideline usually allows only one. Set the allowed one and clear the other.
4. **Don't fabricate SSCCs or addresses inline.** A valid SSCC-18 goes on the carton record; the ship-to address belongs on the SO/IF. Mock missing source data at the record, never as a literal in JSONata — see [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md) rule 13.
5. **Confirm sandbox vs. production.** This writes a real Item Fulfillment and fires real outbound EDI. Confirm `NS_SB_*` vs `NS_PROD_*` in `.env` matches intent.
6. **Test cycle order matters.** The 856 should be `VALID + DELIVERED` before billing the 810 ([`bill-and-fire-810`](../bill-and-fire-810/SKILL.md)) — a rejected 856 often predicts a rejected 810.

## Reference material

- [`reference/outbound-source-readiness.md`](../../reference/outbound-source-readiness.md) — the source-record readiness checklist for 855/856/810.
- [`bill-and-fire-810`](../bill-and-fire-810/SKILL.md) — the Invoice/810 counterpart leg.
- [`fetch-validations`](../fetch-validations/SKILL.md) — structured errors when the 856 lands `INVALID`.
- [`audit-outbound-rules`](../audit-outbound-rules/SKILL.md) / [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md) — fix guideline-validation failures.
- [`alternative-packing-source`](../alternative-packing-source/SKILL.md) — when cartons come from an analytics dataset instead of carton records.
