# AAFES DSCO EDI Reference

Reference data for AAFES (Army & Air Force Exchange Service) EDI via the DSCO/Rithum dropship path. Compiled from live transaction analysis and a dropship-vendor onboarding (May–July 2026). 846 inventory feed setup, the 846 rule set, the 856 TD5 carrier placement, and the Orderful rules-engine gotchas were added July 2026 — see [`orderful-rules-engine.md`](orderful-rules-engine.md) for the rules-engine mechanics referenced below.

## Three AAFES EDI Paths

| Path | ISA ID | EDI Account ID | Org ID | Use Case |
|------|--------|----------------|--------|----------|
| Direct AAFES | `001695568GP` | 197 | 268 | Traditional retail/wholesale vendors |
| DSCO/Rithum (dropship) | `DSCOAAFES` | 15749 | 268 | Dropship vendors routed through Rithum |
| VendorNet/Radial (dropship) | `VNEXCHANGE` | 5375 | 268 | Dropship vendors routed through Radial |

**All three paths are actively used** as of May 2026. Always confirm which path the customer uses before building anything.

## DSCO Path — Transaction Set

All live DSCO vendors trade the same 5 transaction types:

| TX Type | System Name | Direction | Guideline ID | Version |
|---------|-------------|-----------|-------------|---------|
| 850 | `850_PURCHASE_ORDER` | Inbound (from AAFES) | 146778 | 5010 v4.4 |
| 856 | `856_SHIP_NOTICE` | Outbound (to AAFES) | 146867 | 4010 v4.4 |
| 810 | `810_INVOICE` | Outbound (to AAFES) | 146865 | 4010 v4.4 |
| 846 | `846_INVENTORY_INQUIRY_ADVICE` | Outbound (to AAFES) | 146780 | v4.4 |
| 870 | `870_ORDER_STATUS_REPORT` | Outbound (to AAFES) | 146823 | 4010 v4.4 |

**855 is NOT used on the DSCO path.** Zero live vendors trade 855 via DSCO. Generic templates exist (146594, 146595) but are unused.

## Live DSCO Vendors (as of May 2026)

| Vendor | 850 | 856 | 810 | 846 | 870 |
|--------|-----|-----|-----|-----|-----|
| Vendor A | Live | Live | Live | Live | Live |
| Vendor B | Live | Live | Live | Live | Live |
| Vendor C | Live | Live | Live | Live | Live |

## DSCO 850 Structure

DSCO 850s are structurally different from direct AAFES 850s. Key differences:

### ISA Envelope
- Sender: `ZZ/DSCOAAFES` (not `001695568GP`)
- Receiver: `ZZ/<customer_ISA>`
- Usage indicator: `T` (test) or `P` (production)

### 15 REF Segments (DSCO metadata)
```
REF*IA*<vendor_id>                              — AAFES vendor number
REF*ZZ*<channel>*channel                        — Sales channel
REF*ZZ*<0|1>*test_flag                          — Test indicator
REF*ZZ*<0|1>*gift_wrap_flag                     — Gift wrap
REF*ZZ*<dsco_order_id>*dsco_order_id            — DSCO order identifier
REF*ZZ*<status>*dsco_order_status               — Order status (sending/etc.)
REF*ZZ*<lifecycle>*dsco_lifecycle                — Lifecycle stage (created/etc.)
REF*ZZ*<retailer_id>*dsco_retailer_id           — DSCO retailer ID
REF*ZZ*<supplier_id>*dsco_supplier_id           — DSCO supplier ID
REF*ZZ*<supplier_name>*dsco_supplier_name       — Supplier company name
REF*ZZ*<trading_partner_id>*dsco_trading_partner_id — DSCO TP identifier
REF*ZZ*<datetime>*dsco_create_date              — ISO 8601 create timestamp
REF*ZZ*<datetime>*dsco_last_update_date         — ISO 8601 last update
REF*CO*<consumer_order>*consumer_order_number   — Consumer-facing order number
REF*ZZ*<ship_code>*ship_service_level_code      — Shipping service code (e.g., FEHD)
```

### Ship-To
DTC (direct-to-consumer) — ship-to is the consumer's home address, NOT a store or DC. N1*ST segment contains consumer name and residential address.

