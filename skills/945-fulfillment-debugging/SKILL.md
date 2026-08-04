---
name: 945-fulfillment-debugging
description: Diagnose 945 Warehouse Shipping Advice problems that produce a wrong Item Fulfillment, 856, or 810 — over-fulfillment, under-fulfillment, or a stuck/erroring inbound transaction. Use when a 945 short-ship (omitted lines or fewer units) produces a wrong IF/856/810, an Orderful Transaction is stuck "Stale - Max Retries Exceeded", or you hit any of: "Item … not found in itemFulfillment", "Fulfillment quantity N is greater than expectation quantity M", "You must enter at least one line item", "Multiple sales orders found for purchase order number", or NonInvtPart lines that won't fulfill.
---

# 945 Fulfillment Debugging

A triage playbook for 945 (Warehouse Shipping Advice) problems that produce a
wrong Item Fulfillment, 856, or 810. Covers both failure directions —
over-fulfillment/over-invoicing and under-fulfillment/thrown errors — plus the
duplicate-sales-order trap that looks like a bug but is actually bad test/order
data.

This skill is read-only diagnosis. It tells you what's wrong, why, and whether
it's something you can resolve yourself (usually: duplicate sales orders) or
something to escalate to engineering with the right evidence attached
(usually: a fulfillment/reconciliation defect).

## When to use this skill

- "A 945 short-ship is over-fulfilling the Item Fulfillment"
- "The 810 is billing lines that weren't actually shipped"
- "`Item <id> not found in itemFulfillment`"
- "`Fulfillment quantity N is greater than expectation quantity M`"
- "`You must enter at least one line item for this transaction`"
- "`Multiple sales orders found for purchase order number: PO…`"
- "This Orderful Transaction is stuck `Stale - Max Retries Exceeded`"
- "A fulfillable non-inventory item line won't fulfill from the 945"
- "/945-fulfillment-debugging"

Do NOT use this skill for:
- Inbound 850 → Sales Order mapping problems (wrong ship-to, missing item) —
  that's [`inspect-inbound-diagnostics`](../inspect-inbound-diagnostics/SKILL.md)
  or [`item-lookup`](../item-lookup/SKILL.md).
- Outbound validation failures on the 856/810 itself (a segment/field is
  malformed, not a quantity/line-selection problem) — that's
  [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md) or
  [`fetch-validations`](../fetch-validations/SKILL.md).
- A transaction that simply never polled — check
  [`monitor-mr`](../monitor-mr/SKILL.md) / [`run-poller`](../run-poller/SKILL.md) first.

## Inputs the skill needs

1. **The failing/suspect artifact** — an Orderful Transaction id, the NS
   internal id of `customrecord_orderful_transaction`, the resulting Item
   Fulfillment id, or the PO/SO number.
2. **Customer + environment** (sandbox/production). Load `.env` per
   [`netsuite-setup`](../netsuite-setup/SKILL.md) conventions if you need to
   run SuiteQL.
3. **Whether the order is a Sales Order or a Transfer Order** — the two flows
   share most logic but can behave slightly differently on which item types
   get fulfilled (see the escalation note in Step 5).

## Mental model

