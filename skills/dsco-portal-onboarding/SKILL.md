---
name: dsco-portal-onboarding
description: Walk through the Rithum/DSCO supplier onboarding portal (15 steps) when connecting a customer to a retailer via DSCO dropship. Covers catalog upload, inventory, test orders, AS2 setup, automation jobs, acknowledgement, shipping, invoicing, and returns. Use when the user says "DSCO portal", "Rithum onboarding steps", "supplier checklist", "complete DSCO testing", or is working through the DSCO portal for a customer. Requires internal round-trip testing to be complete first.
---

# DSCO Portal Onboarding

Walk a customer through the Rithum/DSCO supplier onboarding portal. This covers all 15 portal steps including catalog, inventory, test orders, AS2 connection, automation jobs, and the full order lifecycle testing.

## When to use

- Customer is going through the DSCO supplier checklist at `app.dsco.io`
- Internal Orderful ↔ NetSuite round-trip testing is already complete
- User says "DSCO portal steps", "Rithum onboarding", "supplier checklist", "complete DSCO testing"
- Customer is stuck on a specific portal step

## Prerequisites

1. **Orderful partnership** exists between customer and retailer's DSCO EDI account
2. **Customer org** provisioned in Orderful with ISA ID (max 15 chars)
3. **Customer invited to DSCO portal** by the retailer
4. **Internal round-trip testing** (Orderful ↔ NetSuite) already complete
5. **Product catalog** ready — retailer-approved items with real UPCs

## Portal URL

`https://app.dsco.io`

## Portal Steps (15 total)

### Steps 1–5: Initial Setup (Customer-side, straightforward)

| Step | Name | What to do |
|------|------|------------|
| 1 | How to Get Started | Read intro, click Next |
| 2 | Configure Initial Settings | Company info, warehouse addresses |
| 3 | Pricing Agreement | Accept retailer pricing terms |
| 4 | Supply Warehouses | Add warehouse(s) with ship-from addresses |
| 5 | Submit Catalog | Upload product catalog. Retailer may require images. Use retailer-specific template if provided. |

**Watchout:** Retailers like AAFES provide their own templates — check for "Download [Retailer] Specific Template" links. These override the generic DSCO instructions.

### Step 6: Load Items & Inventory

Check whether the retailer has a specific inventory template. AAFES provides a simple 2-column spreadsheet (`sku`, `quantity_available`) — NOT the 846 EDI file described in the generic instructions.

1. Download the **retailer-specific inventory template** if available (link in the retailer note box, NOT the instructions section)
2. Fill in 3 SKUs with `quantity_available` = 20+ each
3. Upload through the portal
4. Verify items appear on the Inventory page

**Watchout (AAFES):** The generic instructions talk about 846 EDI and AS2 — **ignore these for AAFES**. The AAFES note says "USE THIS TEMPLATE NOT WHAT IS LISTED IN THE INSTRUCTIONS SECTION."

### Step 7: Update Inventory

1. Download current inventory from the Inventory page (Download All Results → Export Inventory)
2. Change `quantity_available` to 50 for all 3 items
3. Upload the updated file
4. Verify quantities show 50 on the Inventory page

### Step 8: Create Test Orders

1. Select a carrier from the dropdown. For AAFES DSCO dropship: **FedEx - Home Delivery / FEHD**. Check the live DSCO 850 reference for the retailer's standard carrier.
2. Click Next — Rithum generates 3 test POs
3. Note the PO numbers — you'll use these for steps 9–14

**Watchout:** You can always come back to this step to generate more test orders if needed.

### Step 9: Acknowledging Orders (CRITICAL — AS2 setup required)

This is where the real EDI connection gets configured. Four sub-tasks:

#### A. Configure AS2 in Orderful

1. Open the customer's org in Orderful
2. Create a new communication channel → **Shared AS2**
3. Search for **"Rhythm AS2"** (the shared Rithum/DSCO connection)
4. Select it — this uses Orderful's existing certificate already known to Rithum
5. Do NOT create a new cert — reuse the shared connection (same one used by Chewy, etc.)

#### B. Enable AS2 in DSCO Portal (requires support call)

AS2 is **NOT available by default** in the DSCO portal. You must call Rithum support to enable it.

1. Call **844-482-4357**
2. Menu: **DSCO support → DSCO onboarding**
3. Ask to enable **AS2** for the customer's DSCO account
4. Provide: account number, customer name, "Orderful AS2" as connection, ISA ID (must be exactly 15 chars)
5. Support enables AS2 and configures the backend connection
6. Refresh the DSCO portal — AS2 should now appear in dropdowns

**Pro tip:** Create a support ticket first, then call and reference it. Phone is faster than ticket-only. Support available until 6PM ET.

#### C. Create Automation Jobs

**Job 1: Orders (Export — pulls orders FROM DSCO to Orderful)**

