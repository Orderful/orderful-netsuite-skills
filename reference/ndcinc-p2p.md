# NDCINC P2P EDI Reference

Reference data for NDCINC (NDC, Inc.) EDI via the Procure-to-Pay (P2P) path. Compiled from live transaction analysis and the MARS Medical onboarding (May 2026).

## Overview

MARS Medical (Medical Application Repair & Sales) is a medical supply wholesaler buying from NDC, Inc. This is a P2P flow and the SuiteApp's first production P2P customer. MARS sends outbound 850s (Purchase Orders) and receives inbound 855/856/810 back. The standard SuiteApp handles Order-to-Cash (inbound 850, outbound 855/856/810) natively; P2P requires custom SuiteScript for every transaction type.

## Key Facts

| | MARS Medical | NDCINC |
|---|---|---|
| Org ID | 124676 | 41414 |
| Org Type | customer | tradingPartner (unclaimed) |
| EDI Account ID | 128085 | 40366 |
| ISA (live) | ORDFLMARSMEDIC | NDCINCPROD |
| ISA (test) | ORDFLMARSMEDICT | NDCINCTEST |
| Billing | INTEGRATED / ACTIVE (PAYS) | N/A (unclaimed) |
| ERP | NetSuite (account 5505603, prod only) | Unknown |
| Comm Channel | Poller (test: 68810, prod: 68811) | None (unclaimed) |

## NDCINC EDI Profile

NDCINC is an unclaimed trading partner with no API key and no comm channels at the org level. Connectivity is managed by NDCINC's own systems (AS2 to Orderful).

Non-standard X12 separators:
- Data element separator: ! (not the standard *)
- Segment terminator: ~
- Component element separator: >
- Data format: X12
- isSendAckEnabled: true (expects 997 functional acknowledgments)

The ! separator is configured on NDCINC's EDI account (id 40366). Orderful handles separator translation so MARS can send with standard * separators and Orderful converts to ! on delivery to NDCINC. Confirmed by Piers MacDonald (May 2026): should be fine as long as the EDI account is configured with the correct separators. Amelie Roux clarified: ingress accepts any separator, but the configured separator is used to generate the 997, and NDCINC's EDI tool may be strict about it.

## NDC AS2 Connectivity (Babelway)

NDC uses Babelway for AS2 connectivity. Details from Travita Dumas (May 13):

| Field | Value |
|---|---|
| Environment | NDC Inc / Test |
| AS2 Identity | BABELWAY_AS2_40672 |
| HTTPS URL | https://us1.babelway.net/corvus/httpd/as2/inbound |
| HTTP URL | http://us1.babelway.net/corvus/httpd/as2/inbound |
| IPs (firewall) | 52.5.32.55, 52.5.32.186 |
| Ports | 80 (HTTP), 443 (HTTPS) |
| Receipt Type | MDN |
| Receipt Signature | SHA256 |
| Delivery Mode | Synchronous or Asynchronous |
| Signing Algorithm | SHA256 |
| Encryption | ALG_3DES |
| Certificate | babelway as2 shared-40672.crt (expires 2027-05-07) |

**Action needed:** Orderful needs to provide AS2 details to NDC for connectivity testing. Logan previously told NDC that AS2 would be the communication protocol. Orderful handles AS2 — need to send Orderful's AS2 endpoint details to Travita.

## NDC 845 Test Scenarios (from Travita, May 13)

NDC wants to test 845 with these specific scenarios:

1. **New/Full contract — local type**: Header + Items + Eligible End Users
2. **New/Full contract — GPO type**: Header + Items + Eligible End Users
3. **Contract Change/Add/Delete — local type**: Header + Items + Eligible End Users
4. **Contract Change/Add/Delete — GPO type**: Header + Items + Eligible End Users

Key insight: NDC distinguishes between **local** contracts (direct between NDC and MARS) and **GPO** contracts (Group Purchasing Organization — where pricing comes through a GPO agreement). This affects the 845 NS contract structure we need to propose to Logan — it needs a contract_type field (local vs GPO).

NDC wants 846 tested before 845. During 845 testing they will validate all 4 scenarios above.

## Existing NDCINC Relationships

NDCINC is already LIVE with Dealmed.com (org 28549, EDI account 26743). Partnership id 33652, active since Nov 2024. Dealmed uses HTTP webhook comm channels (both test and prod).

This proves NDCINC's connectivity and EDI profile work. Any new customer integrating with NDCINC can reference the Dealmed relationship as a known-good baseline.

## Transaction Set

MARS to NDCINC relationships (all TEST status, autoSend ENABLED as of May 2026):

| Relationship ID | Direction | TX Type | System Name |
|---|---|---|---|
| 225935 | MARS to NDCINC | 850 | 850_PURCHASE_ORDER |
| 225932 | NDCINC to MARS | 855 | 855_PURCHASE_ORDER_ACKNOWLEDGMENT |
| 225934 | NDCINC to MARS | 856 | 856_SHIP_NOTICE_MANIFEST |
| 225930 | NDCINC to MARS | 810 | 810_INVOICE |
| 225941 | MARS to NDCINC | 867 | 867_PRODUCT_TRANSFER_AND_RESALE_REPORT |
| 225938 | NDCINC to MARS | 845 | 845_PRICE_AUTHORIZATION_ACKNOWLEDGMENT_STATUS |
| 225940 | NDCINC to MARS | 846 | 846_INVENTORY_INQUIRY_ADVICE |