> **The one rule that governs correct behavior:** regardless of item type,
> fulfill only items that are both (a) *fulfillable* (the item's "Can be
> fulfilled/received" flag is checked) and (b) *actually on the 945*. Not
> fulfillable → ignore. On the Sales Order but not on the 945 → ignore.

Every symptom in this area is a violation of that rule in one direction:
- **Over-fulfill**: a line *not on the 945* got fulfilled anyway (usually
  ships too much, and the customer gets over-invoiced on the 810).
- **Under-fulfill / throw**: a line *on the 945* couldn't be fulfilled — it
  got dropped, or matched to the wrong Sales Order line.

### The flow, in plain terms

1. The warehouse sends a 945 (EDI shipping advice) saying what actually
   shipped.
2. Orderful's inbound poller picks it up and hands it to the connector, which
   finds the matching Sales Order (or Transfer Order) and figures out which
   lines/quantities correspond to what was shipped.
3. NetSuite's standard Sales Order → Item Fulfillment transform starts by
   defaulting **every fulfillable line to "receive at full ordered quantity."**
   The connector's job is to correct that default down to what the 945 says
   actually shipped — deselecting or reducing anything the 945 didn't confirm.
4. The saved Item Fulfillment drives the outbound 856 (ship notice) to the
   partner.
5. When the customer bills the Sales Order to an Invoice, the invoice's own
   line quantities (which trace back to what was actually fulfilled) drive the
   outbound 810. **The 810 does not re-check the Sales Order** — if the Item
   Fulfillment over-shipped a line, the invoice and the 810 will too.

That last point matters for triage: an over-invoice complaint almost always
traces back to an over-fulfilled Item Fulfillment, not to anything specific to
the 810 itself. Start your diagnosis at the Item Fulfillment, not the invoice.

## The recipe

### Step 1 — Read the logs, don't theorize

Read the connector's **Script Execution Log** (`scriptnote`) filtered to
`type IN ('ERROR','EMERGENCY')`, and the **Orderful Transaction** status. Then
decode via the symptom table below before assuming what's wrong.

### Step 2 — Symptom → likely cause decoder

| What you see | What it likely means | What to check next |
|---|---|---|
| Item Fulfillment has lines the 945 never shipped; the 810 bills them | The reconciliation step kept the NetSuite default (full ship) for a line the 945 didn't confirm | Compare the 945, the Sales Order, and the Item Fulfillment line-by-line (Step 4) |
| `Item <id> not found in itemFulfillment` | A line the 945 says shipped wasn't eligible to be fulfilled in NetSuite's eyes | Check whether that item is marked fulfillable on the item record |
| `Fulfillment quantity N is greater than expectation quantity M` | The shipped quantity got matched to the **wrong** Sales Order line (or it's a genuine over-ship from the warehouse) | Check the identifiers the 945 used to match the line (Step 3) |
| `You must enter at least one line item for this transaction` | After reconciliation, **zero** lines ended up selected — nothing on the 945 resolved to a Sales Order line | Check the 945's line identifiers against the Sales Order (Step 3) |
| `Multiple sales orders found for purchase order number: PO…` | There's more than one Sales Order for that PO number | This is almost always duplicate/bad order data, not a connector bug (Step 6) |
| Orderful Transaction status `Stale - Max Retries Exceeded` | Processing errored on every retry and gave up | Find the underlying error in `scriptnote` — decode via the rows above |
| Orderful Transaction status `Success` but the Item Fulfillment is wrong | It processed without error, but produced the wrong result | Compare the 945 vs. Item Fulfillment (Step 4); escalate with that evidence |

### Step 3 — Understand how a shipped line gets matched to a Sales Order line

The connector matches each shipped line on the 945 to a Sales Order line using
identifiers, in this priority order:

1. **PO line reference** — the most precise; disambiguates when the same SKU
   appears on multiple lines of the order.
2. **Vendor number** — matched against the NetSuite item id/name (not an
   actual vendor record — the field is just being reused as an identifier
   here).
3. **UPC** — matched against the item's real UPC code on the item record.

Gotchas worth knowing before you assume the data is wrong:
- A UPC that only exists in Orderful's item-lookup table (used for *inbound*
  850s) is **not** the same as the item's UPC field in NetSuite — it will not
  match at step 3.
- A PO line reference segment on the EDI is not always read as the "PO line
  ref" the matcher uses — don't assume a value you see in one EDI segment is
  automatically the one driving the match. If matching seems wrong, check
  which of the three identifiers above the warehouse actually sent, rather
  than assuming the segment you're looking at is authoritative.

### Step 4 — Compare the three artifacts

Pull these three and line them up by item / line reference:

- **The 945** — what the warehouse says it shipped, and how much, per line.
- **The Sales Order** — what was ordered, and whether each line is
  fulfillable.
- **The Item Fulfillment** — what NetSuite actually marked as
  received/shipped.

A line that appears **on the Sales Order and on the Item Fulfillment but not
on the 945** is the over-fulfillment smoking gun — NetSuite's default shipped
something the warehouse never confirmed.

A line that's **on the 945 but missing from the Item Fulfillment** (or threw
an error) means the matching/eligibility step dropped it — check Step 3
(matching) and whether the item is flagged fulfillable.

Useful SuiteQL when you have query access:

**Recent status of 945 transactions for this integration:**
```sql
SELECT ot.id, BUILTIN.DF(ot.custrecord_ord_tran_status) status,
       ot.custrecord_ord_tran_orderful_id oid
FROM customrecord_orderful_transaction ot
JOIN customrecord_orderful_edi_document_type d ON d.id = ot.custrecord_ord_tran_document
WHERE d.scriptid = '945_WAREHOUSE_SHIPPING_ADVICE'
ORDER BY ot.id DESC FETCH FIRST 5 ROWS ONLY
```

**The actual thrown error, if any:**
```sql
SELECT title, SUBSTR(detail,1,600) detail, type
FROM (SELECT title, detail, type, internalid FROM scriptnote
      WHERE type IN ('ERROR','EMERGENCY') ORDER BY internalid DESC)
WHERE ROWNUM <= 25
```
If the log is noisy with other failures, narrow it to your transaction:
```sql
SELECT title, SUBSTR(detail,1,700) detail, type FROM scriptnote
WHERE detail LIKE '%<itemId>%' OR detail LIKE '%<orderfulId>%' OR detail LIKE '%<PO#>%'
ORDER BY internalid DESC FETCH FIRST 15 ROWS ONLY
```

