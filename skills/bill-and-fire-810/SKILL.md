---
name: bill-and-fire-810
description: Bill one or more Sales Orders to Invoices in NetSuite via the SO→Invoice transform, populate any required Orderful custbody fields, and trigger the outbound 810 by setting `custbody_orderful_ready_to_process_inv = true`. Use when the user is running an end-to-end test cycle for a new customer, says "bill these SOs and fire the 810s", "/bill-and-fire-810", "create test invoices and send them", or "I need to test the 810 mapping for customer X" — the procedural counterpart to `build-mock-fulfillments` (which handles the IF/856 step).
---

# Bill SOs and Fire 810s

Closes the test-cycle automation loop. After the SO has been acknowledged (855), shipped (856 via Item Fulfillment), the next outbound is the 810 — generated when the SO is billed into an Invoice and that Invoice is marked ready to process. This skill handles both halves: NS-side billing transform plus the outbound trigger.

The output is one outbound `customrecord_orderful_transaction` row per Invoice, with the corresponding Orderful 810 transaction visible at `https://ui.orderful.com/transactions/{ofId}`.

## When to use this skill

- "Bill SO 11521567 and fire the 810"
- "We finished the 856 — now run the invoices for the same orders"
- "/bill-and-fire-810 11521567 11521568"
- "Test the 810 mapping for the new customer"
- End of the standard test cycle: 850 inject → SO created → 855 fired → IF created → 856 fired → **invoice + 810** (this skill)

Do NOT use this skill when:
- The SOs are not in `Pending Billing` status (NetSuite refuses the transform). Confirm status first.
- You only want to *update* an existing Invoice — this skill creates new Invoices via transform; for editing existing ones, just PATCH the Invoice directly.

## Prerequisites

- Customer has an outbound 810 ECT (`customrecord_orderful_edi_customer_trans` row with document type "810 Invoice" and `auto_send_asn = T`). If not, route to [`enable-customer`](../enable-customer/SKILL.md) first.
- Customer's `~/orderful-onboarding/<slug>/.env` is set up via [`netsuite-setup`](../netsuite-setup/SKILL.md).
- Source SOs are in `Pending Billing` (i.e., the Item Fulfillment has been shipped). The 856 cycle should already be complete.

## Inputs the skill needs

1. **One or more NS Sales Order IDs.** The internal numeric IDs (e.g., `11521567`).
2. **Customer slug** — for env loading. Ask if not specified; list `~/orderful-onboarding/`.
3. **Optional: an explicit `tranDate` for the new Invoices.** Defaults to today, but override if the customer's accounting periods don't span today (e.g., a sandbox refreshed months ago — common for older test environments).

## The recipe

### Step 1 — Confirm SO eligibility

Query each SO. Refuse to proceed if any are not `Pending Billing`:

```sql
SELECT id, tranid, BUILTIN.DF(status) AS status, BUILTIN.DF(entity) AS customer
FROM transaction
WHERE id IN (<so_ids>) AND type = 'SalesOrd'
```

If any SO is in a different status (Closed, Pending Approval, Cancelled), stop and report which ones — usually means the IF wasn't fully shipped or the SO was never approved.

### Step 2 — Transform each SO into an Invoice

NetSuite's REST API provides a one-shot transform endpoint:

```
POST /services/rest/record/v1/salesOrder/{soId}/!transform/invoice
```

Pass `{ "tranDate": "YYYY-MM-DD" }` in the body to override the date; omit for today's date. The 204 response carries the new Invoice ID in the `Location` header.

