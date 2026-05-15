# AAFES DSCO EDI Reference

Reference data for AAFES (Army & Air Force Exchange Service) EDI via the DSCO/Rithum dropship path. Compiled from live transaction analysis and the RuffleButts onboarding (May 2026).

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
| GIII Apparel Group | Live | Live | Live | Live | Live |
| Peak Design | Live | Live | Live | Live | Live |
| Vida Brands | Live | Live | Live | Live | Live |

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

## DSCO 810 Invoice (Strict)

AAFES via DSCO rejects invoices with extra fields. Send ONLY the required fields:
- Must include ship-to (N1*ST with full address) — this goes on the 810, NOT the 856
- Do not send additional fields beyond what the guideline specifies

## Reference 850 Transaction

Template transaction: Vida Brands → AAFES DSCO, TX 902487956, May 2 2026, ACCEPTED.
Used as the template for the RuffleButts test 850 (TX 909123876).

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

Validated on RuffleButts (May 2026): 810 TX 909433588, JSONata v2, VALID.

## Roundtrip Validation (RuffleButts, May 2026)

Full E2E sandbox roundtrip achieved:
- 850 (909123876) → SO 74458377 → IF 74458577
- 856 (909413586, JSONata v6) — VALID
- 810 (909433588, JSONata v2) — VALID

## Transformation Status

As of May 2026:
- Guideline 146778 (850 inbound): **53 schema gaps**, saved as Draft, NOT published
- This means inbound 850 JSONata for NS requires manual work
- **However:** Isaiah successfully processed test 850 through NS despite the gaps — the SuiteApp's inbound flow worked for the test transaction

## Rithum/DSCO Portal (15 Steps)

See the `dsco-portal-onboarding` skill for the full step-by-step guide.

Rithum requires 15 portal steps: setup (1–5), inventory (6–7), test orders (8), acknowledgement with AS2 (9), shipping (10), cancel (11), multi-line ship (12), invoice (13), returns (14), next steps (15).

### AAFES-Specific Overrides

AAFES provides custom templates that override generic DSCO instructions:
- **Inventory:** 2-column CSV (`sku`, `quantity_available`) — NOT 846 EDI
- **Shipment:** AAFES-specific 856 template — NOT generic DSCO instructions
- Always check for "Download AAFES Specific Template" links in the AAFES note box

### AS2 Connection

- AS2 is **NOT available by default** — must call Rithum support (844-482-4357 → DSCO support → DSCO onboarding) to enable
- Use the shared **"Rhythm AS2"** connection in Orderful (same cert used by Chewy, etc.)
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
2. **GIII 846 overdue** — Production monitoring error running 6+ weeks (March–May 2026).
3. **Amrapur 856 ASN broken** — Org hierarchy interfering with document creation (April–May 2026, unresolved).

## Confluence Reference

[AAFES EDI Onboarding Detail](https://orderful.atlassian.net/wiki/spaces/NT/pages/4179623948) — Network Team canonical guide. Read this for the full onboarding process.
