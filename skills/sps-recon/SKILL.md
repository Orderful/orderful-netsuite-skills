---
name: sps-recon
description: Extract EDI transaction history, partner configurations, and mapping data from a customer's SPS Commerce account to inform Orderful org setup. Use when the user has SPS Commerce credentials for a customer migrating from SPS to Orderful, says "pull SPS data", "recon SPS", "what does their SPS setup look like", or is onboarding a customer who currently uses SPS Commerce.
---

# SPS Commerce Reconnaissance

Extract the customer's existing EDI configuration from SPS Commerce so we can pre-build their Orderful organization accurately. The goal: when we get to kickoff, we're fine-tuning rather than discovering.

## When to use

- Customer is migrating from SPS Commerce to Orderful
- User has SPS portal credentials (email + password) for the customer
- User says "pull SPS data", "recon SPS", "what's their current SPS setup"

## Prerequisites

1. SPS Commerce portal credentials (email + password) from the customer.
2. The customer's onboarding tracker exists (e.g., `docs/onboarding/<customer>.md` in the Jarvis repo).
3. Ideally, the Orderful org has been provisioned (we'll use it for cross-referencing).

## Inputs

Ask for:
1. **SPS credentials** — email and password (the user will provide; do not store in chat history after use).
2. **Customer name** — to match with onboarding tracker.
3. **Which trading partners to focus on** — if the customer has many TPs on SPS, ask which ones matter for the Orderful migration.

## Step 1 — Log in and orient

Log into the SPS Commerce portal at `portal.spscommerce.com`. Navigate to the dashboard and capture:

- **Account name** as shown in SPS
- **Number of trading partners** connected
- **Active vs inactive connections**
- **Transaction types** enabled per partner

Document the account overview in the onboarding tracker.

## Step 2 — Trading partner inventory

For each active trading partner:

| Field | Where to find |
|-------|---------------|
| Partner name | Connection list |
| Partner ID / qualifier | Connection details |
| ISA ID | Connection config |
| Transaction types | Connection config (850, 855, 856, 810, etc.) |
| Direction per TX | Inbound vs outbound |
| Status | Active, testing, disabled |
| Connection type | AS2, FTP, VAN, web forms |
| Go-live date on SPS | Connection history |

Build a table of all active partners and their configurations.

## Step 3 — Pull transaction samples

For each active trading partner + transaction type combination:

1. Navigate to the transaction history / fulfillment section.
2. Pull **3-5 recent transactions** per type (most recent, covering the last 30-60 days).
3. For each transaction, capture:
   - **Raw EDI** if viewable (X12 segments)
   - **Parsed view** (field-by-field breakdown)
   - **Key identifiers**: PO number, partner PO number, ship-to IDs, item qualifiers used (UPC, SKU, vendor part number), ISA/GS IDs
   - **Any errors or rejections** in the history

Focus on:
- **850 (PO)**: What qualifiers does the partner use for items? (BP, UP, VN, IN, etc.) What N1 segments appear? (ST ship-to, BY buyer, SE seller) What REF segments? (DP department, IA internal account)
- **855 (PO Ack)**: Is it actually being sent? What status codes?
- **856 (ASN)**: Pack structure (CTT, HL loops). Carton-level or order-level?
- **810 (Invoice)**: How are line items referenced back to the PO?

## Step 4 — Map extraction

Look for any custom mapping or transformation rules SPS has configured:

- **Field mappings** between SPS standard and the customer's format
- **Item crosswalks** (partner SKU ↔ customer SKU)
- **Ship-to code mappings**
- **Lookup tables** for qualifiers, terms codes, carrier codes
- **Validation rules** or compliance requirements per partner

These inform what we need to replicate in Orderful's JSONata transforms or item-lookup records.

## Step 5 — Produce the recon report

Write a structured report with these sections and append it to the onboarding tracker:

```
## SPS Commerce Recon — [Customer Name]

### Account Overview
- SPS Account: [name]
- Active Partners: [count]
- Transaction Volume: [approx monthly]

### Partner Configuration
| Partner | ISA | TX Types | Status | Notes |
|---------|-----|----------|--------|-------|

### Transaction Samples Summary
For each partner:
- Item qualifier pattern: [BP/UP/VN/etc.]
- Ship-to pattern: [N1*ST codes observed]
- Special segments: [REF, DTM, CTT patterns]
- Pack structure (856): [carton/order level]
- Error patterns: [any recurring issues]

### Mappings to Replicate
- Item crosswalks: [count, pattern]
- Ship-to mappings: [count, pattern]
- Custom validations: [list]

### Migration Implications for Orderful
- Guideline selection: [which Orderful guidelines match this partner's format]
- JSONata complexity: [simple/moderate/complex per TX type]
- Item lookup records needed: [estimate count]
- Risks: [format mismatches, missing fields, compliance gaps]
```

## Step 6 — Cross-reference with Orderful

If the Orderful org is provisioned:

1. Match each SPS partner ISA to an Orderful organization using the Orderful API:
   ```
   GET https://api.orderful.com/v2/organizations/search?isaId=<ISA_ID>
   ```
2. Check if the partner already has published guidelines on Orderful.
3. Identify gaps: partners on SPS with no Orderful presence, or Orderful guidelines that don't match the SPS transaction format.
4. Add cross-reference findings to the recon report.

## Behaviour rules

1. **Never store credentials in files or chat beyond the active session.** Use them to log in, extract data, then forget them.
2. **Capture raw EDI samples** when available — they're the ground truth for JSONata mapping later.
3. **Don't assume SPS config = what Orderful needs.** SPS may have legacy mappings or workarounds that don't carry over. Flag anything that looks non-standard.
4. **Focus on the migration-relevant partners.** If the customer has 20 SPS connections but is only bringing 1-3 to Orderful, don't waste time on the rest.
5. **Document everything in the tracker.** Every finding goes into the onboarding doc, not just chat.
6. **Flag partner-specific quirks early.** Government retailers (AAFES, DECA), big-box (Target, Walmart), and marketplace (DSCO/Rithum) all have distinct compliance requirements. Call these out.

## How to download historical transactions from SPS

Per Mike Mason (2026-05-08):

1. Navigate to **Fulfillment Monitor** in SPS Commerce portal
2. Search for the transaction type, or just press Enter to search all transactions
3. Check the checkbox on the transaction(s) you want
4. At the bottom of the screen, click the **Download** button
5. Click **Download Source Payload** to get the raw EDI/data

**Pagination limitation:** SPS paginates results. You cannot bulk-download all transactions at once. You must page through results and download per page. For large datasets, consider using the SPS API if available, or download in batches by date range.

**CSV export warning:** If you export to CSV (e.g., for item catalog analysis), be aware of the UPC corruption issue below.

## Common gotchas

- **SPS CSV UPC corruption (CRITICAL).** When SPS exports CSV data (or you open EDI data in Excel), 13-digit UPCs are converted to scientific notation (e.g., `195601234567` becomes `1.95601E+11`). This **permanently truncates** the number to ~12 significant digits. The original value CANNOT be recovered from the CSV. **UPCs must be sourced from the ERP item records (e.g., NetSuite), not from SPS CSV exports.** Workaround: if you must use CSV, open in a text editor first, or format the UPC column as Text before opening in Excel.
- **SPS "Fulfillment" module vs raw EDI**: SPS may show transactions through their web-form "Fulfillment" UI rather than raw EDI. The web forms hide complexity. Always look for the raw X12 view if available.
- **Multi-qualifier items**: A single PO line may carry BP (buyer part), UP (UPC), and VN (vendor part). SPS may only display one. Check the raw EDI for all qualifiers — Orderful item lookup needs to know which qualifier to key on.
- **Inactive connections still have history**: Don't ignore disabled connections — they may show why a partner relationship failed before, which helps avoid repeating mistakes.
- **SPS test vs production**: SPS uses separate environments. Make sure you're looking at production transaction history, not test data.
- **DSCO supplier IDs in SPS data.** If the customer has DSCO/Rithum connections (e.g., Nordstrom DSCO), the SPS transaction data may contain DSCO metadata in REF segments — including the customer's DSCO supplier ID. Extract this: `REF*ZZ*<supplier_id>*dsco_supplier_id`. This ID is needed for building test transactions on the DSCO path.