Core P2P flow: 850 out, 855/856/810 in. The 867 (Product Transfer/Resale Report) is a standard medical distribution requirement. The 845 (Price Authorization) and 846 (Inventory) are confirmed in-scope by Logan (May 13).

Guideline set IDs (all 7 created and assigned as of May 12):

| TX Type | Guideline Set ID |
|---|---|
| 850 | 40440 |
| 855 | 40441 |
| 856 | 40442 |
| 810 | 40443 (updated to 198124) |
| 845 | 197986 |
| 846 | 198019 |
| 867 | 198085 |

## P2P in NetSuite: What Is Custom

The SuiteApp natively supports Order-to-Cash only:
- Inbound 850 creates Sales Order
- Outbound 855/856/810 generated from Sales Order / Item Fulfillment / Invoice

For P2P, the SuiteApp provides the connector framework (polling, sending, transaction records, diagnostics) but the business logic is custom:

| TX Type | Direction | Native | Custom Work Required |
|---|---|---|---|
| 850 | Outbound | No | Read NS Purchase Order, build 850 JSON, send via connector |
| 855 | Inbound | No | Poll, parse 855, update PO status in NS |
| 856 | Inbound | No | Poll, parse 856, create Item Receipt in NS |
| 810 | Inbound | No | Poll, parse 810, create Vendor Bill in NS |
| 867 | Outbound | No | Read NS data, build 867 JSON, send |
| 845 | Inbound | No | Poll, parse 845, update pricing/auth records |
| 846 | Inbound | No | Poll, parse 846, update inventory |

Implementation approach: Custom SuiteScript deployed via SDF (SuiteCloud Development Framework), authored with Claude. Each ECT record uses custrecord_edi_enab_trans_cust_process = T (custom-process mode) so the SuiteApp parks transactions in PendingCustomProcess status for the custom scripts to handle.

Estimated effort: 2-4 hours per transaction type for the custom script (per Isaiah Riesman-Tremonte). Abdallah (Lysi Consulting) is writing the scripts.

## Drop-Ship vs Stock: The Load-Bearing Design Decision

Discovered May 12, confirmed by Logan May 13. Analysis of MARS's NDC PO data from production NS:

| PO Type | Count (2024 YTD) | Share |
|---|---|---|
| Drop-ship (PO line linked to SO via `createdfrom`) | 45 | ~87% |
| Stock-to-warehouse (no linked SO) | 7 | ~13% |

This means 87% of MARS's NDC orders have goods going directly to MARS's customer — never touching MARS's warehouse at HQ.

### Logan's Confirmed Requirements (May 13, 2026 — updated May 14)

**Drop-ship (87%):** Use NS standard drop-ship completion flow tied to the linked Sales Order. Receive/complete the drop-ship PO and fulfill the linked SO. Zero inventory at Headquarters. "Mirror NetSuite's standard drop-ship process as closely as possible."

**Stock (13%):** Do NOT auto-create Item Receipt from 856 alone. Stage shipment data, notify MARS goods are inbound. Item Receipt created only after physical dock receipt confirmed by a human. No phantom inventory. Logan confirmed (May 14) the stock path is secondary — the warehouse handling of 856s and the lack of a natural NS home for pallet/carton data was his second biggest concern.

**⚠️ Carton/packaging data — RESOLVED May 14:**
- **Drop-ship:** Logan only cares about **tracking number** on the Item Fulfillment under Packages. Does NOT care about carton-level breakdown ("what's in each box"). Skip Orderful EDI Carton records — just write the tracking number to the IF Packages tab.
- **Stock:** Same — tracking on the IR line. No carton hierarchy preservation needed. The 856's full S/T/O/I structure flattens to line items + tracking.
- **Fields on IF Packages tab:** package weight, contents description, tracking number, carton number are all visible, but MARS only uses **tracking number**.

**Lot / serial numbers — clarified May 14:**
- Drop-ship orders are treated as lot-controlled, but NetSuite does **NOT require** lot and serial numbers on drop-ship orders, even when the item is lot- or serial-numbered.
- If lot/serial data is present in the 856, capture it. But the flow **must work even if those values are missing** — do NOT block on absent lot/serial.
- MARS does use NS native lot handling features, but NS doesn't enforce them in the drop-ship scenario.

**"VENDOR - NDC (VIEW ONLY)" location:** Deactivated. Was a virtual location for NDC inventory but would have required GL/accounting changes MARS didn't want. Do NOT use for receiving, drop-ship, inventory tracking, or 846 updates.

**Partial/multiple 856s:** One NS event per 856, linked to original PO. Stock = one staged/confirmed receipt per shipment. Drop-ship = complete the related drop-ship shipment/fulfillment per 856.

**Partial shipments/backorders:** Process shipped qty only. Do NOT hold for review solely because of partial/backorder. Only hold for unexpected items, substitutes, over-shipments, or matching failures.

## Confirmed Requirements by TX Type (Logan, May 13)

### 850 — Outbound Purchase Order
- **REF*8M vs REF*IA/IT:** MARS believes 723403 is their NDC account number, fits IA/IT (6 chars). Needs NDC confirmation whether 8M is the same or a separate company-level ID.
- **BEG02 routing:** DS when PO linked to SO (drop-ship), SA for stock. Drop-ship link to SO is the indicator.
- **N9*ZZ:** Unknown — needs NDC confirmation of expected value.