### Carrier
FedEx Home Delivery (`FEHD`) is the standard. TD5 segment contains carrier details with `identificationCode: "FedEx"` and `routing: "Home Delivery"`.

### Item Qualifiers
PO1 lines use 5 product ID qualifiers:
- `SK` — SKU (customer's internal SKU)
- `UP` — UPC (13-digit GTIN)
- `MG` — Manufacturer part number (vendor style)
- `PD` — Product description
- `EM` — Catalog/exchange number

### Pricing
CTP loop contains retail price (`priceIdentifierCode: "RTL"`, `classOfTradeCode: "GR"`). PO1 `unitPrice` is cost/wholesale.

## DSCO 856 ASN (Simplified)

Required fields only:
- PO Number (PRF01)
- Ship Date (DTM*011)
- Shipping Service Level (TD508)
- Tracking Number (REF*CN)
- Ship-From Name + Address (N1/N3/N4)
- SSCC Barcode (MAN*GM) — drop-shippers can use Customer Order Number instead
- Line Item SKU (LIN03)
- Line Item Quantity (SN102)

**NOT required:** N1*BY, N1*Z7, ship-to address, conditional Tare/Pack HL.

### 856 TD5 carrier placement (outbound)

`FEHD` (FedEx Home Delivery) is a shipping **service-level code**, and on the outbound 856 it belongs in the TD5 **`locationIdentifier`** element — that element is enum-validated and `FEHD` is a valid code there. The **`identificationCode`** element is the **carrier name** (FedEx / UPS / USPS), free-text. **Do NOT put `FEHD` in `identificationCode`** — it will pass validation (free-text) but is semantically the carrier field set to a service code.

AAFES confirmed (via the customer) that **all** shipments transmit with service code `FEHD` even when the real carrier is USPS/Stamps.com. So force `locationIdentifier = "FEHD"` and keep `identificationCode` = the real carrier. The SuiteApp's `generateShipmentHL` pre-populates the TD5 from `customrecord_orderful_shipping_service` (service SCAC → `identificationCode`, service-level code → `locationIdentifier`, name → `routing`), keyed on the ship method — so either map every RF-SMART/ship method's service-level to `FEHD`, or force `locationIdentifier` via JSONata (sandbox) / an Orderful rule (prod).

## DSCO 810 Invoice (Strict)

AAFES via DSCO rejects invoices with extra fields. Send ONLY the required fields:
- Must include ship-to (N1*ST with full address) — this goes on the 810, NOT the 856
- Do not send additional fields beyond what the guideline specifies

## Reference 850 Transaction

Template transaction: Vendor C → AAFES DSCO, TX 900000000, May 2 2026, ACCEPTED.
Used as the template for the Northwind Apparel test 850 (TX 900000000).

## AAFES Compliance

- **$150** per "ASN sent but data download is missing/inaccurate"
- **$150** per "ASN not received at time of induction requiring manual processing"
- **$150** per "canceling carrier after dispatched for pickup"
- One vendor received **$7,148.50** in compliance charges in a single billing cycle

## Rithum Coordination

- Partner setup contact: `dscopartnersetup@rithum.com`
- Customer does NOT contact AAFES directly for EDI setup
- Orderful coordinates with Rithum, Rithum coordinates with AAFES
- Must register Orderful as the customer's EDI provider with Rithum

## DSCO 810 Invoice Deviations (Guideline 146865)

AAFES via DSCO is the strictest 810 spec we've seen. The default SuiteApp mapper output must be trimmed:

| Deviation | JSONata action |
|-----------|---------------|
| `referenceInformation` (PO/VN/CO) | Drop — not allowed |
| `N1_loop` | ST-only — drop BT/SF/RI party loops |
| `IT1.basisOfUnitPriceCode` | WE → QT |
| `SAC_loop` | Drop — H850 not allowed; AAFES is merchant of record |

Validated on Northwind Apparel (May 2026): 810 TX 900000000, JSONata v2, VALID.

## AAFES DSCO 846 Inventory Feed

Production inventory to AAFES/DSCO is a scheduled **846 EDI** feed (guideline 146780) — not the 2-column CSV, which is only the portal-onboarding bootstrap. All live DSCO vendors send 846s to `DSCOAAFES`; `source` shows as `APIV3` (the SuiteApp POSTs the 846 to Orderful's v3 API) or `EDIJOBS` (a scheduled file job), on a daily-to-hourly cadence.

### Turning on the 846 (NetSuite SuiteApp)

The 846 is **not** transaction-driven (no IF/Invoice). The SuiteApp generates it from a saved search (or analytics dataset) configured on the **Customer record** (the trading-partner customer), fired by a scheduled MapReduce.

1. **Customer-record fields** (on the AAFES trading-partner customer). These live on the Customer *form* — when empty they don't surface in SuiteQL, and they are **not** on the ECT or the script deployment:
   - `custentity_orderful_inv_advice_search` — "Inventory Advice Search" (a saved search), **or**
   - `custentity_orderful_inv_advice_dataset` — "Inventory Advice Dataset Script Id" (an analytics dataset). Use one, not both.
   - `custentity_orderful_inv_advice_per_loc` — "Send Per Location".
2. **Saved-search / dataset column contract** — exact labels, all **internal IDs** (not SKUs):
   - `ITEM` — item internal ID
   - `AVAILABLE` — quantity available
   - `LOCATION` — inventory Location internal ID

   The SuiteApp derives the UPC/SKU EDI qualifiers from the item record, so the search only needs the internal item id. The `inventorybalance` SuiteQL table exposes `item` / `quantityavailable` / `location` as the source. Filter to the partner's catalog items (and the right fulfillment location) — don't dump the whole item master (an unfiltered feed can be tens of thousands of rows).
3. **Generator:** `customscript_orderful_inventory_adv_mr` ("Orderful Inventory Advice Handler", MapReduce; deployment `customdeploy_orderful_inventory_adv_mr`). **Not Scheduled by default** — use **Save & Execute** on the deployment to test, then set a recurring schedule (hourly/daily) for production. `customscript_orderful_outbound_sending` must also be scheduled for delivery.

### AAFES DSCO 846 rule set (guideline 146780)

The SuiteApp's default 846 output diverges from the AAFES DSCO 846 spec in several places. These were fixed as Orderful platform **rules** on the vendor's outbound 846 relationship (per-path expressions — see [`orderful-rules-engine.md`](orderful-rules-engine.md) for the mechanics/gotchas):

| # | Path (Orderful) | Fix (function) |
|---|---|---|
| 1 | `…beginningSegmentForInventoryInquiryAdvice.*.reportTypeCode` | set `"MM"` |
| 2 | `…beginningSegmentForInventoryInquiryAdvice.*.time` | SuiteApp emits 4-digit `HHmm`; guideline needs 6-digit `HHMMSS` → `concatenate(time, "00")` |
| 3 | `…LIN_loop.*.itemIdentification.*.productServiceIDQualifier` | set `"SK"` (when SKU present) |
| 4 | `…LIN_loop.*.itemIdentification.*.productServiceIDQualifier1` | set `"UP"` (when UPC present) |
| 5 | `…LIN_loop.*.itemIdentification.*.productServiceID1` | copy `productServiceID2` (UPC) into the pair-2 value slot |
| 6 | `…LIN_loop.*.currency.*.entityIdentifierCode` | set `"SE"` |
| 7 | `…LIN_loop.*.productItemDescription.*.description` | truncate to 80 |
| 8 | `…LIN_loop.*.dateTimeReference` | **delete** (not allowed at line level) |
| 9 | `…LIN_loop.*.QTY_loop.*.SCH_loop` | **delete** (see "available shows as on-order" below) |

The available quantity itself is correct in `QTY*33` (Quantity Available) plus the per-warehouse `LS_loop → REF*WS` description — leave those.

> **Note on the `time` fix:** `formatDate(time, "HHMM", "HHMMSS")` is a trap — Orderful's `formatDate` uses moment tokens where `MM` = month, so it fails whenever the minutes are > 12 (it only *looks* fine when minutes ≤ 12). Use lowercase `mm`, and prefer `concatenate(time, "00")` since `formatDate` doesn't reliably pad seconds. See [`orderful-rules-engine.md`](orderful-rules-engine.md).

### Warehouse code (REF*WS) must be a registered DSCO warehouse

The `REF*WS` warehouse code comes from the NetSuite **Location name**. It must be:
- a **bare code** (e.g. `DFW`), not a descriptive location name (e.g. `"<Company> AAFES DFW"`) — fix at source by renaming the NS location; and
- **registered as a warehouse in the DSCO/Rithum portal**, or DSCO's *application-level* import fails with `Unknown warehouse code "<x>" found, please create it.`

This app-level import error is **separate from the EDI 997 ack** — a transaction can show `acknowledgmentStatus: ACCEPTED` (997) while DSCO's inventory import still rejects it on an unknown warehouse code.

### 846 gotcha: available quantity shows as "quantity on order"

If DSCO reports the available quantity under **Quantity on Order** (with a stray `estimated_availability_date`), the cause is the `SCH_loop` (rule #9). The SuiteApp emits an `SCH_loop` (line-item schedule) on **every** item duplicating the available qty with `dateTimeQualifier 018` + a date; DSCO reads a scheduled-quantity-with-a-date as *incoming/on-order* stock. The guideline marks `SCH_loop` **conditional** — "used only if the item is out-of-stock or discontinued." Deleting the `SCH_loop` makes the qty report as **available**. (Proper long-term fix: the SuiteApp should only emit `SCH` when available = 0 with a real restock date.)

## AAFES 820 Remittance Advice

AAFES offers an **820 Remittance Advice** through its electronic-payment (FEDI) program — **separate from the DSCO dropship channel**. Two things gate whether Orderful is even in the path:
1. Does AAFES send it as **true EDI 820** (received in Orderful) or as **bank/ACH remittance** (arrives via the bank, never touches Orderful)? Confirm with AAFES AP.
2. The 820 spec/version.

The Orderful **NetSuite SuiteApp does not process the 820 natively** — it's a "Process as Custom" doc type (see `custom-process-transactions`). Auto-applying AAFES payments against invoices is a **custom inbound build** (820 → NetSuite Customer Payments applied to open invoices, matched on the RMR invoice reference), not a toggle. Get a sample 820 to scope it.

## Roundtrip Validation (Northwind Apparel, May 2026)

Full E2E sandbox roundtrip achieved:
- 850 (900000000) → SO 74400000 → IF 74400000
- 856 (900000000, JSONata v6) — VALID
- 810 (900000000, JSONata v2) — VALID

### Full DSCO Portal Testing (May 18, 2026)

All 15 portal steps completed with 12 DSCO test orders:
- **850 inbound** → NetSuite sales orders created successfully
- **856 shipment** → working after comm channel fix (was pointing to wrong AS2 destination)
- **870 cancellation** → generated via Orderful API (not NS-native workflow)
- **Partial fulfillment** → multi-line order partially shipped successfully
- **810 invoice** → completed during session
- **Returns** → handled manually in DSCO UI (no EDI return document)

Partnership 7000002 status: Setup=Complete, Testing=Complete, GoLive=InProgress. All 10 relationships READY. Go-live: June 15, 2026.

### Communication Channel Gotcha

The outbound communication channel was initially pointing to the wrong AS2 destination. a teammate identified the issue and updated the relationship to the correct **"disco rhythm"** channel. Outbound testing failed at delivery until this was fixed. **Always verify the outbound comm channel matches the DSCO/Rithum AS2 destination before testing.**

## Transformation Status

As of May 2026:
- Guideline 146778 (850 inbound): **53 schema gaps**, saved as Draft, NOT published
- This means inbound 850 JSONata for NS requires manual work
- **However:** a teammate successfully processed test 850 through NS despite the gaps — the SuiteApp's inbound flow worked for the test transaction

## Rithum/DSCO Portal (15 Steps)

See the `dsco-portal-onboarding` skill for the full step-by-step guide.

Rithum requires 15 portal steps: setup (1–5), inventory (6–7), test orders (8), acknowledgement with AS2 (9), shipping (10), cancel (11), multi-line ship (12), invoice (13), returns (14), next steps (15).

### AAFES-Specific Overrides

AAFES provides custom templates that override generic DSCO instructions:
- **Inventory (portal-onboarding bootstrap only):** during DSCO portal steps 6–7 you seed a few test items with a 2-column CSV (`sku`, `quantity_available`). **This is a testing bootstrap, NOT the production feed.** Production inventory is a real, scheduled **846 EDI** feed — see [AAFES DSCO 846 Inventory Feed](#aafes-dsco-846-inventory-feed) below. (An earlier version of this doc wrongly said AAFES inventory is "2-column CSV, NOT 846 EDI" — that conflated the portal bootstrap with the production feed. All live DSCO vendors send production 846s.)
- **Shipment:** AAFES-specific 856 template — NOT generic DSCO instructions
- Always check for "Download AAFES Specific Template" links in the AAFES note box

### AS2 Connection

- AS2 is **NOT available by default** — must call Rithum support (844-482-4357 → DSCO support → DSCO onboarding) to enable
- Use the shared **"Rhythm AS2"** connection in Orderful (same cert used by another customer, etc.)
- ISA ID must be exactly 15 characters

### Automation Jobs

Two jobs required in DSCO portal:
1. **Orders** (Export) — pulls 850s from DSCO to Orderful. Source Data must be "All retailers" (default excludes test orders).
2. **Outbound** (Import) — sends 856/810 from Orderful to DSCO. Filename: `*` (wildcard). Generate 997: checked.

### Rithum Support

| | Details |
|---|---------|
| Phone | **844-482-4357** |
| Menu | DSCO support → DSCO onboarding |
| Hours | Until 6PM ET |
| Tip | Create ticket first, then call and reference it |

## Outbound Delivery: Communication Channel Required

**All outbound relationships (856, 810, 846, 870) must have a communication channel assigned or delivery fails silently.** Transactions pass validation (VALID) but show `deliveryStatus: FAILED`.

**For testing:** Use the "Keep In Orderful" channel (`destinationTypeName: "nowhere"`, auto-provisioned on every org). Assign via:

```
PATCH /v2/document-relationships/<rel_id>
{"config": {"communicationChannelSettings": [
  {"stream": "test", "communicationChannelId": <channel_id>},
  {"stream": "live", "communicationChannelId": <channel_id>}
]}}
```

**For production:** Replace with DSCO/Rithum's actual delivery endpoint. Coordinate with `dscopartnersetup@rithum.com`.

**Resend failed transactions:** `POST /v2/transactions/<tx_id>/send` with `{"requesterId": <org_id>}`.

## Known Platform Issues

1. **856 conditional HL validation gap** — Travis Thorson (Dec 2022): direct AAFES requires Tare/Pack HL conditional validation. Not applicable to DSCO path.
2. **Vendor A 846 overdue** — Production monitoring error running 6+ weeks (March–May 2026).
3. **Loomcraft 856 ASN broken** — Org hierarchy interfering with document creation (April–May 2026, unresolved).

## NetSuite Workflow Conflicts (Legacy SPS Commerce)

Customers migrating from SPS Commerce may have active workflows that break EDI order processing. Found on Northwind Apparel:

| Workflow | Problem | Fix |
|----------|---------|-----|
| "Set Default Order Variables" | References `shipaddressee` field — if missing in sandbox, blocks all SO saves | Exclude EDI/dropship orders or add the field |
| "[Sales Order] Magento Discount" | Auto-sets RB Status to "Hold: Other" on orders with Magento Order # | Exclude EDI orders — DSCO populates this field |
| "SPS Invoice Automation Workflow" | Sets SPS Integration Status to "Ready" 1hr after invoice creation | Disable for Orderful customers — invoices go through Orderful, not SPS |

**Lesson:** Always audit the customer's existing NS workflows before processing EDI orders. Filter Workflows by Record Type = Transaction, check for anything touching Hold/Status fields.

## Inventory Allocation

NetSuite inventory allocation is **manual** for EDI/dropship workflows. Cannot commit inventory via the REST API.

- **Sandbox testing:** Pre-create large inventory quantities (999 units) so orders proceed without manual allocation.
- **Production:** Customer's DC team handles allocation through their normal pick/pack/ship workflow.

## Confluence Reference

[AAFES EDI Onboarding Detail](https://orderful.atlassian.net/wiki/spaces/NT/pages/4179623948) — Network Team canonical guide. Read this for the full onboarding process.
