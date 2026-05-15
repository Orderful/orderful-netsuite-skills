---
name: bill-test-invoice
description: Transform a NetSuite Sales Order into an Invoice via REST so the 810 outbound flow can be tested end-to-end without opening the NetSuite UI. Handles the recurring "Please enter value(s) for: <field>" error that fires when the SO's customform requires fields the SO doesn't have, by discovering the missing fields one at a time, PATCHing the SO, and retrying. After the transform succeeds, resets the new invoice's customform to match the customer's prod invoice shape. Use when the user says "bill the SO", "create a test invoice from <SO>", "test the 810", "transform SO to invoice", "/bill-test-invoice", or wants a billable invoice produced from a sandbox SO without manual UI clicking.
---

# Bill Test Invoice

The standard NS path to test the 810 outbound flow is: pick a Sales Order in `Pending Billing`, transform it into an Invoice, set the 810 trigger flag, and watch the outbound transaction. The REST endpoint that does the transform — `POST /record/v1/salesOrder/{id}/!transform/invoice` — works in principle, but in practice it returns HTTP 400 with `Please enter value(s) for: <field>` whenever the SO's customform marks a field mandatory that the SO doesn't have set. Customers like to lock down their forms with mandatory custom fields ("Order Type", "Required By Date", "Sales Rep", etc.) that exist on the SO record but aren't always populated for every workflow path — and the transform inherits those rules.

This skill is the discovery-and-fix loop: PATCH the SO with each reported missing field until the transform succeeds, then reset the resulting invoice's customform to whatever shape prod uses (which is typically NOT the SO's form).

## When to use this skill

Trigger when the user says any of:
- "/bill-test-invoice"
- "bill the SO" / "transform the SO to invoice"
- "create a test invoice from `<SO>`" / "I need an invoice for `<SO>`"
- "test the 810 path" / "set up the 810 reprocess"
- "the SO transform is rejecting with 'Please enter value(s) for'"
- "create a billable invoice without going into NetSuite"

Do NOT load this skill for:
- **Real billing operations.** This produces a sandbox invoice for testing the EDI flow. Production billing should run through the customer's actual workflow, not REST.
- **Non-SO sources.** The transform endpoint only accepts `salesOrder` as the source. CashSale, Estimate, etc. follow different paths.

## Inputs the skill needs

1. **Source SO internal id or tranid.** The SO must be in a billable status (`Pending Billing` is the typical one). If it's `Pending Approval`, route to approving the SO first.
2. **(Optional) Target invoice customform id.** If known, the skill will reset the new invoice's `customForm` to this id immediately after transform. The right value is whatever customform prod invoices for this customer use (look at recent prod invoices to find it, e.g. `BUILTIN.DF(customform)` returns `[SSC] SL | Invoice` with id `419` for one customer; varies per customer). If unknown, the skill leaves the invoice on the default form and flags it for the user.
3. **(Optional) Reset the SO's customform after transform.** If the SO's customform was temporarily switched to satisfy the transform, restore it.

## The recipe

### Step 1 — Pull SO state

```sql
SELECT id, tranid, BUILTIN.DF(status) AS status, customform, BUILTIN.DF(customform) AS form_name
FROM transaction
WHERE id = <so_id>
```

Confirm:
- Status is `Pending Billing` (or another billable state).
- `customform` is the customer's expected SO form.
- For context, also look at the customer's `custentity_orderful_inv_handling_prefs` — if it's unset, the 810 won't fire even after the invoice is created (see [`enable-customer`](../enable-customer/SKILL.md)'s post-enablement checklist).

### Step 2 — Attempt the transform with an empty body

```http
POST /services/rest/record/v1/salesOrder/<so_id>/!transform/invoice
Content-Type: application/json

{}
```

Three possible outcomes:

- **HTTP 204 + `Location: .../invoice/<id>`** — transform succeeded; skip to Step 5.
- **HTTP 400 + `Please enter value(s) for: <field>`** — proceed to Step 3.
- **HTTP 400 + `That is not a valid record transformation`** — the SO is not in a state the transform supports (e.g., closed, fully billed, or has a customform that disables the transform path). Stop and surface this to the user; it usually means the SO's status or customform needs to change.

### Step 3 — Decode the missing field name into a NetSuite scriptid

The `<field>` returned in the error is the **display label**, not the scriptid. The label and scriptid often diverge. Common mappings (verified across multiple customers):

| Display label | Scriptid | Notes |
|---|---|---|
| Order Type | `custbody_ssc_order_type` (or similar `custbody_*_order_type`) | Customer-specific custom list. Probe `customlist_*_order_type` for valid IDs. |
| Required By Date | `custbody_ssc_requested_date` (note: *requested*, not *required*) | Date field; the label-to-scriptid divergence is a footgun. |
| Sales Rep | `salesrep` (native) | Reference to employee. |
| Requested Date Type | `custbody_sl_requested_date_type` | Customer-specific custom list. |
| Department | `department` (native) | Reference. |
| Class | `class` (native) | Reference. |

If the label doesn't match any known mapping, search NetSuite's custom-field index by similarity:

```sql
SELECT scriptid FROM customfield WHERE LOWER(scriptid) LIKE '%<label_keyword>%'
```

