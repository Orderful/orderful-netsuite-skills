---
name: submit-test-transaction
description: Submit a test EDI transaction to an Orderful customer org via the v3 API. Covers building test transactions from live reference data when no historical exists, the correct API endpoint and auth, common payload errors and how to avoid them. Use when the user wants to submit a test 850/856/810 to Orderful, says "send a test transaction", "upload a test 850", "submit test EDI", or is testing a partnership before NS integration.
---

# Submit Test Transaction to Orderful

Submit a test EDI transaction (850, 856, 810, etc.) to a customer's Orderful org via the v3 API. This is typically done after partnership configuration to verify the pipeline before wiring up NetSuite.

## When to use

- User says "submit a test 850", "send a test transaction", "upload test EDI to Orderful"
- Partnership is configured and needs a test transaction to validate
- Preparing for a customer demo or kickoff — want a transaction visible in their org
- No historical data exists for a new relationship and a test must be built from scratch

## Prerequisites

1. **Partnership exists** between sender and receiver orgs (trade request accepted, relationships configured)
2. **Orderful API key** — from Settings > API Credentials in the Orderful UI. NOT a Bearer JWT token.
3. **ISA IDs** for both sender and receiver (from the partnership/relationship config)
4. **Transaction type system name** — e.g., `850_PURCHASE_ORDER`, not just `850`

## The API (v3 only)

**CRITICAL: Always use the v3 API. Never use v2 for creating transactions.**

```
POST https://api.orderful.com/v3/transactions
```

**Headers:**
```
orderful-api-key: <your-api-key>
Content-Type: application/json
```

**Request body:**
```json
{
    "sender": {
        "isaId": "<SENDER_ISA_ID>"
    },
    "receiver": {
        "isaId": "<RECEIVER_ISA_ID>"
    },
    "type": {
        "name": "<TRANSACTION_TYPE_SYSTEM_NAME>"
    },
    "stream": "test",
    "message": {
        "interchangeControlHeader": [...],
        "functionalGroupHeader": [...],
        "transactionSets": [...]
    }
}
```

**Success response:** `201 Created` with `{"id": "<transaction_id>"}`

### Why NOT v2

The v2 API (`POST /v2/transactions`) has these problems:
1. Requires `Authorization: Bearer <JWT>` + `X-ActingOrgId` header
2. Uses `from`/`to` instead of `sender`/`receiver`
3. **Enforces data format matching** — if the relationship is configured for X12 (common for DSCO), sending JSON returns `422: Data type mismatch`. v3 handles the conversion automatically.
4. Uses different field names: `from: {id, idType}` vs `sender: {isaId}`

### Transaction type system names

`850` alone doesn't exist as a type name. Use system names:

| Short | System Name |
|-------|-------------|
| 850 | `850_PURCHASE_ORDER` |
| 855 | `855_PURCHASE_ORDER_ACKNOWLEDGMENT` |
| 856 | `856_SHIP_NOTICE` or `856_SHIP_NOTICE_MANIFEST` |
| 810 | `810_INVOICE` |
| 846 | `846_INVENTORY_INQUIRY_ADVICE` |
| 870 | `870_ORDER_STATUS_REPORT` |

Discover all available types via `GET /v2/transaction-types`.

## Building a test transaction from scratch

When the customer has a brand-new relationship with no historical data (e.g., first time trading with AAFES via DSCO), you must build a test transaction from scratch.

### Step 1 — Find a live reference transaction

Pull a recent, accepted transaction from another vendor on the same path:

```
GET /v2/transactions?limit=50&offset=0
Header: Authorization: Bearer <JWT>
Header: X-ActingOrgId: <partner_org_id>
```

Scan through results to find a transaction that:
- Uses the same EDI account/path (e.g., DSCO account, not direct)
- Is the correct TX type (850, 856, etc.)
- Has status ACCEPTED (valid, passed guidelines)

Save the full message JSON as your template.

### Step 2 — Substitute customer-specific data

Replace in the template:
- **ISA sender/receiver IDs** — match the customer's partnership
- **GS sender/receiver codes** — match the ISA IDs
- **Item data** — use real items from SPS recon or NetSuite item records
- **PO number** — use a clearly test-labeled number (e.g., `TEST00000001`)
- **Ship-to address** — use a realistic test address
- **Dates** — set to current/near-future dates
- **`interchangeUsageIndicatorCode`** — set to `T` (test)

### Step 3 — Handle missing data

Mark anything you can't populate with clear placeholders:
- `TODO_GET_UPC_FROM_NETSUITE` — for UPCs not available from SPS (Excel corrupts them)
- `TODO_GET_VENDOR_ID` — for retailer-specific vendor numbers from the TP connection
- `PLACEHOLDER_SSCC` — for SSCC barcodes on 856 ASNs

### Step 4 — Submit

```python
import json, subprocess

api_key = "<orderful-api-key>"

with open('test_transaction.json', 'r') as f:
    message = json.load(f)

payload = {
    "sender": {"isaId": "<SENDER_ISA>"},
    "receiver": {"isaId": "<RECEIVER_ISA>"},
    "type": {"name": "850_PURCHASE_ORDER"},
    "stream": "test",
    "message": message
}

with open('submit_payload.json', 'w') as f:
    json.dump(payload, f, indent=2)

result = subprocess.run(
    ["curl", "-s", "-w", "\n%{http_code}",
     "-X", "POST",
     "https://api.orderful.com/v3/transactions",
     "-H", f"orderful-api-key: {api_key}",
     "-H", "Content-Type: application/json",
     "-d", "@submit_payload.json"],
    capture_output=True, text=True
)
print(result.stdout)
```

