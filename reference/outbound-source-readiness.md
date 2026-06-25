# Outbound source-record readiness

Factual checklist for confirming a NetSuite source record can drive a clean outbound EDI document **before** you transform/fire it. Each outbound doc is generated from a specific source record; if that record is missing attributes, the SuiteApp either errors (loudly or with a misleading message) or emits a structurally incomplete message that the partner guideline rejects downstream.

Run the relevant section as a pre-flight. Procedure lives in the per-doc skills ([`build-mock-fulfillments`](../skills/build-mock-fulfillments/SKILL.md), [`bill-and-fire-810`](../skills/bill-and-fire-810/SKILL.md)); this file is the lookup.

## 856 — source: Item Fulfillment (from a Sales Order)

| Check | How to read it | Failure symptom if missing |
|---|---|---|
| SO approved / fulfillable | `BUILTIN.DF(status)` = `Pending Fulfillment` | transform refused |
| Single ship route | `isMultiShipTo` (SO REST record) is `false`, or you fulfill per ship group | multi-ship-to → transform selects 0 lines → `"You must enter at least one line item for this transaction."` |
| Line locations | `transactionline.location` set on every shippable `InvtPart` line | line not fulfillable; 856 Ship-From wrong/empty |
| Inventory | `transactionline.quantitycommitted` > 0, or `aggregateItemLocation.quantityonhand` > 0 at the line location | nothing to ship |
| Ship-to address | `GET /record/v1/salesOrder/{id}/shippingAddress` returns `addr1`/`city`/`state`/`zip` | empty `N1*ST` address on the 856 |
| Items + units | line `item` resolved, `units` set | broken LIN/SN1 loop |
| Packing source | carton records (`customrecord_orderful_carton` + `customrecord_orderful_shipped_item`) OR a configured dataset (`custentity_orderful_pkg_data_src`) | generator hard-errors `"None of the following item fulfillments have cartons: <ifId>"` |

Notes:
- The REST `!transform/itemFulfillment` does not auto-select lines — pass `item.items[].itemreceive = true` per line, referencing the SO line `uniquekey` as `orderLine`.
- `isMultiShipTo = true` is a common artifact of the inbound 850→SO mapping (lines split by shipping method, same destination). If logically single-shipment, PATCH `isMultiShipTo = false` before transforming.
- The 856 trigger is `custbody_orderful_ready_to_process_ful` on the IF.

## 810 — source: Invoice (from a Sales Order)

| Check | How to read it | Failure symptom if missing |
|---|---|---|
| SO billable | `BUILTIN.DF(status)` = `Pending Billing` | `!transform/invoice` refused |
| Customform mandatory fields | the transform inherits the SO customform's mandatory rules | `400 "Please enter value(s) for: <field>"` on transform |
| Terms / totals | auto-applied from customer; verify against historical invoices | wrong ITD / BIG totals |
| DC / order-number custbody | `custbody_orderful_*_dc_number`, `custbody_orderful_cust_order_num` where the customer's pattern uses them | missing REF/N1 detail the partner expects |
| Invoice handling pref | `custentity_orderful_inv_handling_prefs` on the parent customer | **unset → 810 outbound never fires** (silent) |

Notes:
- The 810 trigger is `custbody_orderful_ready_to_process_inv` on the Invoice.

## 855 — source: Sales Order

| Check | How to read it | Failure symptom if missing |
|---|---|---|
| SO saved with ack-eligible status | per the customer's PO-ack handling pref | 855 doesn't fire |
| PO-ack handling pref | `custentity_orderful_poack_handling_prefs` on the parent customer | 855 gen gated / never fires |
| Line ack status | `custcol_orderful_item_ack_status` per line | wrong ACK line detail |

## Cross-cutting

- **Outbound handling prefs gate whether the MR fires at all.** `custentity_orderful_poack_handling_prefs` (855), `custentity_orderful_asn_handling_prefs` (856), `custentity_orderful_inv_handling_prefs` (810). An unset pref silently prevents the corresponding outbound — check it before assuming a mapping problem.
- **`custrecord_edi_enab_trans_auto_send_asn`** on the doc-type ECT row must be `T` for auto-send.
- **A populated source attribute is necessary but not sufficient.** Even a complete source record can produce an `INVALID` message if the partner guideline requires qualifiers the SuiteApp default doesn't emit — that's a mapping problem, not a readiness gap. See [`writing-outbound-jsonata`](../skills/writing-outbound-jsonata/SKILL.md).