| Field | Value |
|-------|-------|
| Job Title | `Orders` (not "test orders" — reuse for production) |
| Process | Orders Export |
| Standard/Guideline | DSCO |
| File Type | EDI |
| Destination Type | DSCO AS2 |
| Filename | `Purchase_Order_${ymdt}.edi` |
| Sender Interchange ID | Retailer's DSCO ISA ID (e.g., `DSCOAAFES`) |
| Sender Interchange Qualifier | `ZZ` |
| Receiver Interchange ID | Customer's Orderful ISA ID (e.g., `ORDFLRUFFLEBUTT`) |
| Receiver Interchange Qualifier | `ZZ` |
| Include Test Orders | **Checked** |
| Source Data | **All retailers** (critical — see gotcha below) |
| Schedule | Manual (switch to automatic after testing) |
| Failure Notifications | Your email |

**CRITICAL GOTCHA — Source Data filter:** The default Source Data is set to the specific retailer (e.g., AAFES). Test orders come from a **fictitious test retailer**, not the actual retailer. If Source Data = retailer-only, the export job will pull 0 transactions. **Change Source Data to "All retailers"** — this works for both testing and production.

**Job 2: Outbound (Import — sends docs FROM Orderful TO DSCO)**

| Field | Value |
|-------|-------|
| Job Title | `Outbound` |
| Process | EDI - Import |
| Standard | DSCO |
| Source Type | DSCO AS2 |
| Filename | `*` (wildcard — accepts any file type) |
| Generate 997 | **Checked** |
| Schedule | Manual (switch to automatic after testing) |
| Failure Notifications | Your email |

#### D. Run and Verify

1. Go to Automation Jobs → Run the Orders export job (circular/run icon)
2. Check Job History — should show succeeded with transactions pulled
3. Verify orders show **"Acknowledged"** status in DSCO Orders page
4. Verify test transactions appear in Orderful

**855 is NOT required for DSCO acknowledgement.** Acknowledgement is a platform status change, not an 855 document.

### Step 10: Shipping an Order

Check for a retailer-specific shipment template (AAFES has one — download from the AAFES note box).

- Retailer may require shipping by the ship-by date
- Use the retailer's acceptable Ship Service-Level Codes
- FedEx test tracking number: **15 zeros** (`000000000000000`)
- UPS test tracking number: **1Z + 16 zeros** (`1Z0000000000000000`)
- Outbound 856 ASN must flow from Orderful → DSCO via the "Outbound" automation job

### Steps 11–14: Cancel, Multi-Line Ship, Invoice, Returns

These test the full order lifecycle. Each step may have a retailer-specific template — always check the retailer note box first before following generic instructions.

| Step | Document | Direction |
|------|----------|-----------|
| 10 | 856 ASN (single line) | Orderful → DSCO |
| 11 | Cancellation | Portal action |
| 12 | 856 ASN (multi-line) | Orderful → DSCO |
| 13 | 810 Invoice | Orderful → DSCO |
| 14 | Returns | Portal action |

### Step 15: Next Steps

Rithum reviews all test results. If passed, the connection moves to production. Switch automation jobs from manual to automatic.

---

## Rithum Support

| | Details |
|---|---------|
| Phone | **844-482-4357** |
| Menu path | DSCO support → DSCO onboarding |
| Hours | Until 6PM Eastern (phone harder to reach after 5PM) |
| Best practice | Create ticket first, then call and reference ticket number |

---

## Known Quirks & Gotchas

1. **AS2 must be enabled by support** — not available in portal by default
2. **Source Data filter excludes test orders** — must set to "All retailers"
3. **Orders cannot be deleted** from DSCO UI once created — ignore old ones, use latest batch
4. **Account switching issues** — may need to logout, clear cache/cookies, re-accept invite
5. **Retailer notes override generic instructions** — always check for retailer-specific templates/notes before following the standard DSCO instructions
6. **AAFES inventory is CSV, not 846 EDI** — simple 2-column spreadsheet upload
7. **855 not used on DSCO** — acknowledgement is platform-level, no EDI document
8. **Carrier for AAFES DSCO dropship** — FedEx Home Delivery (FEHD) is standard

---

## Automation Job Monitoring

1. Go to Automation Jobs → Job History
2. Click completed/failed job to see details
3. If file failed, detail page shows the reason (wrong SCAC, missing tracking, invalid data)
4. If job returns 0 files: check Source Data filter, confirm test orders exist, confirm correct retailer selected
5. Results take several minutes to load — refresh the page

---

## Production Cutover Checklist

- [ ] All 15 portal steps complete and verified by Rithum/retailer
- [ ] Switch automation jobs from Manual to Automatic schedule
- [ ] Align job schedules with Orderful sync cadence
- [ ] Replace "Keep In Orderful" outbound comm channel with real DSCO AS2 delivery
- [ ] Upload full inventory (all approved UPCs, not just 3 test items)
- [ ] Coordinate go-live date with retailer and customer
