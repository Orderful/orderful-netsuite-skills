---
name: dsco-recon
description: Extract dropship configuration, retailer connections, and transaction patterns from a customer's DSCO (Rithum) portal to inform Orderful org setup. Use when the user has DSCO/Rithum credentials for a customer doing dropship fulfillment, says "pull DSCO data", "recon DSCO", "what's their DSCO setup", or is onboarding a customer connected to retailers via DSCO/Rithum (formerly CommerceHub).
---

# DSCO / Rithum Reconnaissance

Extract the customer's dropship configuration from DSCO (now Rithum, formerly CommerceHub) so we can pre-build their Orderful organization for the correct retailer connections. DSCO acts as an intermediary — the customer doesn't connect directly to the retailer's EDI. Instead, Orderful coordinates with DSCO/Rithum, and DSCO routes transactions to/from the retailer.

## When to use

- Customer does dropship fulfillment via DSCO/Rithum
- User has DSCO portal credentials (email + password)
- User says "pull DSCO data", "recon DSCO", "check their DSCO setup"
- Customer is moving their DSCO EDI connection from another provider (e.g., SPS) to Orderful

## Background: How DSCO/Rithum works with Orderful

DSCO (branded as Rithum) is a dropship aggregation platform. Key facts:

- **Orderful connects to DSCO, not the retailer directly.** The EDI path is: Retailer → DSCO/Rithum → Orderful → Customer's ERP.
- **DSCO has its own ISA ID per retailer.** Example: AAFES via DSCO uses ISA `DSCOAAFES`, not AAFES's direct ISA `001695568GP`.
- **Partner setup goes through Rithum.** Contact: `dscopartnersetup@rithum.com`. The customer does NOT contact the retailer for EDI setup.
- **Transaction flow differs from direct EDI.** DSCO dropship typically uses: 850 (PO inbound), 856 (ASN outbound), 810 (Invoice outbound), 846 (Inventory outbound), 870 (Order Status outbound). **855 (PO Ack) is typically NOT used** in DSCO dropship flows.
- **Each retailer on DSCO has a separate Orderful EDI account** under the retailer's org (e.g., AAFES org 268 has ediAccountId 15749 for DSCO).

## Prerequisites

1. DSCO/Rithum portal credentials (email + password) from the customer.
2. The customer's onboarding tracker exists.
3. Know which retailer(s) the customer connects to via DSCO (from SPS recon or customer conversation).

## Inputs

Ask for:
1. **DSCO credentials** — email and password.
2. **Customer name** — to match with onboarding tracker.
3. **Which retailers** — which DSCO retailer connections are being migrated to Orderful.

## Step 1 — Log in and orient

Log into the DSCO portal at `app.dsco.io` (or `supplier.dsco.io`). Navigate to the dashboard and capture:

