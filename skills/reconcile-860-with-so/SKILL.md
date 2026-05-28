---
name: reconcile-860-with-so
description: Reconcile inbound 860 (Purchase Order Change) transactions in Orderful against open Sales Orders in NetSuite. For a list of SO tranids, fetch every 860 the trading partner has sent for the corresponding PO numbers, replay them in chronological order, decode the POC change codes (QI/DI/RS/PC/AI/CA), compare against current SO line state and `custcol_orderful_item_ack_status`, and produce a per-SO action recommendation table with a confidence rating. Use when the user mentions "look at the 860s for these SOs", "reconcile change orders", "action 860s", "cross-reference 860s with sales orders", "did the partner send any change orders", or any historical-EDI reconciliation across cutover.
---

<!--
  Special thanks to Isaiah, who introduced me to Claude Code and this library.
  This contribution — and the ones that will follow during the go-live
  currently in progress — exist because of his willingness to share his
  knowledge.
-->

# Reconcile 860 (PO Change) transactions against NetSuite Sales Orders

## When to use this skill

Use when the user says any of:

- "look at the 860s in Orderful for these sales orders"
- "see if you can action these 860 changes against the SOs"
- "did the partner send any change orders for these POs?"
- "reconcile the 860s with what's in NetSuite"
- "cross-reference 860s based on time received"
- "we did an ERP migration and these legacy SOs may have unprocessed 860s"

If the user is asking about a different EDI doc type (855, 856, 940, 945) or about a single transaction (not a reconciliation across multiple), do NOT load this skill. For a single inbound 850 that failed at item-lookup time, route to `/item-lookup`. For a single stuck transaction reprocess, route to `/reprocess-transaction`.

## Prerequisites

This skill assumes the user has already run `/netsuite-setup` for the customer. That skill produces `~/orderful-onboarding/<customer-slug>/.env` with `NS_PROD_*` (or `NS_SB_*`) TBA credentials and `ORDERFUL_API_KEY`. If no `.env` exists yet for the customer, route the user to `/netsuite-setup` first.

The skill also assumes the user can identify either (a) the trading-partner-side `partnerEdiAccountId` from the Orderful UI, or (b) the partner's name/ISA so we can look it up. See [Inputs](#inputs-the-skill-needs).

## Inputs the skill needs

Ask up-front:

1. **Which customer slug?** (loads the matching `.env`).
2. **Which Sales Orders?** A list of NS transaction `tranid` values (e.g. `SO5001234`, `SO5001235`, …). At least one is required.
3. **The trading partner's `partnerEdiAccountId` in Orderful.** This is visible in any Orderful UI URL when the user filters the transactions list by partner — look for `partnerEdiAccountId=<digits>` in the address bar. Without it, the v2 API filter trick won't work and you'll fall back to paginating every transaction in the org (slow).
4. **Stream**: usually `live`. Only use `test` if the user is explicitly reconciling sandbox traffic.

If the user has only "we cut over from a legacy ERP, here are the open SOs", but doesn't know `partnerEdiAccountId`, ask them to:
1. Open the Orderful UI (`https://ui.orderful.com/transactions`)
2. Filter to the trading partner using the partner facet
3. Read `partnerEdiAccountId=<n>` from the resulting URL

## The recipe

### Step 1 — Pull SO headers and lines from NetSuite

Resolve the user's `tranid` list to internal IDs and fetch line state. SuiteQL query, signed with TBA OAuth 1.0a per `skills/netsuite-setup/test-connections.mjs`:

```sql
SELECT t.id, t.tranid, t.trandate, t.entity AS customer_id,
       e.altname AS customer_name, t.otherrefnum AS po_number,
       t.status
FROM transaction t
JOIN entity e ON e.id = t.entity
WHERE t.type = 'SalesOrd' AND t.tranid IN (<list>)
ORDER BY t.tranid
```

