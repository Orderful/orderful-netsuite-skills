# EDI codes and Orderful SuiteApp mappings

Reference doc for the numeric IDs and standard EDI codes you encounter when working with the Orderful NetSuite SuiteApp. These let you read raw `customrecord_orderful_transaction` rows and Orderful API responses without guessing.

## `transactionTypeId` — Orderful API doc type IDs (v2 endpoint)

Used as a query param on `/v2/transactions?transactionTypeId=<n>` (see [orderful-api-quirks.md](orderful-api-quirks.md) for endpoint context). The API returns a numeric `id` plus a string `type` name; the table below records pairs observed in the wild. Add to it as you encounter new values.

| `transactionTypeId` | Doc type | EDI standard label |
|---|---|---|
| 23 | `860_PURCHASE_ORDER_CHANGE` | Purchase Order Change Request — Buyer Initiated |

(Other doc types — 850, 855, 856, 810, 846, 940, 945, 997 — have their own numeric IDs. They're discoverable empirically by filtering on the partner relationship in the Orderful UI and reading the `transactionTypeId` from the URL. If you discover a new one in a session, **add it here in your PR**.)

## `customrecord_ord_tran_document` — NetSuite SuiteApp doc type IDs

A NetSuite custom list ID stored on `customrecord_orderful_transaction.custrecord_ord_tran_document`. Don't confuse with `transactionTypeId` above — these are *different* numbering systems even though they cover the same EDI doc types. Observed values:

| `custrecord_ord_tran_document` | `BUILTIN.DF()` label |
|---|---|
| 1 | 850 Purchase Order |
| 2 | 855 Purchase Order Acknowledgment |
| 9 | 846 Inventory Advice |

(Other values exist in the underlying custom list — contribute them back here as you confirm them.)

To enumerate all values in your environment:

```sql
-- The custom list itself isn't reliably queryable as a table, but you can sample observed values:
SELECT DISTINCT custrecord_ord_tran_document,
       BUILTIN.DF(custrecord_ord_tran_document) AS label
FROM customrecord_orderful_transaction
ORDER BY custrecord_ord_tran_document
```

(SuiteQL on `customrecord_orderful_transaction` tolerates `DISTINCT` here even though `GROUP BY` with aggregates is rejected.)

## `customlist_orderful_lineitem_ack` — 855 line ack status

The custom list backing `custcol_orderful_item_ack_status` on transactionline (Sales Order line). Set this value when acknowledging a 850's line items via 855. The list's `scriptid` mirrors the standard X12 855 POC02 / ACK01 codes, which makes the mapping nearly mechanical when you're translating from an inbound 860's POC02 to the outbound 855 line ack.

| `id` | `name` | `scriptid` (matches 855 EDI code) | When to use |
|---|---|---|---|
| 1 | Accept | `IA` | Item accepted, no change. The default. |
| 2 | Accept (Quantity Change) | `IQ` | Item accepted, but qty changed from what the 850 requested. |
| 3 | Accept (Date Rescheduled) | `DR` | Item accepted, ship date pushed. |
| 4 | Accept (Price Change) | `IP` | Item accepted, but unit price differs from the 850. |
| 5 | Reject | `IR` | Item rejected — won't ship. |
| 6 | Backorder | `IB` | Item backordered. |

Verify in your environment with:

```sql
SELECT id, name, scriptid, isinactive
FROM customlist_orderful_lineitem_ack
ORDER BY id
```

## 860 POC02 — Change or Response Type Code

The 860 (PO Change) message's `POC` segment, position 02, communicates the *kind* of change the buyer is requesting per line. These are X12-standard codes; not every partner uses every code, and partner-specific JSONata may rewrite them.

| Code | Meaning | Practical interpretation |
|---|---|---|
| `AI` | Add Item | New line item being added to the existing PO. |
| `AC` | Accept Item with Changes | (Used in some flows; effectively a confirmation with diffs.) |
| `CA` | Cancel | The whole order or a specific line is cancelled. |
| `CC` | Cancel Item | Cancel this specific line. |
| `DI` | Delete Item | Remove this line from the PO. Often pairs with `quantity=0`. |
| `DR` | Date Range Change | Reschedule (delivery window changed). |
| `IQ` | Item Quantity Change | (Buyer-side mirror of the 855 IQ ack code.) |
| `PC` | Price Change | Unit price changed. |
| `QC` | Quantity Cancel | Reduce quantity (sometimes specifically a partial cancel). |
| `QD` | Quantity Decrease | New qty is less than original. |
| `QI` | Quantity Increase | New qty differs from original (despite the name, observed used for both increases and decreases — read `quantity` vs `quantity1`). |
| `RS` | Reschedule | Reschedule the line. **`RS` with `quantity=0` is ambiguous** — different partners use it for cancel-this-window, push-out-to-later, or reject. Don't assume cancel without confirming with the partner. |
| `IR` | Item Rejected | Buyer rejecting an earlier acceptance. Rare on inbound 860; more common on 855. |

When decoding a `POC` segment, the relevant fields are:

| JSON field (Orderful parsed shape) | EDI position | Meaning |
|---|---|---|
| `assignedIdentification` | POC01 | Line ref (matches PO1 line# from the 850) |
| `changeOrResponseTypeCode` | POC02 | One of the codes above |
| `quantity` | POC03 | **New** quantity |
| `unitOrBasisForMeasurementCode` | POC04 | UOM (e.g. `EA`) |
| `unitPrice` | POC05 | Unit price |
| `quantity1` | POC06 | **Original** quantity (from the 850) |
| `productServiceIDQualifier` / `productServiceID` | POC07/08 | Item ID + qualifier |

So `code=QI, quantity=430, quantity1=600` reads as: *"Change line qty from 600 to 430."* And `code=DI, quantity=0` reads as: *"Delete this line."*

## POC02 → 855 ack-status decision matrix

When you've already established the 860's intended change has been applied (or you're choosing to accept it), this matrix maps the 860 POC02 → the 855 line ack code → the `customlist_orderful_lineitem_ack` id you write to `custcol_orderful_item_ack_status`:

| 860 POC02 | Apply qty/price/date change? | 855 ack code | `customlist_orderful_lineitem_ack` id |
|---|---|---|---|
| `QI`, `QD`, `QC` | yes — update line `quantity` | `IQ` | 2 |
| `PC` | yes — update line `rate` | `IP` | 4 |
| `DR` | yes — update line `expectedshipdate` (or partner-specific date field) | `DR` | 3 |
| `DI`, `CC`, `CA` | yes — close line / set qty=0 | `IR` | 5 |
| `RS` (with non-zero qty + a new date elsewhere) | yes — apply the reschedule | `DR` | 3 |
| `RS` (with `quantity=0`, no clear new date) | **ambiguous — confirm with partner before any action** | — | — |
| `AI` | yes — add new line | `IA` (on the new line) | 1 |
| `AC` | accept as-is | `IA` | 1 |

## `referenceIdentifiers` interpretation

On a v2 or v3 Orderful transaction response, `referenceIdentifiers[]` decomposes into the X12 envelope numbers:

| `type` | Owner | What it is |
|---|---|---|
| `INTERCHANGE` | SENDER | ISA13 — interchange control number from the sender |
| `GROUP` | SENDER | GS06 — functional group control number |
| `TRANSACTION` | SENDER | ST02 — transaction set control number (per-document) |
| (same triplet) | RECEIVER | The receiver-side equivalents (when the partner pre-allocates these) |

These are useful when you need to correlate a 997 ack back to the document it acknowledges, or when a partner asks "did you receive ICN 731822835?".