- **Account/company name** as registered in DSCO
- **Supplier ID** (DSCO's internal identifier for this customer)
- **Connected retailers** (list all active retailer connections)
- **Account status** (active, pending, suspended)
- **API credentials** if visible (some suppliers have API keys for direct integration)

## Step 2 — Retailer connection inventory

For each connected retailer:

| Field | Where to find |
|-------|---------------|
| Retailer name | Connections / Partners page |
| Retailer ID in DSCO | Connection details |
| Connection status | Active, testing, onboarding |
| Enabled transaction types | Connection config |
| Inventory feed required? | Retailer requirements (846) |
| Order status required? | Retailer requirements (870) |
| Fulfillment method | Dropship, marketplace, hybrid |
| Compliance requirements | Retailer-specific rules (ship windows, label formats, etc.) |

## Step 3 — Pull transaction and order data

For each active retailer connection, examine:

### Orders (850 equivalent)
- **Recent order samples** (3-5 from last 30 days)
- **Order format**: What fields does DSCO pass through? (item identifiers, ship-to structure, PO references)
- **Item identification pattern**: How does the retailer identify items? (UPC, retailer SKU, vendor SKU, GTIN)
- **Ship-to format**: Address structure, store/DC identifiers

### Shipments (856 equivalent)
- **Shipment confirmation format**: What does DSCO expect back?
- **Tracking number requirements**: Carrier codes, tracking formats
- **Pack-level detail**: Carton-level or shipment-level ASN?
- **Ship date / cancel date handling**

### Invoices (810 equivalent)
- **Invoice submission format**: Via DSCO portal or EDI?
- **Required fields**: Terms, allowances, charges
- **Timing requirements**: Invoice within N days of shipment?

### Inventory (846 equivalent)
- **Inventory feed frequency**: Daily, real-time, weekly?
- **Feed format**: DSCO API, flat file, EDI 846?
- **Inventory locations**: Warehouse/DC identifiers
- **ATP vs on-hand**: What inventory type does the retailer expect?

### Order Status (870)
- **Status update requirements**: When and what status codes?
- **Acknowledgment flow**: Does the retailer expect order-level acks via 870 instead of 855?

## Step 4 — Item catalog and mapping

Extract from DSCO:
- **Item/product catalog** as configured for each retailer
- **SKU mapping**: Customer SKU ↔ Retailer SKU ↔ UPC/GTIN crosswalk
- **Item attributes**: Descriptions, categories, dimensions, weights
- **Active vs discontinued items**
- **Item count per retailer** (this drives item-lookup record volume in Orderful)

## Step 5 — Compliance and SLA requirements

DSCO retailers often have strict compliance rules. Capture:

- **Ship window**: Order received → must ship within N hours/days
- **Cancel date enforcement**: Auto-cancel if not shipped by date?
- **Label requirements**: GS1-128, custom retailer labels
- **Routing guide**: Carrier restrictions, freight terms
- **Chargeback triggers**: Late shipment, wrong item, missing ASN, invalid tracking
- **Inventory accuracy SLA**: Max variance %, update frequency

## Step 6 — Produce the recon report

Append to the onboarding tracker:

```
## DSCO/Rithum Recon — [Customer Name]

### Account Overview
- DSCO Account: [name]
- Supplier ID: [id]
- Connected Retailers: [count]

### Retailer Connections
| Retailer | Status | TX Types | Inventory? | Compliance Notes |
|----------|--------|----------|------------|-----------------|

### Transaction Pattern per Retailer
For each retailer:
- Item ID pattern: [UPC/SKU/GTIN]
- Ship-to structure: [address fields, store IDs]
- Pack level: [carton/order]
- Invoice method: [EDI/portal]
- Inventory feed: [frequency, format]

### Item Catalog Summary
- Total items: [count]
- SKU mapping complexity: [1:1 / many:1 / crosswalk needed]
- Missing UPCs or identifiers: [count]

### Compliance Requirements
| Requirement | Details | Risk Level |
|-------------|---------|------------|

### Migration Implications for Orderful
- Orderful DSCO EDI account to use: [ISA ID, ediAccountId]
- Guidelines to assign: [guideline IDs from Orderful for this retailer's DSCO path]
- Rithum coordination: Email dscopartnersetup@rithum.com to set up Orderful as EDI provider
- 855 needed?: [Almost certainly NO for DSCO — verify from live data]
- Additional TX types beyond 850/856/810: [846, 870 if required]
- Item lookup records: [estimate based on catalog size]
- JSONata complexity: [based on field mapping requirements]
```

## Step 7 — Cross-reference with Orderful

1. Look up the retailer's DSCO EDI account on Orderful:
   ```
   GET https://api.orderful.com/v2/organizations/search?isaId=DSCO<RETAILER>
   ```
   Example: For AAFES via DSCO, search `DSCOAAFES`.

2. Pull the retailer's published DSCO guidelines from Orderful (guideline-sets endpoint filtered by the DSCO org).

3. Check what other vendors are live on this same DSCO path — their transaction patterns establish the template:
   ```
   GET https://api.orderful.com/v2/document-relationships?ownerId=<retailer_org_id>&limit=500
   ```
   Filter for the DSCO EDI account. Active/live vendors show the expected TX set.

4. Compare DSCO recon findings against Orderful's published guidelines. Flag gaps.

## Behaviour rules

1. **Never store credentials beyond the active session.**
2. **DSCO ≠ direct EDI.** Always flag the intermediary nature. The customer connects to DSCO, not the retailer. Orderful connects to DSCO, not the retailer. This changes everything about partner setup.
3. **855 is almost never used in DSCO flows.** Confirm by checking live vendors on the same DSCO path in Orderful. Don't assume the customer needs it just because they mentioned it.
4. **Inventory (846) and Order Status (870) may be required.** DSCO retailers often mandate inventory feeds and status updates that wouldn't be required in direct EDI. Flag these for scope.
5. **Rithum coordination is a dependency.** Orderful must email `dscopartnersetup@rithum.com` to register as the customer's EDI provider. This is a blocking external dependency — track it.
6. **Document everything in the tracker.** Every finding goes into the onboarding doc.

## AAFES-Specific DSCO Intelligence (learned 2026-05-08)

AAFES (Army & Air Force Exchange Service) is a common DSCO retailer. Key findings from the RuffleButts onboarding:

### AAFES has 3 separate EDI paths — always confirm which one

| Path | ISA ID | EDI Account ID | Use Case |
|------|--------|----------------|----------|
| Direct AAFES | `001695568GP` | 197 | Traditional retail/wholesale vendors |
| DSCO/Rithum (dropship) | `DSCOAAFES` | 15749 | Dropship vendors routed through Rithum |
| VendorNet/Radial (dropship) | `VNEXCHANGE` | 5375 | Dropship vendors routed through Radial |

**All three paths are actively used** (confirmed May 2026: RuffleButts on DSCO, Simplehuman US on VendorNet). **Never assume DSCO — always ask the customer which path they use.**

### DSCO 850 structure is unique

DSCO 850s have 15 REF segments with DSCO-specific metadata not found in direct AAFES 850s:
- `dsco_order_id`, `dsco_supplier_id`, `dsco_retailer_id`, `dsco_lifecycle`
- `dsco_supplier_name`, `dsco_trading_partner_id`, `dsco_create_date`, `dsco_last_update_date`
- `dsco_order_status`, `test_flag`, `gift_wrap_flag`, `channel`
- `ship_service_level_code`, `consumer_order_number`

Ship-to is consumer home address (DTC), not store. FedEx Home Delivery is the standard carrier. This is fundamentally different from direct AAFES 850s which ship to stores/DCs.

### 855 NOT used on DSCO path

Confirmed via live API data: zero AAFES DSCO vendors trade 855. All 3 live vendors (GIII, Peak Design, Vida Brands) trade 850/856/810/846/870 only. Generic 855 templates exist but are unused.

### 856 ASN is simplified on DSCO

DSCO 856 does NOT require: N1*BY, N1*Z7, ship-to address, conditional Tare/Pack HL. Ship-to goes on the 810 invoice instead.

### 810 Invoice is strict on DSCO

AAFES via DSCO rejects invoices with extra fields: "The following fields are the ONLY fields to send. Do not send any additional fields. If you send additional fields, your invoices will fail." Must include ship-to (N1*ST with full address) on the invoice, not the ASN.

### Transformation agent gaps

As of May 2026, the AAFES DSCO 850 guideline (146778) transformation was attempted by the transformation agent → **saved as Draft with 53 schema gaps**. This means the inbound 850 JSONata for NS is NOT ready out of the box and requires manual work.

### AAFES chargebacks

AAFES levies $150 per violation: "ASN sent but data download is missing/inaccurate", "ASN not received at time of induction", "canceling carrier after dispatched." One vendor received $7,148.50 in a single cycle.

## Rithum Portal: Customer Must Complete Setup Steps 1–7

**Learned on RuffleButts (May 2026):** Rithum requires the customer to complete their initial portal setup before Orderful can proceed to test order exchange. Steps 1–7 cover:

- Billing contacts and email notifications
- Pricing agreements with the retailer
- Supply warehouse configuration
- Catalog submission, item loading, and inventory

**These are commercial/supply-chain details only the customer can provide** — Orderful does not have access to their pricing agreements, warehouse configs, or item catalogs. Steps 8–12 (test orders, testing completion) are where Orderful re-engages.

**Action:** Flag this early in onboarding. Send the customer instructions to complete Rithum steps 1–7 in the follow-up email after kickoff. Don't wait — this is a common blocker because customers assume Orderful handles the entire DSCO setup.

## Common gotchas

- **Rithum setup is a customer dependency**: Steps 1–7 must be completed by the customer before test orders can flow. This is often the longest pole in DSCO onboardings because it requires customer-side decisions about pricing, warehousing, and catalogs. Flag it immediately.
- **DSCO portal vs DSCO API**: Some suppliers interact with DSCO entirely through the web portal (manual order processing). Others use the DSCO REST API for automation. Know which mode the customer uses — it affects what data is visible and how they currently operate.
- **Multiple retailer connections, different rules**: Each retailer on DSCO can have completely different compliance requirements, item formats, and transaction types. Don't assume one retailer's pattern applies to another.
- **DSCO rebranding**: DSCO was acquired by Rithum (formerly CommerceHub). The portal may show "Rithum" branding, "DSCO" branding, or "CommerceHub" depending on the page. They're all the same platform.
- **Inventory feed is often the hardest part**: DSCO retailers expect frequent, accurate inventory feeds. If the customer's ERP can't produce automated 846s, this becomes a manual process or requires custom development.
- **DSCO test mode**: DSCO has test/sandbox environments. Make sure recon data is from production, not test.
- **Existing EDI provider switchover**: If the customer currently uses SPS Commerce (or another VAN) for their DSCO connection, the switchover to Orderful requires Rithum to re-point the EDI routing. This is not instant — plan for overlap/cutover timing.
- **Building test transactions for new relationships.** When there's no historical data (brand-new retailer connection), pull a live DSCO 850 from another vendor on the same path as a template, then substitute the customer's item data from SPS/NS. This is a repeatable pattern. Use the `submit-test-transaction` skill to submit the test 850 to Orderful.