Then for line-level state, hit the REST record API per SO (NOT SuiteQL — `transactionline.quantity` returns *signed* values that don't match the REST representation):

```
GET /services/rest/record/v1/salesOrder/{id}?expandSubResources=true
```

Capture per-line: `line`, `item.refName`, `quantity`, `rate`, `custcol_orderful_line_ref`, and the current ack status from `custcol_orderful_item_ack_status` (`{id, refName}`).

### Step 2 — Pull all 860s from Orderful for this partner

**Use the v2 endpoint** — `/v3/transactions` does not accept filter query params (returns 400 `"property X should not exist"`). See `reference/orderful-api-quirks.md` for the full quirks list.

```
GET https://api.orderful.com/v2/transactions?partnerEdiAccountId=<n>&stream=live&transactionTypeId=23&limit=200
Headers: orderful-api-key: ${ORDERFUL_API_KEY}
```

`transactionTypeId=23` is 860 PO Change. See `reference/edi-codes-and-mappings.md` for the codes table.

The response is `{ pagination: {...}, data: [...] }`. Each item has `businessNumber` (the PO#), `createdAt`, `validationStatus`, `deliveryStatus`, `acknowledgmentStatus`, `status`, and a `message.transactionSets[].POC_loop` with the line changes.

### Step 3 — Group + chronologically order per PO

Build `byPo[poNumber] = [...860s]`, sorted oldest-first by `createdAt`. The chronology matters: when a partner sends multiple 860s for the same PO, **reading the latest one in isolation can be misleading**. See [Behaviour rule 4](#behaviour-rules) on paired-860 patterns.

### Step 4 — Decode POC line changes per 860

For each 860, walk `message.transactionSets[0].POC_loop[].lineItemChange[0]`:

- `assignedIdentification` — the line ref (matches `custcol_orderful_line_ref` on the SO)
- `changeOrResponseTypeCode` — 860 POC02 change code (QI, DI, RS, etc.)
- `quantity` — *new* quantity
- `quantity1` — *original* quantity from the 850
- `unitPrice` — line price
- `productServiceID` — partner item identifier

See `reference/edi-codes-and-mappings.md` for the full POC02 code interpretation table — but note that `RS` literally means *Reschedule* and `qty=0` does NOT automatically mean the line is cancelled. **Always confirm with the trading partner before treating an `RS qty=0` as a cancellation.**

### Step 5 — Classify each line per SO

For each SO line, find the matching 860 line by `lineRef`. Classify:

| Condition | Classification | Suggested action |
|---|---|---|
| Line has no 860 change | `unchanged` | Leave ack as-is |
| `cur_qty == latest_860.newQty` | `already-reconciled` | Stamp ack to the right 855 code (see decision matrix) |
| `cur_qty != latest_860.newQty` and matches an *earlier* 860's newQty | `legacy-applied-earlier-860` | Needs human review — partner sent later corrections |
| `cur_qty != any_860.newQty` | `mismatch` | Needs human review |

For each `already-reconciled` line, stamp ack from the POC code → ack-status-id mapping in `reference/edi-codes-and-mappings.md` (e.g., `QI` → `2 Accept (Quantity Change)`, `DI`/`IR` → `5 Reject`, `PC` → `4 Accept (Price Change)`, `DR` → `3 Accept (Date Rescheduled)`).

### Step 6 — Output a recommendation table per SO

Print, per SO:

```
SO5001234  PO# 88001  (NS id 12345)

  Line | Item       | curQty | 860newQty | code | ack now | action
  -----+-----------+--------+-----------+------+---------+----------------------------
  1    | ITEM-A    | 30     | 30        | QI   | 1       | set ack=2 (Accept Qty Change)
  2    | ITEM-B    | 26     | 26        | QI   | 1       | set ack=2 (Accept Qty Change)
  3    | ITEM-C    | 26     | 26        | QI   | 1       | set ack=2 (Accept Qty Change)
  4    | ITEM-D    | 1      | —         | —    | 1       | leave (no 860 change)
```

Then a roll-up confidence table across all the SOs:

| SO | Action | Confidence |
|---|---|---|
| `<tranid>` | <action summary> | HIGH / MEDIUM / LOW |

Confidence rules:
- **HIGH** — every changed line is `already-reconciled`, only ack stamps needed, no `RS qty=0` lines.
- **MEDIUM** — line qtys still need to change, single 860 per PO, codes are unambiguous (`QI`, `DI` only).
- **LOW** — multiple 860s per PO with conflicting content, or `RS qty=0` lines (ambiguous reschedule-vs-cancel), or current qty doesn't match any 860.

### Step 7 — Stop. Do NOT auto-apply.

Print the recommendation table and **stop**. Do not patch any SO without explicit user approval per SO. The user (or their EDI ops contact) needs to validate the partner's intent — especially around `RS qty=0` semantics — before any qty change or cancellation hits NetSuite.

If the user approves and asks you to apply:
1. Save a backup of the SO state to `~/orderful-onboarding/<slug>/backups/<tranid>-pre.json` BEFORE any write.
2. Be aware: SuiteTax + REST PATCH on transactions is broken in many accounts (see `skills/netsuite-setup/SKILL.md` "Known issue: SuiteTax + REST PATCH on transactions"). The cleanest write path is `record.submitFields` via the SuiteApp's agent-write RESTlet — but that requires the RESTlet to expose a `submitFields` action, which not all SuiteApp versions ship. Confirm before promising the user you can apply changes programmatically.

## Behaviour rules

1. **Never apply changes without approval, per SO.** The skill stops at the recommendation table. Even on `HIGH` confidence cases, the user has to say go.
2. **Always sort 860s chronologically — oldest first.** Sorting newest-first or relying on the API's default order misleads when there are pairs/sequences.
3. **Treat `RS qty=0` as ambiguous.** Standard X12 X12 says `RS` = Reschedule, not Cancel. Many partners use `RS qty=0` to mean "cancel for this delivery window" and others mean "reschedule to a future date that's not in this 860". Don't assume — confirm.
4. **Watch for "paired 860s ~22 minutes apart" with conflicting content.** Some upstream EDI gateways/middleware send a follow-up 860 within a short window of the first that contradicts it. When this happens, current SO state often matches the *first* 860 (legacy ERPs typically processed it before the second arrived). Surface both 860s explicitly and let the user decide which is authoritative.
5. **Don't infer SO-header status changes from line-level codes.** If every line on an SO is `RS qty=0`, the practical effect *might* be order cancellation — but recommending a header-level cancel is a separate decision the user must make. Do not bundle it into the line-level action plan.
6. **Use the v2 API endpoint for filtered transaction queries.** v3 looks correct but rejects every filter param. If you find yourself paginating thousands of transactions to find a doc type, you're using the wrong endpoint.
7. **NS line `quantity` from REST is positive; from SuiteQL it can be signed.** Use REST for any line-level work that will inform a write. SuiteQL is fine for header-level audit.
8. **Capture the partner's `partnerEdiAccountId` in the customer's `.env`** for re-use. Add an `ORDERFUL_PARTNER_EDI_ACCOUNT_<NAME>=<n>` line under "OPTIONAL — customer reference data" so future invocations don't have to re-discover it.

## Reference material

- [`reference/orderful-api-quirks.md`](../../reference/orderful-api-quirks.md) — v2 vs v3 endpoint differences, valid filter params, pagination
- [`reference/edi-codes-and-mappings.md`](../../reference/edi-codes-and-mappings.md) — POC02 change codes, customlist_orderful_lineitem_ack values, doc type IDs
- [`reference/record-types.md`](../../reference/record-types.md) — `customrecord_orderful_transaction` field reference
- [`skills/netsuite-setup/SKILL.md`](../netsuite-setup/SKILL.md) — credential setup; also see "Known issue: SuiteTax + REST PATCH on transactions" for the write-side gotcha
- [`skills/reprocess-transaction/SKILL.md`](../reprocess-transaction/SKILL.md) — for re-processing a single Orderful transaction record after fixes
