---
name: writing-860-jsonata
description: Author and debug inbound JSONata Advanced Mappings for 860 Purchase Order Change Requests in the Orderful NetSuite SuiteApp. Covers the 860 BDO output shape (with a JSON Schema), exactly which fields the change applier reads, how items / Sales Orders / lines are resolved, why `item.netsuiteItemId` / `transactionLineId` / `lineUniqueKey` overrides are ignored on the 860, and verified example expressions (partner item qualifiers the connector doesn't read such as PI/UI, new quantity in POC03, PO-number normalisation, split-order targeting, custom fields). Use when the user says "write JSONata for the 860", "860 advanced mapping", "the 860 fails with lineUniqueKey is required", "Error applying line change for item null", "the change order isn't applying to the sales order", "my 860 JSONata is ignored", or is editing the Advanced Mapping pane on an 860 Enabled Transaction Type.
---

# Writing 860 JSONata (Purchase Order Change Request)

An inbound 860 does not create a record — it edits the Sales Order(s) that an earlier 850 created. That changes what the Advanced Mapping can and cannot do, and nearly every 860 mapping failure comes from carrying 850 habits across. This skill is the 860-specific counterpart to [`writing-inbound-jsonata`](../writing-inbound-jsonata/SKILL.md); the engine, helpers, and transform-operator idioms are the same, the output contract is not.

## When to use this skill

Use when the user says any of:

- "write / fix the JSONata for the 860 for customer X"
- "every 860 fails with `Cannot delete line: lineUniqueKey is required for deletion`" (or `Cannot update line …`)
- "the error says `Error applying line change for item null`"
- "the partner's 860 guide doesn't send POC01 / identifies lines only by product code"
- "I set `netsuiteItemId` / `transactionLineId` / `lineUniqueKey` in the 860 mapping and it's ignored"
- "the 860 can't find the 850" / "no related sales orders found for parent purchase order"
- "quantity change found … multiple sales orders but no store distributions"
- "stamp a custom field on the Sales Order when an 860 comes in"

Do NOT load this skill for:

- **850 mappings** — [`writing-inbound-jsonata`](../writing-inbound-jsonata/SKILL.md). Same engine, different contract (see [Differences from the 850](#differences-from-the-850-mapping)).
- **Outbound** 855/856/810/865 — [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md).
- **Reconciling many historical 860s against open Sales Orders** — [`reconcile-860-with-so`](../reconcile-860-with-so/SKILL.md). That skill decides *what should be applied*; this one makes the SuiteApp apply it.
- **Creating Item Lookup records** for a partner part number — [`item-lookup`](../item-lookup/SKILL.md). Often the right fix instead of JSONata; see Step 2.
- Reading the SuiteApp's step-by-step inbound trace after the fact — [`inspect-inbound-diagnostics`](../inspect-inbound-diagnostics/SKILL.md).

## Prerequisites

- The customer has an EDI Enabled Transaction Type row for the 860 (`customrecord_orderful_edi_customer_trans`, document type prefix `860_PURCHASE_ORDER_CHANGE_REQUEST_BUYER`). The expression lives in its Advanced Mapping field (`custrecord_edi_enab_jsonata`). Route to [`enable-customer`](../enable-customer/SKILL.md) if the row is missing.
- A SuiteApp version that runs JSONata on the 860 — the Advanced Mapping field is present on the 860 row and the processing script logs `Native JSONata mapper`. **Versions below 1.22.10 could not resolve 860 items qualified with `SK` at all** (mapper bug, fixed in 1.22.10). If the customer is below that and the partner uses `SK`, the answer is an upgrade, not JSONata.
- [`netsuite-setup`](../netsuite-setup/SKILL.md) has been run for the customer so SuiteQL probes work (`~/orderful-onboarding/<customer-slug>/.env`).

## Inputs the skill needs

1. **The failing 860** — Orderful transaction id or the NetSuite `customrecord_orderful_transaction` internal id — and its recorded error text.
2. **The raw message** (`custrecord_ord_tran_message`) — specifically the `POC_loop[].lineItemChange[0]` segments: which `productServiceIDQualifier*` codes the partner actually sends, and whether `quantity`, `quantity1`, `unitPrice` are populated. Trust the payload over the partner's implementation guide.
3. **Mapped Data and Mapped Split Data** from the same record (query in [Debugging](#debugging)). These tell you whether the problem is in the mapping or in resolution.
4. **What the change should do** in NetSuite terms — cancel a line, change a quantity, change a price, move a date, add a line — and on which Sales Order when the PO was split.

## Mental model — how the mapping runs

1. The native mapper turns the message into an 860 BDO: header fields from BCH/DTM, one `transactionLines[]` entry per POC loop.
2. **Your JSONata runs next and its return value replaces the BDO.** The native BDO is `$defaultValues`. The result is stored on the Orderful Transaction record as **Mapped Data** (`custrecord_ord_tran_mapped_data`).
3. The reduce step resolves that BDO against NetSuite — parent 850, its linked Sales Orders, NetSuite items, Sales Order lines — into a change set, stored as **Mapped Split Data** (`custrecord_orderful_mapped_split_bdos`).
4. The change set is validated against the customer's change-request settings and applied: quantity/price updates, then line closures, then additions, then `userDefinedFields`, then save. A clean apply answers with an 865 (`BCA02 = AK`); a refusal because the order already began fulfilling answers `RJ`.

The BDO describes *the requested change*. Every NetSuite identity — item, Sales Order, line — is derived in step 3 from what you put in it. **There is no field that names a NetSuite item, line, or order directly.** POC01 (`assignedIdentification`) is never read either.

## Expected output shape

Machine-readable: [`860.bdo.schema.json`](./860.bdo.schema.json) (JSON Schema draft-07; every property's `description` says what reads it). Annotated:

```text
{
  "transaction": {
    "transactionId":       string | null,   // ST02 — never read
    "purchaseOrderNumber": string,          // BCH03 — REQUIRED. Exact match to ONE inbound 850's PO number
    "purchaseOrderType":   string | null,   // BCH02 — never read
    "purposeCode":         string | null,   // BCH01 — never read

    // Header dates, YYYYMMDD strings or null. All gated by the Allow Date Changes setting.
    "orderDate":           "20260122" | null,  // BCH05   → custbody_orderful_edi_po_date (+ trandate if Use 850 Date)
    "requestedShipDate":   "20260130" | null,  // DTM*010 → shipdate
    "startDate":           ... | null,         // DTM*196 → startdate
    "endDate":             ... | null,         // DTM*197 → enddate
    "earliestDelivery":    ... | null,         // DTM*064 → custbody_orderful_earliest_delivery
    "latestDelivery":      ... | null,         // DTM*063 → custbody_orderful_latest_delivery

    "hasStoreDistributions": boolean,       // informational

    "transactionLines": [
      {
        "changeCode": "AI"|"CA"|"CF"|"CT"|"DI"|"NC"|"PC"|"PQ"|"QC"|"QD"|"QI"|"RE"|"RZ",  // POC02 — REQUIRED
        "quantity":   number | null,        // POC03 — carried, never applied
        "quantity1":  number | null,        // POC04 — THE new quantity (unless storeDistributions present)
        "unitPrice":  string | null,        // POC08 — the new rate
        "item": {                           // the ONLY input to item resolution; all three objects required
          "buyer":     { "buyerCatalogNumber": CB, "buyerItemNumber": IN, "buyerPartNumber": BP, "sku": SK },
          "seller":    { "vendorStyleNumber": IB, "vendorNumber": VN, "vendorPartNumber": VP, "brandLabel": BL, "productType": TP },
          "universal": { "ean": EN, "eanUCC8": EO, "upc": UP, "upcEANContainerCode": UK }
        },
        "storeDistributions": [             // from SDQ; [] when absent
          { "storeId": "0876", "storeIdQualifier": "92", "quantity": 9, "unitOfMeasure": "EA" }
        ],
        "transactionLineId": null           // ignored
      }
    ],

    "userDefinedFields": { "custbody_x": value, ... },  // optional; applied to every touched Sales Order
    "_textFields": ["custbody_some_date"]               // optional; SIBLING of userDefinedFields on the 860
  },
  "metadata": { "type": "860_PURCHASE_ORDER_CHANGE_REQUEST_BUYER", ... },  // keep as-is; `type` routes processing
  "errors": []
}
```

## What the applier reads — and what it ignores

| Field | Read? | Effect |
| --- | --- | --- |
| `transaction.purchaseOrderNumber` | **Yes** | Finds the parent 850 (exact string match on the Orderful Transaction PO number). Zero or several matches = fatal. |
| `transaction.orderDate`, `requestedShipDate`, `startDate`, `endDate`, `earliestDelivery`, `latestDelivery` | **Yes** | Each non-null value is a header date change on every targeted Sales Order. Refused as a whole when Allow Date Changes is off. |
| `transaction.userDefinedFields` / `transaction._textFields` | **Yes** | `setValue` / `setText` on every Sales Order the 860 touches, just before save. `null` values are skipped. |
| `transactionLines[].changeCode` | **Yes** | Selects the change type(s) — table below. Unknown code = line error. |
| `transactionLines[].quantity1` | **Yes** | New quantity for quantity changes and additions, when no store distribution supplies one. |
| `transactionLines[].unitPrice` | **Yes** | New rate for price changes and additions. |
| `transactionLines[].item.*` | **Yes** | The whole item-resolution input — see below. |
| `transactionLines[].storeDistributions[].storeId`, `.quantity` | **Yes** | Picks the Sales Order per store and its quantity. |
| `metadata.type` | **Yes** | Must stay the 860 type or processing stops with "Unsupported transaction type". |
| `transaction.transactionId`, `purchaseOrderType`, `purposeCode`, `hasStoreDistributions` | No | Carried only. |
| `transactionLines[].quantity` (POC03) | No | Carried only. If the partner sends the new quantity here, copy it into `quantity1` (example below). |
| `transactionLines[].transactionLineId` | No | Only interpolated into error text. |
| `transactionLines[].storeDistributions[].storeIdQualifier`, `.unitOfMeasure` | No | Carried only. |
| `transactionLines[].item.netsuiteItemId`, `lineUniqueKey`, or any invented key | **No** | Silently ignored. The 850 honours `item.netsuiteItemId`; the 860 does not. |
| `errors` | No | Carried into the reduce write-back, not consumed. |

## How a line becomes a Sales Order change

1. **Item.** `item.*` is matched, in this order, and the first hit wins:
   1. An **Orderful Item Lookup** record (`customrecord_orderful_item_lookup`) whose qualifier code and value match a populated `item` field, scoped to the customer / parent customer (or global when the record has no customer) and subsidiary. Fields are tried buyer (CB, IN, BP, SK) → seller (IB, VN, VP, BL, TP) → universal (EN, EO, UP, UK).
   2. The **item master**: `seller.vendorNumber || seller.vendorPartNumber` equal to the SuiteApp's configured SKU field (default `itemid`), or `universal.upc || upcEANContainerCode || ean || eanUCC8` equal to the configured UPC field (default `upccode`). Exact match, active items only.

   No hit → the line's `itemId` is `null`. For `AI` that is reported honestly ("Item not found in NetSuite for addition"). For every other code it surfaces later as **"Cannot delete/update line: lineUniqueKey is required"** with **"for item null"** in the message. That wording means *the item did not resolve* — not that a line key was missing.
2. **Sales Orders.** All Sales Orders linked to the parent 850. If any is past Pending Approval / Pending Fulfillment, the whole 860 is refused (865 `RJ`).
   - **No `storeDistributions`:** the line is applied to every linked Sales Order that has the item. A quantity change against more than one Sales Order without distributions fails ("unable to determine quantity allocation").
   - **With `storeDistributions`:** each `storeId` is resolved to one Sales Order — shipping-address store number, then DC number (DC-consolidated orders), then a line item's store number — and that entry's `quantity` is the new quantity for that order. An unresolvable store fails the line.
3. **Line.** The first line on that Sales Order whose item internal id equals the resolved item. If the same item is on two lines of one order, the first is used.
4. **Change type** from `changeCode` (table below).
5. **Validation** against the customer's change-request settings — Item Quantity Changes (none / increase only / decrease only), Item Pricing Changes (same), Allow Date Changes; see [`settings-architecture.md`](../../reference/settings-architecture.md) for where those resolve from — plus: a deletion and a quantity/price change on the same line conflict; additions need a resolvable item and a quantity; negative prices are rejected. **Any error → nothing is applied** and the errors are written to the Orderful Transaction record.
6. **Apply order:** quantity/price updates → line closures (`isclosed = true`; lines are never removed) → additions (item, quantity, custom price level with `rate`, units) → `userDefinedFields` → save, per Sales Order.

### Change codes (POC02)

| Code | Produces | Needs |
| --- | --- | --- |
| `AI` Add item | Addition (new line) | resolvable item; `quantity1` or a store quantity; `unitPrice` optional |
| `CA` Changes to line | Quantity change if `quantity1`/store quantity present; Price change if `unitPrice` present | matched line |
| `CF` Cancel PO | Closes the matched line (only lines present in the POC loop) | matched line |
| `CT` Change dates | Line-level no-op (dates apply from the header DTM segments) | matched line — the item must still resolve |
| `DI` Delete item | Closes the matched line | matched line |
| `NC` No change | Skipped | — |
| `PC` Price change | Price change | matched line; `unitPrice` |
| `PQ` Unit price / quantity change | Quantity and/or Price, whichever values are present | matched line |
| `QC` `QD` `QI` Quantity change / decrease / increase | Quantity change | matched line; `quantity1` or a store quantity |
| `RE` Replace item | Closes the matched line **and** adds a new line for the same resolved item | matched line |
| `RZ` Replace all values | Quantity and/or Price, whichever values are present | matched line |
| anything else | Line error `Unknown change code` | — |

The full X12 code list, including codes the SuiteApp does not act on, is in [`edi-codes-and-mappings.md`](../../reference/edi-codes-and-mappings.md).

## What the mapping can and cannot change

**Can**

- Move partner item identifiers into the qualifier slots the resolver reads — the fix when a partner uses a qualifier the connector does not know (`PI`, `UI`, …).
- Copy the new quantity into `quantity1` when the partner sends it in POC03.
- Normalise `purchaseOrderNumber` so it matches the stored 850.
- Add, move, or clear header dates (as YYYYMMDD strings).
- Re-code lines (`changeCode`), drop lines, or synthesise `storeDistributions` so a change lands on the right split Sales Order.
- Write `custbody_*` fields on the touched Sales Orders via `userDefinedFields` / `_textFields`.

**Cannot**

- Name the NetSuite item, line, or Sales Order directly. `item.netsuiteItemId`, `transactionLineId`, `lineUniqueKey`, or a sales order id in the BDO are all ignored.
- Bypass the change-request settings or the open-order gate.
- Change the 865 answer.

## The recipe

### Step 1 — Diagnose from the record, not the guide

Pull the three fields together (see [Debugging](#debugging) for the query). Then:

- `Mapped Data` lacks what you expected → mapping problem (or no JSONata ran — check the `Native JSONata mapper` audit log line: "No JSONata configured … Skipping override" vs "Applying …").
- `Mapped Split Data` has `lineChanges[].itemId: null` → item resolution failed. Go to Step 2.
- `itemId` set but `lineUniqueKey: null` → the item resolved but is not on that Sales Order (wrong order targeted, or a genuinely different item). Check `salesOrderId` and the PO number.
- `errors.headerErrors` / `errors.lineErrors` populated → validation refused it; read the text, it names the setting.
- `lineChanges` empty and `salesOrderIds` populated → the closed-order gate refused it (order already fulfilling/billing). No mapping fixes that.

### Step 2 — Pick the lever, and prefer the non-JSONata one

| Symptom | First choice | JSONata only if |
| --- | --- | --- |
| Partner qualifier is one the connector knows (CB/IN/BP/SK/IB/VN/VP/BL/TP/EN/EO/UP/UK) but no item matches | Create an Item Lookup record for that qualifier + value ([`item-lookup`](../item-lookup/SKILL.md)) — no mapping, survives upgrades | the value needs transformation (prefix strip, zero-pad) before it can match |
| Partner qualifier is NOT in that list | **JSONata** — lift the value into a supported slot (example below). Also flag it as a product gap: the fix is per customer, and the next customer with the same partner hits it again. | — |
| Partner sends the new quantity in POC03 only | JSONata copy into `quantity1` | — |
| PO number carries a suffix / prefix the 850 didn't | JSONata normalise | — |
| Split PO, no SDQ, quantity changes fail | JSONata synthesise `storeDistributions` (advanced example) | — |
| Custom field on the Sales Order | JSONata `userDefinedFields` | — |
| Change refused by Item Quantity / Pricing / Date settings | Settings conversation with the customer — see [`settings-architecture.md`](../../reference/settings-architecture.md) | never |
| Version below 1.22.10 and partner uses `SK` | Upgrade the SuiteApp | never |

### Step 3 — Write the expression on top of `$defaultValues`

Always the transform operator: `$defaultValues ~> | <path> | { overrides } |`. Never construct the BDO from scratch — `metadata`, the three `item` sub-objects and every carried field must survive. Bind intermediates with `:=` in a parens block when you need the raw POC segments (`message.transactionSets[0].POC_loop`).

### Step 4 — Save and test on a failing or freshly injected 860

Save the expression on the 860 Enabled Transaction Type row (the SPA preview pane, when present for the document type, is a syntax check — the resolution step only runs in processing). Then reprocess the failing 860 ([`reprocess-transaction`](../reprocess-transaction/SKILL.md)) or inject a test one ([`inject-test-transaction`](../inject-test-transaction/SKILL.md)). Do not re-run an 860 that already applied to re-test a mapping — additions would be re-added.

### Step 5 — Verify in Mapped Split Data, then on the Sales Order

`lineChanges[].itemId`, `.lineUniqueKey`, `.salesOrderId` all populated, `errors` empty, record status Success, and the Sales Order line shows the change. If the customer is enabled for the 865, an outbound 865 with `BCA02 = AK` should exist.

## Examples

All examples below were evaluated against the real native 860 mapper output and validated against the schema; each starts from `$defaultValues` so untouched fields — including `metadata` — survive.

### Start from the default

The smallest valid expression. Anything you add is an overlay on this.

```jsonata
$defaultValues
```

### Partner identifies items with qualifiers the connector does not read

Some partners send the buyer item number as `PI` and the UPC as `UI`. Neither is in the connector's qualifier map, so the native BDO has every `item` field null and no item resolves. Lift the UPC into `item.universal.upc` (matched against the item master UPC field) and the partner's number into `item.buyer.buyerPartNumber` (matched by an Item Lookup record with qualifier `BP`):

```jsonata
(
  $segments := [message.transactionSets[0].POC_loop.lineItemChange[0]];
  $defaultValues ~> | transaction | {
    "transactionLines": [$map(transactionLines, function($line, $i) {
      $line
        ~> | item.universal | { "upc": $lookupQualifiedValues($segments[$i], "UI")[0] } |
        ~> | item.buyer | { "buyerPartNumber": $lookupQualifiedValues($segments[$i], "PI")[0] } |
    })]
  } |
)
```

`$lookupQualifiedValues` scans the `productServiceIDQualifier*` pairs of the segment, so it works whatever slot the partner used. When a qualifier is absent the key is left as it was (`null`). The outer `[ … ]` keeps `transactionLines` an array even for a single-line message.

### Partner sends the new quantity in POC03

The applier reads `quantity1` (POC04) as the new quantity. If the partner only fills POC03, quantity changes fail with "updated quantity or store distribution quantity is required". Copy it across when POC04 is empty (an explicit `0` is preserved):

```jsonata
$defaultValues ~> | transaction.transactionLines | {
  "quantity1": quantity1 != null ? quantity1 : quantity
} |
```

### PO number does not match the stored 850

The 860 must reference the 850 by the exact PO number stored on the Orderful Transaction record. A partner that suffixes change requests (`PO12345-1`) never finds its parent:

```jsonata
$defaultValues ~> | transaction | {
  "purchaseOrderNumber": $substringBefore(purchaseOrderNumber, "-")
} |
```

### Treat a zero-quantity change as a line cancel

Partners that cancel lines by sending a quantity change to zero would otherwise leave a zero-quantity open line:

```jsonata
$defaultValues ~> | transaction.transactionLines[changeCode = "QC" and quantity1 = 0] | {
  "changeCode": "DI"
} |
```

### Ignore informational lines

```jsonata
$defaultValues ~> | transaction | {
  "transactionLines": [transactionLines[changeCode != "NC"]]
} |
```

### Record the change on the Sales Order

`userDefinedFields` lands on every Sales Order the 860 modifies. Dates go through `setText`, so format them in the account's date format and list them in `_textFields` — which on the 860 sits **beside** `userDefinedFields`, not inside it. Field ids are placeholders.

```jsonata
(
  $bch := message.transactionSets[0].beginningSegmentForPurchaseOrderChange[0];
  $defaultValues ~> | transaction | {
    "userDefinedFields": {
      "custbody_po_change_purpose": $bch.transactionSetPurposeCode,
      "custbody_po_change_date": $formatDate($bch.date, "yyyyMMdd", "M/d/yyyy")
    },
    "_textFields": ["custbody_po_change_date"]
  } |
)
```

### Advanced: target one Sales Order of a split PO without SDQ

When the 850 was split into one Sales Order per ship-to and the 860 carries no SDQ, a quantity change cannot be allocated and fails. If the N1*ST identifies the store, synthesise a distribution so the change lands on that order only:

```jsonata
(
  $shipTo := message.transactionSets[0].N1_loop[partyIdentification[0].entityIdentifierCode = "ST"][0].partyIdentification[0].identificationCode;
  $defaultValues ~> | transaction.transactionLines[$count(storeDistributions) = 0] | {
    "storeDistributions": [{
      "storeId": $shipTo,
      "storeIdQualifier": "92",
      "quantity": quantity1,
      "unitOfMeasure": "EA"
    }]
  } |
)
```

`storeId` must equal the store number on the target Sales Order's shipping address (or its DC number, or a line's store number) — the same values the 850 split used.

## Behaviour rules

1. **Start from `$defaultValues` with the transform operator. Never rebuild the 860 BDO from scratch.** A bare `{ "transaction": … }` loses `metadata` and the processor cannot route it.
2. **Never emit `item.netsuiteItemId`, `transactionLineId`, `lineUniqueKey`, or a sales order id.** They are stored and read by nothing. Fix the qualifiers, or add an Item Lookup record.
3. **Diagnose from Mapped Split Data before touching the expression.** `itemId: null` is an item-resolution problem even when the error text talks about `lineUniqueKey`.
4. **Prefer an Item Lookup record over JSONata** whenever the partner's qualifier is one the connector already reads. Records survive upgrades and don't need a contractor to maintain.
5. **Check the SuiteApp version first.** Below 1.22.10 the 860 mapper dropped `SK` qualifiers entirely; no expression fixes that — upgrade.
6. **Keep the shape:** all three `item` sub-objects present; `quantity1` a number (wrap raw message values in `$number()`); `unitPrice` a string or number; dates as YYYYMMDD strings; `_textFields` beside `userDefinedFields`; the key is `metadata`, not `metaData`.
7. **Never route around the change-request settings.** If the customer's Item Quantity / Pricing / Date settings refuse the change, that is a settings decision for the customer, not a mapping problem.
8. **Test only on 860s in Error or on freshly injected test 860s.** Re-running one that already applied would re-add `AI`/`RE` lines.
9. **When the fix is a qualifier the connector doesn't support, say so.** Ship the per-customer JSONata to unblock, and flag the missing qualifier as a product gap so it can be added to the connector's qualifier map.
10. **Strip customer data** before pasting expressions or Mapped Data into shared channels or this repo — PO numbers, store numbers, item codes.

## Debugging

Pull the three relevant fields for a transaction in one query (via the `suiteql.mjs` sample or a signed SuiteQL call). Note the REST SuiteQL endpoint omits null columns from each row:

```sql
SELECT id,
       custrecord_ord_tran_status,
       custrecord_ord_tran_mapped_data,
       custrecord_orderful_mapped_split_bdos
FROM customrecord_orderful_transaction
WHERE custrecord_ord_tran_orderful_id = '<orderful-transaction-id>'
```

- **Mapped Data** (`custrecord_ord_tran_mapped_data`) is your expression's output. If a value is missing here, the mapping is the problem.
- **Mapped Split Data** (`custrecord_orderful_mapped_split_bdos`) is the resolved change set. Look at `lineChanges[].itemId`, `.lineUniqueKey`, `.salesOrderId`, `.changeType` and `errors`.
- Errors are child records of type `customrecord_orderful_transaction_error`; the Orderful Transaction record's Errors tab shows them.
- "Error applying line change **for item null** … lineUniqueKey is required" = item-resolution failure wearing a line-key message.
- Execution log titles worth searching (via [`which-script-ran`](../which-script-ran/SKILL.md)): `Native JSONata mapper` (did an override run), `bdoToChangeSet: itemLookupData` (what the resolver had to work with), `mapLineChange: matchingLineItem` (the Sales Order line it picked), `bdoToChangeSet: change refused, order closed to change`.

## Differences from the 850 mapping

| | 850 | 860 |
| --- | --- | --- |
| Metadata key | `metaData` | `metadata` |
| `item.netsuiteItemId` in the BDO | Honoured — skips native lookup | Ignored — item always re-resolved from qualifiers |
| `_textFields` | inside `userDefinedFields` | `transaction._textFields`, beside `userDefinedFields` |
| `userDefinedFields` value `null` | Written (clears the field) | Skipped (field unchanged) |
| Target records | One new Sales Order | Every Sales Order linked to the parent 850 (or the ones its store distributions name) |
| Line identity | Positional — lines are created | By resolved item, per Sales Order |
| Failure surface | Validation errors before create | Validation errors, else apply errors; nothing is applied if any line fails validation |

## Reference material

- [`860.bdo.schema.json`](./860.bdo.schema.json) — the output contract, one description per property.
- [`writing-inbound-jsonata`](../writing-inbound-jsonata/SKILL.md) — engine, helper functions (`$lookupQualifiedValues`, `$formatDate`, `$lookupItems`, …), transform-operator idioms, raw message shape.
- [`settings-architecture.md`](../../reference/settings-architecture.md) — where Item Quantity / Pricing / Date change settings resolve from (ETT override → subsidiary default).
- [`edi-codes-and-mappings.md`](../../reference/edi-codes-and-mappings.md) — POC02 codes and the 860 → 855 line-ack matrix.
- [`bulk-jsonata-update`](../bulk-jsonata-update/SKILL.md) — rolling the same 860 expression out across many customers.
- Connector source, relative to `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/` in `netsuite-connector`: `TransactionHandling/860/buyerRequestedChangeOrder.service.ts` (`mapToBdo`, `mapTransactionLines`, `bdoToChangeSet`, `findMatchingTransactionLine`, `mapLineChange`, the apply helpers), `TransactionHandling/860/buyerRequestedChangeOrder.validator.ts`, `TransactionHandling/860/types.ts`, `TransactionHandling/mapping/mapInboundNativeJsonata.ts` (the full-replace hook), `TransactionHandling/orderful_inboundTransaction_LIB.ts` (`getItemLookup`, `fetchItemLookupData`), `TypesAndUtil/orderful.ts` (`ProductServiceQualifier`), `TypesAndUtil/utils.ts` (`ITEM_QUALIFIER_MAP`).