### Step 5 — Verify

After a successful 201:
1. Note the transaction ID from the response
2. Verify it appears in the customer's Orderful org under Transactions
3. Check if it passes guideline validation (look for validation errors in the transaction detail)
4. If validation errors appear, they indicate what needs fixing in the test data

## Submitting as an unclaimed trading partner

When the trading partner is unclaimed (no API key, no Orderful login), you can still simulate their responses by using the **receiver's** API key and putting the TP's ISA in the sender envelope. Orderful routes based on ISA IDs and existing relationships, not which API key submitted the transaction.

Example: NDCINC (unclaimed) responding to MARS Medical (claimed):
```json
{
    "sender": {"isaId": "NDCINCTEST"},
    "receiver": {"isaId": "ORDFLMARSMEDICT"},
    "type": {"name": "855_PURCHASE_ORDER_ACKNOWLEDGMENT"},
    "stream": "TEST",
    "message": { ... }
}
```
Submit with MARS's API key. Orderful delivers to MARS's poller via the existing NDCINC→MARS relationship. Validated May 2026 — see `reference/ndcinc-p2p.md`.

## Common errors and fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `400: Missing required field` | Sending raw message without envelope | Wrap in `{sender, receiver, type, stream, message}` |
| `400: type ... doesn't exist` | Using short name like `850` | Use system name `850_PURCHASE_ORDER` |
| `400: property isaIdQualifier should not exist` | Extra fields in sender/receiver | sender/receiver take only `{isaId}`, nothing else |
| `401: Unauthorized` | Using Bearer token with v3 | Use `orderful-api-key` header |
| `422: Data type mismatch` | v2 API + JSON message + X12 relationship | Switch to v3 API |
| `422: sender/receiver not found` | Wrong ISA ID or no partnership | Verify partnership exists with these ISA IDs |
| `422: must NOT have additional properties - CTT_loop` | Included trailer segments | Remove `CTT_loop` and `transactionSetTrailer` — Orderful auto-generates these |
| `422: must NOT have additional properties - lineItemAcknowledgment` | 855 ACK in wrong location | Put ACK data inside `ACK_loop` array within each `PO1_loop` item |
| `422: must NOT have additional properties - unitPrice` (on 855 ACK) | Extra field in ACK segment | ACK only accepts: lineItemStatusCode, quantity, unitOrBasisForMeasurementCode, dateTimeQualifier, date |
| `422: must NOT have additional properties - shipmentDetail` (on 856) | Wrong field name for SN1 | Use `itemDetailShipment` instead of `shipmentDetail` |

## P2P testing: outbound from NetSuite

For P2P customers, you also need to test **outbound** transactions generated by NetSuite (e.g., 850 Purchase Orders), not just inbound submissions. This requires a different approach:

1. **Real POs must exist in NS first.** The outbound 850 script reads from NS Purchase Orders. You need the customer to create test POs covering each scenario:
   - At minimum: one standalone/stock PO and one drop-ship PO (linked to a Sales Order)
   - Ideally: rush, multi-line, mixed UOM if the customer sends those
2. **4-layer testing strategy** (validated on MARS Medical, May 2026):
   - Layer 1: Validate transforms — does the outbound script produce valid Orderful JSON?
   - Layer 2: TEST stream — submit to Orderful's TEST stream, check guideline validation
   - Layer 3: PendingCustomProcess — first real inbound (855/856/810) held for human review before NS processing
   - Layer 4: Contained test POs — test with real but isolated POs, verify full cycle
3. **Custom fields must exist** before scripts run. The customer creates these in NS per the implementation team's field list.
4. **997s may be mandatory.** Some trading partners (e.g., NDC) require 997 functional acknowledgments in both directions. Verify during relationship setup.

See `reference/ndcinc-p2p.md` for the full MARS Medical testing strategy.

5. **Prod-only cleanup protocol.** When the customer has no NS sandbox (e.g., MARS Medical), all test transactions land in production. Before testing:
   - Agree with the customer on a test PO naming convention or numbering range
   - Have the customer keep a record of all test transaction numbers (POs, vendor bills, item fulfillments)
   - Plan for cleanup: test records must be deleted or voided after validation
   - Use Orderful TEST stream + `custrecord_ord_tran_testmode = T` to isolate test data from live processing
   - Validated May 2026: Logan (MARS Medical) confirmed he'd track test transaction numbers for later cleanup

## Behaviour rules

1. **Always use the v3 API.** No exceptions. v2 creates format mismatch errors.
2. **Always use test stream.** Never submit to `live` stream without explicit user direction.
3. **Never hard-code API keys in committed files.** Pass as environment variable or ask the user.
4. **Mark placeholders clearly.** Any data you can't populate should be marked `TODO_*` so it's obvious what needs replacing.
5. **Save the submission script.** Keep it in the onboarding docs directory for reuse and iteration.
6. **Document the transaction ID.** After successful submission, record the transaction ID in the onboarding tracker.

## Reference

- Orderful v3 API docs: `docs.orderful.com/reference/transactioncontrollerv3_create`
- Create a Transaction guide: `docs.orderful.com/docs/create-a-transaction`
- See `dsco-recon` skill for DSCO-specific transaction structure (15 REF segments, etc.)
- See `sps-recon` skill for extracting item data from SPS historical transactions
- See `audit-rules` skill — **audit /v2/rules BEFORE outbound testing** to catch silent segment stripping