— and check the result against the field's display label in the NS UI. If still ambiguous, ask the user to confirm which scriptid to populate.

### Step 4 — PATCH the SO with the missing field, then retry

```http
PATCH /services/rest/record/v1/salesOrder/<so_id>
Content-Type: application/json

{ "<scriptid>": <value> }
```

Then re-issue the Step 2 transform. Loop until the transform succeeds OR the missing field is one the user can't supply (e.g., a value they don't have data for). On stall, surface the field to the user with the suggested type / valid values and ask.

### Step 5 — Reset the new invoice's customform to match prod

The newly-created invoice inherits the SO's customform by default. That's almost always wrong — prod invoices typically land on a different form (`[SSC] SL | Invoice`, `[Customer] Invoice`, etc.) than the SO they were created from. Patch it explicitly:

```http
PATCH /services/rest/record/v1/invoice/<invoice_id>
Content-Type: application/json

{ "customForm": { "id": "<prod_invoice_form_id>" } }
```

If you don't know the prod customform id, query a recent prod invoice for the same customer:

```sql
SELECT TOP 5 id, tranid, customform, BUILTIN.DF(customform) AS form_name
FROM transaction
WHERE type = 'CustInvc' AND entity = <customer_id>
ORDER BY id DESC
```

— and use whichever form dominates.

### Step 6 — Verify and (optionally) trigger the 810

Read back the invoice:

```sql
SELECT id, tranid, BUILTIN.DF(status), total, BUILTIN.DF(customform) AS form,
       custbody_orderful_ready_to_process_inv AS ready,
       custbody_orderful_force_autosend AS force_send
FROM transaction
WHERE id = <invoice_id>
```

Expect: `Open` status, total matching the SO total, customform = the form set in Step 5, `ready_to_process_inv` and `force_autosend` both false (default).

To trigger the 810 outbound flow, flip both flags:

```http
PATCH /services/rest/record/v1/invoice/<invoice_id>
Content-Type: application/json

{
  "custbody_orderful_ready_to_process_inv": true,
  "custbody_orderful_force_autosend": true
}
```

Then poll `customrecord_orderful_transaction` filtered to `direction=2` AND doc type matching 810 for the new outbound row. If nothing appears within ~3 minutes, check `custentity_orderful_inv_handling_prefs` on the customer — it MUST be set (typically id 1, "Process on invoice creation") for the SuiteApp's MR to enqueue the 810. See [`enable-customer`](../enable-customer/SKILL.md)'s post-enablement checklist.

## Behaviour rules

1. **Discover missing fields one at a time.** The transform error reports one field at a time. Don't try to anticipate all the missing fields up front — PATCH one, retry, repeat. The customer's customform may chain dependent requirements (e.g., setting Order Type unlocks a different "Required By Date" requirement).
2. **PATCH the SO, don't edit the customform.** If a customform requires a field, the right answer is to populate the field, not to switch to a permissive form. Switching customforms changes the data shape of the SO and can break downstream automation that gates on form id.
3. **Always reset the invoice's customform after transform.** The default (inherit-from-SO) is almost never what prod uses. If you don't know the right form, surface it to the user before declaring done — don't silently leave the invoice on the wrong shape.
4. **Don't satisfy required-by-date with a fake date that breaks downstream logic.** Some customer scripts use this date to drive freight planning, scheduling, or status workflows. A test value far in the future is usually safe; a value in the past or 1900-01-01 sometimes triggers other checks. Default to the SO's existing ship date or +7 days from today.
5. **Don't run this in a production NetSuite account.** This is a sandbox testing tool. The skill should refuse to run if `.env`'s `ENVIRONMENT` is `production`. (If the user explicitly overrides, log a loud warning.)
6. **The transform respects accounting/period rules.** If the SO's date is in a closed accounting period, the transform will fail with a different error class. Surface that to the user; don't try to work around it by changing dates.

## Common gotchas

- **Display label ≠ scriptid.** "Required By Date" is `custbody_ssc_requested_date` on at least one customer (note: *requested*, not *required*). Don't assume.
- **Setting one field unlocks another error.** The customform's mandatory-field rules apply incrementally. After patching Order Type, the next transform attempt may surface a brand new field. Loop, don't batch.
- **The new invoice's customform is the SO's customform.** Always reset it explicitly.
- **A successful transform doesn't guarantee 810 will fire.** The customer's `custentity_orderful_inv_handling_prefs` must be set, AND the ECT for 810 must have `auto_send_asn=T`, AND the invoice's `custbody_orderful_ready_to_process_inv` must be true. Three independent gates.
- **Per-line transforms.** The transform endpoint takes the SO's full line set by default. To bill only some lines, pass an explicit `item.items` array in the body — but this is rare for testing; usually you want the full SO billed.

## Reference material

- [`enable-customer`](../enable-customer/SKILL.md) — covers `custentity_orderful_inv_handling_prefs` (the gate that must be set before 810 outbound MR will pick up the new invoice).
- [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md) — once the invoice exists and 810 fires, this skill takes over for any JSONata adjustments needed to satisfy the partner spec.
- [`audit-outbound-rules`](../audit-outbound-rules/SKILL.md) — Step 0 before authoring 810 JSONata; ensure the partner relationship's outbound rules don't strip required segments.
