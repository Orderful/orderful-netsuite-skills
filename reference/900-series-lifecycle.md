# 900-Series Transaction Lifecycle — NetSuite perspective

900-series EDI documents are warehouse/3PL-facing (not trading-partner-facing). They tie to **Vendor** records (the 3PL is a vendor) and **Location** records (the warehouse). They produce **Item Fulfillments** and **Item Receipts** on existing NS transactions, rather than creating Sales Orders the way an 850 does.

Use this reference when scoping a custom-process script for 940 / 943 / 944 / 945 to confirm:
- Which NS transaction the script reads from or writes to
- Which 3PL is on which side of the flow
- What downstream EDI the SuiteApp will fire automatically vs. what your script has to handle

---

## EDI 940 — Warehouse Shipping Order (outbound)

Instruction to a 3PL: pick, pack, ship.

### Case 1: from Sales Order
- SO created in NetSuite (often from an inbound 850, but any source works).
- SO `location` = the 3PL warehouse location.
- Custom script generates 940 from the SO → SuiteApp sends to 3PL.
- 3PL picks, packs, ships to the end customer (the trading partner on the SO).
- 3PL sends back **945**.

### Case 2: from Transfer Order
- TO created in NetSuite: from 3PL A location → 3PL B location.
- Custom script generates 940 from the TO → SuiteApp sends to 3PL A.
- 3PL A picks, packs, ships to 3PL B.
- 3PL A sends back **945**.

---

## EDI 945 — Warehouse Shipping Advice (inbound)

3PL's confirmation that goods have shipped. Always creates an **Item Fulfillment** on the source NS transaction.

### Case 1: SO 945
- 3PL confirms shipment against the Sales Order.
- Custom script creates an Item Fulfillment on the SO.
- Maps cartons, pallets, items, quantities, SSCC18, lot numbers, tracking numbers.
- Sets dates, bill of lading, carrier, weight.
- IF creation triggers **856** (Advance Ship Notice) generation back to the trading partner.

### Case 2: TO 945
- 3PL A confirms shipment against the Transfer Order.
- Custom script creates an Item Fulfillment on the TO.
- Maps cartons, pallets, items, quantities, SSCC18, lot numbers, tracking numbers.
- Sets dates, bill of lading, carrier, weight.
- IF creation triggers **943** generation to 3PL B.

---

## EDI 943 — Warehouse Stock Transfer Shipment Advice (outbound)

Notification to the *receiving* 3PL that a shipment is on its way.

### Case 1: from TO Item Fulfillment (post-945)
- Flow: TO → 940 to 3PL A → 3PL A ships → 945 back → IF created on TO → **943 generated** → sent to 3PL B.
- 943 tells 3PL B what to expect: items, quantities, container / shipment reference.
- 3PL B receives the goods and sends back **944**.

### Case 2: from Inbound Shipment / Purchase Order cycle (no 940)
- PO created with vendor → Inbound Shipment created in NetSuite.
- Custom script generates **943** from the Inbound Shipment → sent to the receiving 3PL.
- No 940 involved — this is a buying/receiving cycle, not a shipping cycle.
- Vendor ships goods directly to the 3PL warehouse.
- 3PL receives and sends back **944**.

---

## EDI 944 — Warehouse Stock Transfer Receipt Advice (inbound)

Receiving 3PL's confirmation that goods have arrived.

### Case 1: TO 944 (after 943 from TO)
- 3PL B confirms receipt of goods from the Transfer Order.
- Custom script creates an Item Receipt on the TO.

### Case 2: PO / Inbound Shipment 944 (after 943 from IS)
- 3PL confirms receipt of goods from the Purchase Order / Inbound Shipment.
- If the PO has an Inbound Shipment attached → custom script receives via the Inbound Shipment.
- If PO only (no IS) → custom script creates an Item Receipt directly from the PO.

---

## Full-cycle summaries

| Cycle | Flow |
|---|---|
| **SO cycle** (ship to customer) | `850 → SO → 940 → 3PL → 945 → IF → 856 → Customer` |
| **TO cycle** (3PL → 3PL transfer) | `TO → 940 → 3PL A → 945 → IF → 943 → 3PL B → 944 → IR` |
| **PO / IS cycle** (vendor → 3PL, no 940) | `PO + IS → 943 → 3PL → 944 → IR` |

---

## Quick lookup: which NS record does each script touch?

| EDI doc | Direction | Source / target NS record (script side) | Resulting NS state |
|---|---|---|---|
| 940 | Outbound | Reads from **SO** (Case 1) or **TO** (Case 2) | (none — 3PL acts on it) |
| 945 | Inbound | Updates **SO** (Case 1) or **TO** (Case 2) | Creates **Item Fulfillment** |
| 943 | Outbound | Reads from **TO Item Fulfillment** (Case 1) or **Inbound Shipment** (Case 2) | (none — receiving 3PL acts on it) |
| 944 | Inbound | Updates **TO** (Case 1) or **PO / IS** (Case 2) | Creates **Item Receipt** |

When the user asks for a 9xx custom-process script, **first confirm which Case applies**. Case 1 vs Case 2 changes the source NS record, the JSON lookup keys, and what downstream EDI fires automatically.