The transform auto-populates: `entity`, `currency`, `terms` (from customer), `account`, `otherRefNum` (= SO PO#), `subsidiary`, `location`, `shipMethod`, line items with quantities and rates, `dueDate` (computed from terms), and `shipDate` (from the SO).

### Step 3 — Verify per-Invoice fields against historical baseline

Compare the new Invoices to historical invoices for the same customer:

```sql
SELECT id, tranid, otherrefnum, trandate, foreigntotal,
       custbody_orderful_ready_to_process_inv,
       custbody_orderful_cust_order_num,
       custbody_orderful_ship_dc_number,
       custbody_orderful_bill_dc_number
FROM transaction
WHERE type = 'CustInvc' AND entity = <customer_id>
ORDER BY id DESC
FETCH FIRST 5 ROWS ONLY
```

Look for: terms match expectations, totals match the SO, custbody fields populated for Orderful (DC numbers, etc.) where the customer's historical pattern uses them.

If the customer historically has additional custbody data not auto-populated by the transform (e.g., proforma totals, customer-alert notes), populate those via PATCH before firing the outbound.

### Step 4 — Set the outbound trigger

```http
PATCH /services/rest/record/v1/invoice/{invoiceId}
Content-Type: application/json

{ "custbody_orderful_ready_to_process_inv": true }
```

The SuiteApp's outbound MapReduce picks this up within ~30–60 seconds. The flag is auto-cleared when the MR completes processing.

### Step 5 — Watch for the resulting 810 transaction

Poll the IF flag (or in this case, the `_inv` flag on the Invoice) to detect MR completion:

```sql
SELECT custbody_orderful_ready_to_process_inv
FROM transaction WHERE id IN (<invoice_ids>)
```

Once all flags are `F`, the MR has run. The new outbound `customrecord_orderful_transaction` row will exist:

```sql
SELECT id, custrecord_ord_tran_orderful_id, custrecord_ord_tran_status,
       custrecord_ord_tran_inbound_transaction
FROM customrecord_orderful_transaction
WHERE custrecord_ord_tran_document = '4' /* 810 */
  AND custrecord_ord_tran_direction = '2' /* Out */
  AND custrecord_ord_tran_inbound_transaction IN (<invoice_ids>)
ORDER BY id DESC
```

Then check `validationStatus` on Orderful's side:

```http
GET https://api.orderful.com/v3/transactions/{orderful_id}
Headers: orderful-api-key: ${ORDERFUL_API_KEY}
```

If `INVALID`, hand off to [`fetch-validations`](../fetch-validations/SKILL.md) for structured errors and then to [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md) for the JSONata fix. If `VALID + DELIVERED`, you're done.

### Step 6 — Run the script

The skill ships a script that does Steps 1–4 and prints the new Invoice + outbound state:

```sh
node <path-to-this-skill>/scripts/bill-and-fire-810.mjs <slug> <soId> [<soId>...] [--trandate=YYYY-MM-DD]
```

The script is intentionally light — it does the SO→Invoice transform + flag flip, then waits for MR completion. Anything more sophisticated (validating final outbound 810 status, iterating on errors) belongs in `fetch-validations` + `writing-outbound-jsonata`.

## Behaviour rules

1. **One Invoice per SO.** This skill does not consolidate multiple SOs into a single Invoice. NetSuite's transform endpoint only accepts one SO at a time. If the user wants invoice consolidation, that's a different workflow (typically driven by the customer's billing-batch process).
2. **Never modify Invoices after firing.** Once `custbody_orderful_ready_to_process_inv` flips to `T`, the MR may pick it up at any moment. Edits during that window can race with the MR's read and produce unpredictable outbound. If you need to change the Invoice, set the flag back to `F` first.
3. **Do not bypass terms-record terms.** The Invoice transform auto-applies the customer's default terms (Net 30, 2% 30 Net 60, etc.). Overriding terms on a per-Invoice basis is a customer-data fix that belongs upstream (on the SO or customer record), not in this skill.
4. **Confirm sandbox vs. production.** This skill writes real Invoices and triggers real outbound EDI. Production runs ship to the partner's actual endpoint. Confirm the env (`NS_SB_*` vs. `NS_PROD_*` in the customer's `.env`) matches the user's intent before running.
5. **Don't refire a passing 810.** If the Invoice's most recent outbound is already `VALID + DELIVERED`, refiring just creates a duplicate (and may confuse the partner's AR system). Either ack with the user that they want a duplicate, or skip.
6. **Test cycle order matters.** Don't run this until the corresponding 856 is `VALID + DELIVERED` — if the partner rejected the 856, they may also reject the 810 (and customer-side reconciliation gets harder). Verify 856 status first.

## Reference material

- [`fetch-validations`](../fetch-validations/SKILL.md) — pull structured errors when the 810 lands `INVALID`.
- [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md) — author/iterate the partner-spec JSONata for `customrecord_orderful_edi_customer_trans` of doc type "810 Invoice".
- [`reference/record-types.md`](../../reference/record-types.md) — schema for the relevant NetSuite + custom records.