### 810 — Inbound Vendor Invoice
- **PO linkage:** Match via BIG04 PO number. No match = hold for manual review + alert. Do NOT create unlinked Vendor Bill.
- **Bill posting:** Create as draft Vendor Bill for AP review. Can revisit auto-post once trusted.
- **Item matching:** Primary = vendor code from Vendor Pricing tab on item record. MARS item number NOT useful. MPN/manufacturer part number as fallback needs NDC confirmation.
- **Fees/shipping/tax:** NDC bills include processing fees, shipping fees, and sometimes tax. NDC processing fees → MARS processing fees. NDC shipping → MARS shipping. Tax (if any) → shipping.
- **Price/qty discrepancies:** Hold for review. Do NOT auto-overwrite PO or force bill through.
- **Discount terms:** Capture if they map to NS terms; log for AP review if not. Do not ignore silently.
- **⚠️ May 14 update:** Team agreed to review **historical production vendor bills** in NS for guidance on output format. Logan confirmed historical bills exist. Match the Vendor Bill structure to what MARS already has in production — don't invent a new format.

### 855 — Inbound PO Acknowledgment

**⚠️ REVISED May 14, 2026 (live call with Logan + Isaiah).** Original design (May 13) was more complex. Team aligned on bare-minimum first pass:

- **Header status:** Single **custom free-text field** on PO header for 855 acknowledgement status. Logan agreed to create this field. No complex BAK02 status mapping for v1 — just join the 855 to the correct PO transaction, flag that an 855 was received, and show the status at header level.
- **No automation until real data:** Isaiah recommended doing the bare minimum now and avoiding automation until they have some months of real transaction data to base decisions on.
- **Rejection visibility:** Logan's main use case is knowing if a PO gets rejected. The free-text field covers this.
- **Qty/price mismatches:** Keep lightweight. Logan said he hasn't seen NDC send different qty/price than ordered. Expects backorders are more likely than quantity shortfalls. Let the customer team handle mismatches manually if they arise.
- **Re-acks / multiple 855s:** Latest 855 wins. Logan confirmed once he understood the 855 carries projected ship dates that can update. They want the latest value plus some indication of when it was updated.
- **Backorders/partials:** Do NOT hold for review. Let backordered qty remain on PO, flow through existing backorder reporting. (Unchanged from May 13.)

**Previous May 13 design (deferred, not deleted — may revisit after v1):**
- BAK02 header status mapping (AC/AD/RD/RJ → Acknowledged/Pending Review/Rejected)
- Line-level status field (`custcol_ndc_line_status`)
- Confirmed qty/price capture in separate columns
- Hold triggers: full rejection, price diff, non-backorder qty diff, substitute, match failure
- Email alerts as NS workflow on status change

### 845 — Inbound Price Authorization / Contract Pricing
- **Automation:** Logan wants full automation, not manual maintenance.
- **Contract awareness:** Logan didn't know NDC's 845 is contract-based. Asks US to propose the NS structure (custom fields, contract record, pricing sublist, scheduled job).
- **Target fields:** Item Purchase Price + Vendor Pricing tab → NDC price.
- **Effective dates:** Today/past = apply immediately. Future = stage/schedule for effective date.
- **Qty-break pricing:** Capture if NS supports; otherwise lowest-quantity tier as active price, log additional tiers.
- **Expired contracts:** Expect pricing to roll to new contract automatically. If expired with no replacement, alert — don't remove/rollback pricing.
- **Proposed contracts (PR):** Stage for review, do NOT update active pricing.
- **Data to capture:** Contract number, status, effective date, expiration date, item/vendor pricing, qty-break pricing.

### 846 — Inbound Inventory Advice
- **Target field:** `custitem_availability_ndc` confirmed.
- **Warehouse aggregation:** Sum across all NDC warehouses into existing text field. Structured breakdown later if needed.
- **Update cadence:** Overwrite on each 846 receipt + capture "last updated" timestamp.
- **Item matching:** Vendor code from Vendor Pricing tab (same as 810). MPN fallback needs NDC confirmation.
- **Missing items:** Log silently. Alert only if unmatched count exceeds threshold.

### 867 — Outbound Product Transfer/Resale Report
- **DI qualifier:** Use MARS NS invoice number (the invoice MARS issued to its customer).
- **Trigger:** Monthly, 1st of month, previous month. Generate + hold for human review first 1-2 months, then auto-send.
- **Zero-activity:** Stub only if NDC requires it, otherwise skip + log.
- **Existing report:** MARS currently uploads a report to NDC — will provide example as reference for 867 mapping.
- **DEA number:** Not used today but expanding soon. Logan will create custom field on customer record. Needs format guidance from us.
- **Member ID (1W):** Needs NDC confirmation.

### Testing Strategy
- 4-layer approach accepted by Logan: validate transforms → TEST stream → PendingCustomProcess staging → contained test POs.
- First real 856 against a real PO held as PendingCustomProcess until MARS confirms mapping.
- SuiteScript = Full permission will be granted (needs exact role name from us).
- **⚠️ May 14 update:** Testing happens in **production** (no sandbox). Biggest complication per Logan. Test transactions must be tracked and later deleted/cleared out. Logan will keep a record of test transaction numbers.
- **Drop-ship PO is the key test artifact.** Logan creating one in NS production. Will send PO# + linked SO#. This is the critical input for Abdallah to test the full P2P cycle.
- **Round-trip test plan:** Team has already done simulated round trips with Orderful responding as NDC would. Full round-trip testing depends on NDC being connected (AS2 setup pending).