**Item Fulfillment line quantities (including non-inventory items, which some
standard NetSuite reports silently exclude):**
```sql
SELECT i.itemid, ABS(tl.quantity) quantity
FROM transactionline tl JOIN item i ON i.id = tl.item
WHERE tl.transaction = <itemFulfillmentId>
  AND tl.itemtype IN ('InvtPart','Assembly','Kit','NonInvtPart')
  AND tl.kitcomponent = 'F'
  AND (tl.accountinglinetype IS NULL OR tl.accountinglinetype NOT IN ('COGS','TAX','GAINLOSS','ASSET'))
```

### Step 5 — Recognize the two most common root causes (for escalation)

If your comparison in Step 4 confirms an over- or under-fulfillment, it's
almost always one of these two connector-level issues. You don't need to fix
either yourself — but naming the right one when you escalate saves engineering
a round of re-diagnosis:

**A — lines the 945 didn't confirm aren't being deselected.** The
connector is supposed to positively deselect any line NetSuite's default
tried to ship that the 945 didn't actually confirm. When that "deselect the
rest" step is missing or broken, unconfirmed lines silently stay fulfilled
(and get over-invoiced downstream). This affects both Sales Order and
Transfer Order fulfillment from a 945.

**B — a fulfillable non-inventory item got excluded from consideration.**
Some part of the connector may filter candidate lines by item type (e.g. only
considering standard inventory/assembly/kit items) instead of by the item's
actual fulfillable flag. A fulfillable non-inventory item then either gets
silently over-fulfilled (never reconciled against the 945) or throws an
"item not found" error when the warehouse ships it. This is usually a
Sales-Order-flow-specific gap — if you're looking at a Transfer Order and see
the same non-inventory-item symptom, call that out explicitly, since it may
be a separate, not-yet-covered case.

### Step 6 — Rule out duplicate Sales Orders before assuming a matching bug

The connector matches an inbound 945 to a Sales Order by PO number. If **more
than one Sales Order exists for the same PO number**, matching becomes
ambiguous and processing stops with "Multiple sales orders found." This is the
single biggest time-sink in this area because it looks like a resolution bug
but is actually bad order data:

```sql
SELECT id, tranid, BUILTIN.DF(entity) cust
FROM transaction WHERE type='SalesOrd' AND otherrefnum = '<PO#>' ORDER BY id
```

If this returns more than one row for the PO, that's your answer. Common
causes:
- The same inbound 850 (purchase order) got processed more than once,
  creating duplicate Sales Orders.
- A PO number was reused across multiple orders when it should have been
  unique.

What to do:
- **Don't delete the duplicate Sales Orders** without checking first — they
  may already have downstream Item Fulfillments or Invoices attached, and
  deleting them can cause other data problems.
- Flag the duplicate to whoever owns order creation for this customer so the
  root cause (why the same PO got processed twice, or why the PO number
  repeated) gets addressed there, rather than trying to "fix" it by editing
  the 945 handling.

## Behaviour rules

1. **Decode the symptom before assuming a fix is needed.** Most failures in
   this area map to one of the patterns above. Confirm which one with the
   comparison in Step 4 before telling anyone (including yourself) what's
   broken.
2. **Rule out duplicate Sales Orders first** whenever you see "Multiple sales
   orders found." It is very often bad order data, not a connector defect —
   don't escalate it as a code bug without checking Step 6 first.
3. **Don't delete or merge duplicate Sales Orders yourself.** They can have
   dependent Item Fulfillments or Invoices. Flag them for the order-creation
   owner instead.
4. **Escalate connector-level fulfillment defects (Step 5, patterns A/B) to
   engineering with the three-artifact comparison attached** (945 vs. Sales
   Order vs. Item Fulfillment, per Step 4) — that evidence is what turns a
   vague "over-fulfillment" report into an actionable ticket.
5. **This skill is read-only.** It diagnoses; it does not create, edit, or
   delete NetSuite records or Orderful data. Any fix (code change, order
   cleanup) happens outside this skill.
6. **No customer data in write-ups.** Strip real customer names, account IDs,
   PO numbers, and internal ticket numbers when sharing findings outside the
   immediate support thread.

## Reference material

- [`inspect-inbound-diagnostics`](../inspect-inbound-diagnostics/SKILL.md) — for inbound 850 mapping problems upstream of the Sales Order this skill starts from.
- [`monitor-mr`](../monitor-mr/SKILL.md) — watch the inbound poller run and confirm an Orderful Transaction's actual status before diagnosing further.
- [`reprocess-transaction`](../reprocess-transaction/SKILL.md) — re-run a 945 after an underlying issue (e.g. a duplicate order) has been resolved.
- [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md) / [`fetch-validations`](../fetch-validations/SKILL.md) — for 856/810 *validation* errors, as opposed to the quantity/line-selection problems this skill covers.
