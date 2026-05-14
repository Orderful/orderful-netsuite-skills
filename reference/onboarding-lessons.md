# Onboarding Process Lessons

Compiled from the RuffleButts × AAFES onboarding (May 2026). These are process-level lessons applicable to all future customer onboardings.

## Process Model: Don't Wait, Don't Discover, Arrive Prepared

| Dimension | Old | New |
|-----------|-----|-----|
| **People** | Contractors (Lysi/N2), OAs, AM handoff | Product team (Mike, Ashwath, Isaiah) + AM handoff |
| **Process** | Wait for customer to commit TRs, do discovery on kickoff, wait for app install, wait for historical data | Create TRs for customer, get creds before kickoff, install on their behalf, pull historical data yourself |
| **Systems** | Manual setup, testing, rule writing, JSONata, validation | NetSuite skills library for onboarding, setup, and validation |

## Key Lessons

### 1. Get credentials BEFORE the kickoff

Send credential request email the same day the deal closes. By kickoff, you should have SPS access, portal access, and NS access — demo a pre-built partnership instead of starting from zero.

### 2. Confirm the trading partner path before building anything

AAFES has 3 EDI paths (Direct/DSCO/Radial). Always ask which path — never assume. All three paths are actively used by different customers simultaneously.

### 3. For new relationships with no historical data, use live reference transactions

When there's no historical data (brand-new TP relationship), pull a live transaction from another vendor on the same path and substitute the customer's item data.

### 4. SPS historical download path

Fulfillment Monitor → search → check the box → download → download source payload. Pagination is a problem — can't bulk download all at once.

### 5. Credential sharing needs a secure flow

Use 1Password links, not email or Zoom chat. Future: secret store tab in org settings.

### 6. Role clarity — take ownership early

Clear ownership from day 1 prevents the account from drifting in queue. Jump in and own it, don't wait for formal assignment.

### 7. Outbound relationships need communication channels

All outbound relationships (856, 810, 846, 870) must have a communication channel assigned or delivery fails silently. For testing: "Keep In Orderful" channel. For production: real partner delivery endpoint.

### 8. Always use v3 API for test transaction submission

v3 (`/v3/transactions`) handles format conversion automatically. Auth: `orderful-api-key` header. Schema: `sender/receiver: {isaId}`. Type: system name (e.g., `850_PURCHASE_ORDER`).

### 9. Don't expose NS internals to customers

Rewrite all customer-facing questions in business language. Internal NS field names stay between the implementation team.

### 10. Rithum portal setup is a customer-side blocker

Flag portal completion requirements in the first follow-up email, not after kickoff. Steps 1–7 are customer-side and can be the longest pole.

### 11. DSCO portal quirks require support calls

AS2 must be enabled by Rithum support (not self-service). Source Data filter defaults exclude test orders. Orders can't be deleted. See the `dsco-portal-onboarding` skill.

### 12. AAFES 810 is the strictest spec

AAFES via DSCO rejects invoices with any extra fields. JSONata must produce exactly the required fields, nothing more. See `reference/aafes-dsco.md` for deviation table.

### 13. SPS CSV UPCs are corrupted by Excel

Excel scientific notation truncates 13-digit UPCs. UPCs must come from NetSuite item records or the retailer's catalog file, not SPS CSV exports.