## Script Status (updated May 14)

Core 4 custom SuiteScript built and deployed. Validated against NDC sample files and internally generated test samples. Scripts need updating to reflect May 14 simplifications before testing with Logan's drop-ship PO.

| TX Type | Script | Status | Notes |
|---|---|---|---|
| 850 | Outbound PO generation | Ready | Handles both standalone (SA) and drop-ship (DS linked to SO) |
| 855 | Inbound PO Ack processing | **Needs simplification** | Strip down to bare-minimum: join to PO, flag received, write status to free-text field. Remove complex BAK02 mapping and hold logic for v1 |
| 856 | Inbound ASN processing | **Needs simplification** | Drop-ship: write tracking number to IF Packages tab only. Remove carton/hierarchy logic. Lot/serial: capture if present, don't block if missing. Stock path deferred |
| 810 | Inbound Invoice processing | **Needs historical review** | Review production vendor bills first, then match output format. Core PO-match and draft Vendor Bill logic unchanged |

**Key blocker:** Logan creating a drop-ship PO in NS production. Once received (PO# + SO#), Abdallah can test the full round trip.

### 855 Design Detail — v1 (simplified May 14)

**v1 scope (agreed by Logan + Isaiah May 14):**
1. Join the 855 to the correct PO transaction
2. Flag that an 855 was received
3. Show the 855 status at header level (custom free-text field — Logan creating)
4. Latest 855 wins if multiple are received; include "last updated" indicator
5. No automation beyond this until they have months of real data

**Custom fields needed on PO (v1 — minimal):**

| Field | Type | Location | Purpose |
|---|---|---|---|
| TBD (Logan creating) | Free text | PO body | 855 acknowledgement status at header level |

**Deferred to v2 (original May 13 design — revisit after real-world data):**
- BAK02 → multi-value status mapping (AC/AD/RD/RJ)
- Line-level status field (`custcol_ndc_line_status`)
- Confirmed qty/price capture columns
- Automated hold triggers and downstream blocking
- Email alerts as NS workflow on status change
- 855 received date stamp

**Native PO status resolution:** Native NS PO statuses are computed and not directly writable for EDI ack states. Custom field is the source of truth. (Unchanged.)

## Items Awaiting NDC Confirmation

As of May 13, Logan sent an email to NDC (Travita Dumas) with these open items:

1. Test ISA setup confirmation
2. NDC EDI testing contact (answered: Travita Dumas, NDC EDI team)
3. REF*8M vs REF*IA/IT — are both 723403 or is 8M different?
4. N9*ZZ expected value
5. 856 hierarchical structure (**answered by sample: 0002 S/T/O/I**)
6. MPN/manufacturer part number matching support
7. 867 zero-activity report requirement
8. Member ID / DEA field requirements
9. 845 contract pricing setup requirements

## Items We Owe Back to Logan

1. ~~Can native NS PO status reflect EDI ack states?~~ **RESOLVED May 14** — agreed on custom free-text field instead. Logan creating it.
2. 845 NS contract structure recommendation (custom record, scheduled price job, fields) — **deferred to post-P2P**
3. 867 DEA field format guidance — **deferred to post-P2P**
4. Integration role name for SuiteScript = Full grant
5. 846 "last updated" timestamp field — create or identify — **deferred to post-P2P**
6. ~~810 Vendor Bill fee/shipping/tax NS field mapping~~ **RESOLVED May 14** — team will review historical production vendor bills and match that structure

## Items Logan Owes Us (as of May 14)

1. **Create a drop-ship PO in NetSuite production** — the main testing artifact Abdallah needs
2. **Email the PO number and linked Sales Order number** from the drop-ship PO
3. **Create the custom free-text field** for 855 status on PO header (if needed on their side)
4. **Track test transaction numbers** used in production so they can be cleared afterward

## NDC Testing Process (Travita Dumas, May 13)

NDC EDI contact: **Travita Dumas** (travita.dumas — confirmed via email to Ashwath, Logan, Mike, Isaiah, Abdallah, Selma)

Key points from NDC:
- **Sequence:** Core 4 first (850/855/856/810), then 845/846/867 in any order
- **850 product codes:** NDC requires their product code format: 3-alpha prefix + dash/space + numeric/alphanumeric (e.g., "NDC 1234"). Travita offered a list of recent products ordered.
- **Order types to test:** Regular, rush, and direct ship. Test every order type MARS plans to send.
- **Pass criteria:** Format, syntax, and validity. Contracts & Rebate team validates 845/846/867 separately (2-5 day turnaround).
- **997s mandatory both directions.** NDC sends 997 for everything they receive, expects 997 for everything they send.
- **Inbound specs:** NDC asked us to share our EDI specs for inbound documents. Flexible with mapping, uses X12 standard.
- **845 test scenarios:** Travita previously provided expected 845 test scenarios (need to locate — check Abdallah/Selma/Logan).
- **Sample test files provided** — stored at `~/orderful-onboarding/mars-medical/ndc-samples/`
- **Testing coordination:** NDC EDI team owns it. Duration dependent on MARS responsiveness.

## NDC Sample File Analysis (May 13, 2026)

Sample files provided by Travita Dumas. All use standard `*` separator (Orderful handles `!` conversion for delivery to NDC). Stored at `~/orderful-onboarding/mars-medical/ndc-samples/`.

### sample855.txt — PO Acknowledgment
- `BAK*00*AC*25830466*20260511` — Acknowledged with Changes
- Single line: `PO1*1*1*BX*405.75**VC*AAR 20-1080` — confirms 3-alpha + space + part format
- `ACK*IB*0*BX*068*20260511` — line status IB (Backordered), qty 0
- N1*ST only (ship-to)

### sample856.txt — Advance Ship Notice
- **Hierarchy confirmed: 0002 (S/T/O/I)** — HL codes S(Shipment), T(Tare/Pack), O(Order), I(Item)
- `TD1*PLT*2` — 2 pallets, 1011.99 lbs
- `TD5**2*AVRT` — carrier Averitt Express
- `REF*BM*01195619` — Bill of Lading
- `N1*SF` = NATIONAL DISTRIBUTION & CONTRACTING INC., LA VERGNE TN 37086
- `N1*ST` = CONCORDANCE HEALTHCARE, ID 000032
- `PRF*3604107***20260504` — PO reference
- `LIN*14*VC*NDC 13-5024*CB*1234567` — VC (vendor catalog) + CB (buyer catalog). NDC sends both.
- `SN1**1*CA` — 1 case shipped
- **No LIN*LT (lot number)** in this sample — either item isn't lot-tracked or only included when applicable
- **No DSCSA/YNQ segments** — need to ask Travita if these appear on applicable items

### sample810.txt — Invoice
- `BIG*20260512*279983*20260508*PO00224460***DI` — type DI (Debit Invoice)
- `IT1*1*1*BX*32.95****BP*BD366643-1*VN*NDC 100983` — **Both BP (Buyer's Part) and VN (Vendor Number)**. Confirms Vendor Pricing tab join key works.
- `PID*F****VACUTAINER PLASTIC TUBE 10.0ML` — product description
- `TDS*3895` — total $38.95
- `CAD*****UPSN**BM*1Z1H64X97389003981` — UPS tracking
- `SAC*C*D240***600` — Surcharge: D240 (Freight), $6.00. Maps to Logan's "shipping fees → MARS shipping" rule.

### sample867.txt — Product Transfer/Resale Report
- `BPT*00*2343446*20260426*SS` — report type SS (Seller Sales)
- `DTM*090/091` — period Mar 29 – Apr 25
- `PTD*SS***CT*10051480081` — **CT = Contract Number**. Ties 867 to 845 contract system.
- `REF*DH*BG5789574` — **DEA Number is present.** NDC already uses DEA in 867.
- `REF*HI*1KM4CYL00` — Health Industry Number
- `LIN*1*MG*SMI 66022003*F1*1354289` — MG (Manufacturer's Part Number) + F1 qualifier
- `AMT*CC*614.38` — Chargeback Claim Amount
- `REF*DI*56020665-02451405` — Distributor Invoice Number (composite format: invoice-account)
- `REF*MF*MPL-FL` — Manufacturer Facility code

### sample846.txt — Inventory Inquiry/Advice
- 287 line items (large catalog)
- `BIA*04*DD*137102*20260513*054600` — report type DD, account 137102
- Items use **VP (Vendor Part Number) only** — no UPC, no buyer code
- Product code format confirmed: `DER 16481`, `DUK 1030TD`, `MMM 00135LF`, `GRA 37235`, `TEC 1100`, `NUT 1114025`, `EXE 26703`
- **Manufacturer prefixes:** DER=Derma Sciences, DUK=Dukal, MMM=3M, GRA=Graham Medical, TEC=Tech-Med, NUT=?, EXE=Exel
- `SDQ*CS*A*02` or `SDQ*CS*D*02` — **SDQ02 is availability status: A=Available, D=Discontinued**
- 4 QTY qualifiers per item: 17 (On Hand), 33 (On Order), 63 (Available to Ship), BQ (Backordered)
- UOM varies: CS (Case), EA (Each), BX (Box)
- **Negative quantities exist:** `MMM 63500` QTY*17*-1*CS, `TEC TM3050` QTY*17*-1*EA. Parser must handle.
- No 845-style sample provided (Travita mentioned she previously sent 845 scenarios — need to locate)

### NDC 846 Guide Analysis (22pp, V4010, 6/3/2022)

Stored at `~/orderful-onboarding/mars-medical/ndc-samples/NDC 846 Guide.pdf`

Guide-specified structure:
- BIA: Transaction Set Purpose Code 00 (Original), Report Type PI (Product Availability Inquiry)
- REF*IA mandatory in header — **NDC Internal Vendor Number for MARS**. Same as the 850's REF*IA/IT field. Value should be MARS's NDC account number.
- N1*SE (Selling Party) only
- LIN identifiers per guide: UP (UPC), VN (Vendor's Item Number), SK (SKU), DV (Location Code)
- PID: product description (free-form)
- SDQ: qualifier 54 (Warehouse), destination warehouse quantities
- DD*08: Y/N stockable indicator
- QTY qualifiers per guide: **17** (On Hand), **33** (Available for Sale/stock quantity), **63** (On Order), **BQ** (Backorder), **IQ** (In-Transit)

**Discrepancies between guide and actual sample:**

1. **LIN identifier:** Guide says LIN02=UP (UPC). Sample uses VP (Vendor Part Number). NDC's actual 846 identifies items by VP, not UP. Parser should handle VP as primary.
2. **SDQ encoding:** Guide says SDQ02 = qualifier 54 (Warehouse). Sample shows `SDQ*CS*A*02` and `SDQ*CS*D*02` where the second element appears to be an availability status (A=Available, D=Discontinued), not a warehouse qualifier. Either NDC repurposed SDQ02 or the encoding differs from spec.
3. **QTY*IQ (In-Transit):** In the guide but absent from the sample. Parser should handle it if it appears.
4. **BIA report type:** Guide says PI (Product Availability Inquiry). Sample shows DD. Minor discrepancy — handle both.
5. **REF*IA in header:** Guide mandates it. Sample doesn't include it (the sample starts with BIA then jumps to LIN). May be stripped in the test sample or conditionally included.

## NetSuite Configuration

- Account: 5505603 (production only, no sandbox)
- SuiteApp: Installed, connector provisioned (by Rob Foster / Selma from Lysi)
- Sandbox: MARS does not appear to have a NetSuite sandbox. This is the first known prod-only NS customer at Orderful. All testing must use Orderful's TEST stream plus NS test flags to isolate test data.

Prod-only risk: Custom scripts are deployed directly to production. Any bad script could create junk POs, Item Receipts, or Vendor Bills in live books. Mitigation: use custrecord_ord_tran_testmode = T flag and validate thoroughly before enabling auto-processing.

## Test Transactions (May 11, 2026)

### Outbound 850 from MARS (NetSuite-generated)
- TX 911975608: PO 1006083_Test, 2 lines (ADC-6024N blood pressure monitor $46.35, Aspen Eye Bubble $64.46)
- Status: INVALID. REF segments sent with qualifiers (8M, IT) but empty values
- Fix needed: Outbound 850 script must either populate REF values or omit the segments entirely

### Simulated NDCINC Responses (generated via API, May 11 2026)
Submitted using MARS API key with NDCINC test ISA in envelope:

| TX ID | Type | Status | Business Number |
|---|---|---|---|
| 911979030 | 855 PO Ack | VALID / SENT / ACCEPTED | PO6962527028820507 |
| 911979572 | 856 ASN | VALID / SENT / ACCEPTED | SHP-MARS-20260511-001 |
| 911979605 | 810 Invoice | VALID / SENT / ACCEPTED | INV-MARS-20260511-001 |

These responded to an earlier test 850 (TX 908744829, PO6962527028820507) from Retail Integration Testing. They are sitting in MARS's test poller bucket 68810.

### Submitting Test Transactions as an Unclaimed TP

NDCINC is unclaimed (no API key). To simulate NDCINC responses:
1. Build the Orderful JSON message with NDCINC's test ISA as sender
2. Wrap in v3 transaction envelope: type, stream TEST, sender isaId NDCINCTEST, receiver isaId ORDFLMARSMEDICT, message with the EDI JSON
3. POST to https://api.orderful.com/v3/transactions using the receiver's (MARS) API key
4. Orderful routes based on ISA IDs and existing relationships. autoSend delivers to MARS's poller

Schema gotchas discovered during submission:
- v3 POST sender/receiver objects take only isaId. Do NOT include isaIdQualifier
- Do NOT include CTT_loop or transactionSetTrailer. Orderful auto-generates these
- 855: lineItemAcknowledgment must be inside ACK_loop array, not directly in PO1_loop
- 855 ACK segment does not accept unitPrice. Only lineItemStatusCode, quantity, unitOrBasisForMeasurementCode, dateTimeQualifier, date
- 856: item-level quantities use itemDetailShipment (not shipmentDetail)
- No guideline sets configured for NDCINC. Validation runs against base X12 schema only

## Onboarding Timeline

| Date | Event |
|---|---|
| 2026-04-24 | Opp closed, signed |
| 2026-04-30 | Kickoff call |
| 2026-05-06 | Customer reached out. No follow-up from Lysi PM after kickoff |
| 2026-05-08 | Lysi tried leader flow setup (wrong direction), Rob did training, customer confused |
| 2026-05-08 | Rob flagged SuiteApp does not support outbound 850s natively |
| 2026-05-08 | Selma confirmed all 7 TXs need custom scripts |
| 2026-05-11 | Customer escalation email: feel more like a project manager for Orderful |
| 2026-05-11 | Ashwath takes over, audits org, generates test 855/856/810, identifies NS validation bug |
| 2026-05-12 | Abdallah delivering custom P2P scripts (target) |
| 2026-05-12 | Ashwath sends requirements baseline doc to Logan; Abdallah's batched Q&A email to Logan with inline responses |
| 2026-05-12 | Isaiah publishes "Mars Medical × NDC — EDI Requirements Baseline" on Confluence (IM space) |
| 2026-05-12 | All 7 guideline sets created and assigned in Orderful |
| 2026-05-13 05:25 PT | Logan responds with full requirements PDF (MARS_Notes_5_13_26_Orderful.pdf) — all 7 TX types answered, §3 blocker resolved |
| 2026-05-13 06:31 PT | Travita Dumas (NDC EDI) responds with testing process, sample files (855/856/810/867/846), and AS2 cert |
| 2026-05-13 | NDC provides AS2 certificate (Babelway Shared AS2, expires 2027-05-07) and requests MARS's AS2 details for connectivity test |
| 2026-05-13 | NDC clarifies 845 testing: 4 scenarios (new/full local, new/full GPO, change/add/delete local, change/add/delete GPO) each with header/items/eligible end users |
| 2026-05-13 | Ashwath sends NDC (Travita) consolidated email with 11 open questions — 2 block first test 850 (REF*8M, N9*ZZ), rest are edge cases |
| 2026-05-13 | Ashwath sends Logan email with PDF status report (pending Abdallah's custom field list) |
| 2026-05-13 | Abdallah confirms Core 4 scripts ready: 850 outbound (stock + drop-ship), 855 inbound, 856 inbound (IF for drop-ship, IR for stock), 810 inbound. Custom fields list in progress. |
| 2026-05-13 | Abdallah drafts email to Logan with 855 field design (BAK02 status mapping, 5 custom fields), 856 carton packaging question, 810 charge mapping question |
| 2026-05-13 | Status update posted to #mars-medical_mts Slack channel |
| 2026-05-14 | Ashwath sends Logan technical spec email: 855/856/810 fields, logic, and open decisions |
| 2026-05-14 | Live call with Logan + Isaiah + Abdallah + Ashwath. Core 4 (850/855/856/810) built and validated against samples. Aligned on minimal v1 approach |
| 2026-05-14 | **855 simplified:** bare-minimum free-text field, no automation until real data. Isaiah's recommendation accepted by Logan |
| 2026-05-14 | **856 carton question resolved:** tracking number only on IF Packages tab, no carton hierarchy. Lot/serial captured if present but not required |
| 2026-05-14 | **810 charge mapping resolved:** review historical production vendor bills and match existing structure |
| 2026-05-14 | Logan to create drop-ship PO in NS production and send PO# + SO# for testing |
| 2026-05-14 | Confirmed: prod-only (no sandbox) is the biggest testing complication. Test transactions tracked for later cleanup |
| 2026-05-14 | **Near-term plan agreed:** P2P workflow first → drop-ship PO from Logan → test with samples → round trip → then 845/846/867. First pass go-live: ~2 weeks (Isaiah estimate) |

## Lessons Learned

1. P2P is not native. The SuiteApp's entire data model assumes O2C (inbound PO then outbound response docs). P2P reverses every flow. This must be identified during pre-sales and scoped as custom work with explicit timeline and cost. Kyle's statement that it should still leverage the basic integration framework is correct about the connector, but the business logic is 100% custom.

2. Kickoff SOP gap. The Customer Kickoff SOP does not have a decision gate for P2P vs O2C. When the flow is P2P, the kickoff should immediately flag: (a) custom script work required, (b) estimated hours per TX type, (c) who is building it (Lysi, Orderful, customer). The RuffleButts-style pre-call prep should include a flow direction check.

3. Leader/follower confusion. MARS is a follower (receives NDC's guidelines) but sends outbound 850s. Multiple team members confused follower with only receives documents. Leader/follower refers to who controls the EDI spec, not the direction of the PO.

4. Prod-only NetSuite is real. Smaller customers on lower NS tiers may not have sandboxes. The netsuite-setup skill's default of assume sandbox should add a prompt: Does this customer have a NetSuite sandbox? If not, we will work in production with test flags.

5. Unclaimed TP simulation works. You can submit test transactions as an unclaimed trading partner by using the receiver's API key and putting the TP's ISA in the sender envelope. Orderful routes correctly based on relationships. This is critical for testing when the TP has no API key.

6. Empty REF segments cause validation failure. NetSuite's default outbound mapping may send REF segments with qualifier codes but empty values. The v3 API rejects these. Custom outbound 850 scripts must either populate the values or omit the REF entirely.

7. SI category misclassification. Hiba's team classified this as Cat 1 (customer self-implementing) because the SI partner was not specified in the handoff. The kickoff prep skill should flag SI involvement explicitly.

8. Drop-ship vs stock is THE design question. For any P2P customer, the first question must be: what % of POs are drop-ship? MARS is 87% drop-ship, which completely changes the 856 inbound implementation. This question should be asked during kickoff, not after scripts are in flight.

9. SuiteApp has NO Orderful fields on Vendor entities. The `custentity_orderful_*` fields only exist on Customer records. P2P customers where the TP is a Vendor have a fundamentally different NS data model. The enable-customer skill doesn't cover this.

10. The requirements baseline document pattern works. Isaiah's doc structure (why/what's different/the #1 decision/status snapshot/doc-by-doc requirements/testing strategy/what we need/timeline/appendix) got Logan to respond with detailed, implementable answers in <12 hours. When Abdallah's earlier questions were thin, Logan's answers were thin. The framework made the difference.

11. Logan is a capable NS user. His "I assume" answers in the May 12 email were thin because the questions were thin. Given a proper framework, he delivered detailed answers including drop-ship completion mechanics, Vendor Pricing tab references, GL accounting implications, and AP workflow preferences.

12. 845 is a contract subsystem, not a price update. NDC's 845 is contract-based with status codes, effective dates, quantity-break pricing, proposed vs active contracts. NDC's 845 test scenarios include local contracts, GPO contracts, and change/add/delete operations with header/items/eligible end users. Building this as a simple price overwrite guarantees data integrity problems.

13. 867 ties back to 845 contracts. NDC's sample 867 includes PTD*SS***CT (contract number), REF*DH (DEA number), and AMT*CC (chargeback claim amount). The 867 references the same contracts the 845 creates. These are not independent — the contract system feeds the chargeback/rebate reporting.

14. NDC uses Babelway for AS2 connectivity. AS2 cert issued by Babelway (support@babelway.com), Louvain-La-Neuve Belgium. Expires 2027-05-07. MARS needs to provide their AS2 details for connectivity testing. Note: Orderful handles AS2 — MARS doesn't need their own AS2 setup, Orderful's AS2 endpoint is what NDC will connect to.

15. Orderful handles guideline mapping — don't exchange separate specs. NDC (leader) defines guidelines, Orderful maps to MARS's NetSuite. When NDC asked MARS to "share your EDI specs for inbound documents," that's traditional point-to-point EDI thinking. On Orderful's platform, there's no direct connection. Clarify the Orderful model and ask about edge cases/statuses instead of spec exchange.

16. Custom SuiteScript delivery matches estimates. Abdallah delivered Core 4 scripts (850/855/856/810) in ~2 days after receiving Logan's requirements. The 2-4 hours per TX type estimate was accurate. Custom fields are the long-pole — they require customer action in NS before scripts can run.

17. Native NS PO status cannot represent EDI ack states. PO statuses like Pending Receipt, Partially Received, etc. are computed by NetSuite based on linked transactions, not directly writable. Always use custom fields (custbody_ndc_855_status) for 855 header status tracking.

18. Email alerts and downstream blocks should be NS workflows, not SuiteScript. Recommending that MARS configure saved-search-with-email workflows triggered when custbody_ndc_855_status changes to Pending Review or Rejected. This keeps recipient/condition tuning in the customer's hands without requiring script redeployment.

19. EDI Carton custom records may not work on Item Receipts. The Orderful SuiteApp's EDI Carton and Shipped Item records hang off Item Fulfillments (designed for O2C outbound). For P2P stock path where the 856 creates an Item Receipt (not an IF), carton data handling needs separate verification. Drop-ship path (creates IF on linked SO) should work normally.

20. NDC's published 856 guideline is unreliable — map from sample files instead. The 856 guideline (set ID 40442) lumps all HL levels (S/O/P/T/I) into one flat loop with every segment listed regardless of level. Travis Thorson called it "pure garbage." Will Benish mistakenly set it as the default (default = certified). Jon M noted that since NDC is the sender, Orderful doesn't validate their payload against this guideline anyway — it just misleads anyone writing a mapping. The sample856.txt from Travita (hierarchy 0002, S/T/O/I with clear segment placement) is the authoritative source. This also applies to the 846 where we found guide-vs-sample discrepancies (VP vs UP, SDQ encoding). Always cross-reference guidelines against actual sample data from the trading partner.

21. Start with bare-minimum 855 handling. The original design (4-value status mapping, 5 custom fields, automated hold triggers) was over-engineered for a first pass. Isaiah's recommendation: join the 855 to the correct PO, flag it as received, show status at header level, and stop there. Don't automate mismatch handling or email alerts until there are months of real transaction data to know what actually happens. Logan agreed immediately. For future P2P customers: propose bare minimum first, let complexity grow from real-world needs.

22. Ask "do you care about carton-level detail?" early — the answer is usually no. Logan explicitly said he does NOT care about "what's in each box" from the 856. He only wants tracking numbers on the Item Fulfillment. The full pallet/carton/item hierarchy that 856s carry is impressive-looking data that most customers ignore. Don't build carton record infrastructure unless the customer specifically asks for it. Default to tracking-number-only.

23. NS doesn't enforce lot/serial on drop-ship orders. Even when an item is lot- or serial-numbered, NetSuite does not require those values on drop-ship PO completion. This means the 856 script can capture lot/serial data when present but must not block if it's missing. Test both paths: with and without lot data.

24. Review historical production records before building new ones. For the 810 Vendor Bill, the team agreed to review existing production vendor bills in NS before defining the output format. This avoids inventing a new structure that doesn't match what the customer's AP team expects. Apply this pattern to any inbound doc type: look at what already exists in NS first, then match it.

25. Minimal-first beats comprehensive-first for go-live speed. The May 14 meeting reduced the 855 from a 5-field design with automated hold triggers to a single free-text status field. The 856 went from Orderful EDI Carton records with carton hierarchy to just a tracking number. Total implementation surface dropped dramatically, and the customer was happier. Isaiah's "2 weeks to first pass go-live" estimate is directly tied to this simplification. Over-engineering the first pass delays go-live and creates maintenance burden before anyone knows what matters.

## People

| Name | Role | Context |
|---|---|---|
| Logan Watson | MARS Medical customer contact | lwatson@marsmed.com |
| Kyle Coronel | Senior AE (Orderful) | Sold the deal, initial customer relationship |
| Scott Shields | Partner Ops Manager | Coordinates Lysi, flagged cost/ARR concern |
| Selma | Lysi Consulting PM | SI resource, installing connector |
| Abdallah | Lysi Consulting Dev | Writing custom P2P SuiteScript |
| Rob Foster | Orderful | Training, flagged SuiteApp limitation |
| Hiba Jabrane | Orderful | Lysi oversight, initially misclassified |
| Isaiah Riesman-Tremonte | Orderful Software Eng (DOT) | NS connector expert, P2P architecture guidance |
| Nikki Stephens | Orderful | Flagged medical distribution chargeback context |
| Ashwath | Orderful VP Product | Took over May 11, driving to completion |
| Travita Dumas | NDC EDI team | Testing coordination, provided sample files and AS2 cert May 13 |
| Mike | Orderful | CC'd on NDC testing email thread |
| Ana | Orderful | CC'd on NDC testing email thread |
