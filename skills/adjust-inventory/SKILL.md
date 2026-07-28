---
name: adjust-inventory
description: Create a NetSuite Inventory Adjustment to fix a drained-stock problem in a sandbox/dev account — when an item shows 0 (or too little) available quantity at a location and that's blocking a test (a 945/856 fulfillment failing with "You must have at least one valid line item," a sales order that won't commit, etc.). Use when the user says "the item has no stock", "increase on-hand for this SKU", "adjust inventory for `<item>` at `<location>`", "the sandbox is out of stock again", "/adjust-inventory", or when diagnosis of a fulfillment failure traces back to zero available quantity rather than a mapping/code bug.
---

# Adjust Inventory

Shared dev/sandbox NetSuite accounts get their stock drained over time by repeated
test runs — sales orders commit inventory, fulfillments consume it, and nobody
replenishes it. The result: a test that has nothing to do with inventory (a 945
shipping-advice test, an 856 build, an SO commit) fails with a misleading
downstream error, when the real cause is simply **zero available quantity** for
that item at that location.

This skill is the diagnosis-and-fix loop: confirm the failure really is a stock
problem (not a mapping/code bug), then create a Positive Inventory Adjustment to
top up the item so testing can continue.

## When to use this skill

- "The 945 test keeps failing with 'You must have at least one valid line item'"
- "SKU-003 has 0 available at this location — can you fix that?"
- "The sandbox is out of stock again"
- "Increase on-hand for `<item>` at `<location>`"
- "/adjust-inventory"
- Any fulfillment/commitment failure where the BDO or transform looks correct
  but the resulting record has no selectable/fulfillable lines

Do NOT use this skill for:
- **Production inventory corrections.** This is a sandbox/dev testing aid, not a
  cycle-count or real inventory-accuracy fix. Real inventory adjustments in a
  live account should go through the customer's own accounting-approved process.
- **A genuine mapping or code defect.** If the item has plenty of available
  stock and the failure persists, this isn't a stock problem — see
  [`945-fulfillment-debugging`](../945-fulfillment-debugging/SKILL.md) or
  [`inspect-inbound-diagnostics`](../inspect-inbound-diagnostics/SKILL.md)
  instead.
- **Lot-, serial-, or bin-tracked items** without first confirming inventory
  detail can actually be supplied for the adjustment (see gotchas below) — for
  those items, doing this in the NetSuite UI is often more reliable than REST.

## Inputs the skill needs

1. **The item and location** with the availability problem (SKU/item id,
   location id or name).
2. **Confirmation this is sandbox/dev, not production.** This skill should
   refuse to proceed against a production account.
3. **A subsidiary** the item is actually assigned to at that location (OneWorld
   accounts) — don't guess; look it up (Step 1).
4. **How much to add.** When in doubt, add a large buffer (e.g. +100,000) rather
   than the exact amount needed for one test — the point is to stop the shared
   sandbox from draining again on the very next run.

## The recipe

### Step 1 — Confirm it's actually a stock problem

Don't jump to "adjust inventory" just because a fulfillment failed. Check the
item's actual on-hand/available/committed quantity at the location first:

```sql
SELECT ail.item, ail.location,
       ail.quantityonhand, ail.quantityavailable, ail.quantitycommitted
FROM aggregateItemLocation ail
WHERE ail.item = <itemId> AND ail.location = <locationId>
```

If `quantityavailable` is 0 (or too small for what the test needs) while
`quantityonhand` shows the stock is fully committed elsewhere, that confirms
the drained-sandbox pattern: there's inventory on the books, but none of it is
free to allocate to a new order/fulfillment. This is the same check used in
[`945-fulfillment-debugging`](../945-fulfillment-debugging/SKILL.md) Step 4 and
in the outbound readiness checklist
([`reference/outbound-source-readiness.md`](../../reference/outbound-source-readiness.md)) —
if you're already mid-diagnosis there, you may already have this answer.

If `quantityavailable` is healthy and the failure persists, stop — this isn't
an inventory problem. Route back to the relevant debugging skill instead of
adjusting stock that doesn't need adjusting.

### Step 2 — Confirm the subsidiary and location context

In a OneWorld account, the adjustment's subsidiary must be one the item is
actually assigned/available to — a mismatch fails the save with a subsidiary
restriction error, not a helpful "wrong subsidiary" message. Check which
subsidiary the item and location resolve to before building the request:

```sql
SELECT id, itemid, BUILTIN.DF(subsidiary) AS subsidiary
FROM item WHERE id = <itemId>
```

### Step 3 — Create the Positive Inventory Adjustment

```http
POST /services/rest/record/v1/inventoryAdjustment
Content-Type: application/json

{
  "account": { "id": "<inventory-write-off-or-adjustment-account-id>" },
  "adjLocation": { "id": "<locationId>" },
  "subsidiary": { "id": "<subsidiaryId>" },
  "memo": "Dev sandbox replenishment — <item> at <location>",
  "inventory": {
    "items": [
      { "item": { "id": "<itemId>" }, "location": { "id": "<locationId>" }, "adjustQtyBy": 100000 }
    ]
  }
}
```

Notes on the shape:
- The header field is **`adjLocation`**, not `location` — that's easy to
  transpose. The per-line field is `location` (matters most in multi-location
  inventory; set it to match the header for a single-location adjustment).
- The quantity field on each line is a **signed delta**, not an absolute new
  total: positive increases on-hand, negative decreases it. **Verify the exact
  field name against a live record in your account before relying on this** —
  it should be `adjustQtyBy`, but confirm on a real POST/GET round-trip rather
  than assuming, since this hasn't been independently confirmed against this
  connector's own sandbox.
- `account` is whatever account this NetSuite account uses for inventory
  adjustments — commonly something like "Inventory Write Offs" or "Inventory
  Adjustments," but that's a chart-of-accounts convention, not a NetSuite
  requirement. Look up the account this customer/sandbox normally uses rather
  than assuming a name:
  ```sql
  SELECT id, acctname, accttype FROM account
  WHERE UPPER(acctname) LIKE '%INVENTORY%WRITE%' OR UPPER(acctname) LIKE '%INVENTORY%ADJUST%'
  ```

### Step 4 — Verify the adjustment landed

Re-run the Step 1 query. `quantityavailable` should reflect the increase
immediately — inventory adjustments post in real time, there's no batch delay
to wait out.

```sql
SELECT quantityonhand, quantityavailable, quantitycommitted
FROM aggregateItemLocation
WHERE item = <itemId> AND location = <locationId>
```

### Step 5 — Re-run the original failing test/flow

Now that availability is fixed, re-drive whatever was failing (reprocess the
945 via [`reprocess-transaction`](../reprocess-transaction/SKILL.md), retry the
fulfillment build via [`build-mock-fulfillments`](../build-mock-fulfillments/SKILL.md),
etc.) to confirm the original failure is gone.

## Behaviour rules

1. **Confirm it's a stock problem before adjusting anything.** Run the Step 1
   query first. Don't create an inventory adjustment on a hunch — verify
   `quantityavailable` is actually the bottleneck.
2. **Never run this against production.** This is a sandbox/dev testing aid.
   Confirm the environment before creating the record; refuse (or loudly
   confirm override) if the account looks like production.
3. **Over-adjust rather than under-adjust in shared dev sandboxes.** A shared
   sandbox will drain again on the next round of test runs. Adding a large
   buffer (e.g. +100,000) is cheaper than repeating this skill every few days
   for the same item.
4. **Don't guess the subsidiary or account.** Look up what the item/location
   actually resolve to (Step 2) and what account this account's other
   inventory adjustments use (Step 3) rather than hardcoding a value that
   worked for a different customer's account.
5. **Treat lot/serial/bin-tracked items as a special case.** Those items may
   need an `inventoryDetail` subrecord (lot/bin/serial assignment) supplied
   alongside the adjustment line, and REST support for that has not been
   reliably confirmed. If the item is tracked this way, verify field-level
   behavior against a real record first, or fall back to the NetSuite UI.
6. **This changes real accounting data, even in sandbox.** It posts a GL
   transaction against whatever account you point it at. Don't pick an
   arbitrary account id — use the one this account's other inventory
   adjustments already use.
7. **Don't use this to paper over a real code/mapping defect.** If availability
   is healthy and the failure persists, stop and route to the actual debugging
   skill instead of adjusting inventory again "just in case."

## Reference material

- [`945-fulfillment-debugging`](../945-fulfillment-debugging/SKILL.md) — the most common upstream trigger: a 945/fulfillment failure that traces back to zero available stock rather than a connector defect.
- [`reference/outbound-source-readiness.md`](../../reference/outbound-source-readiness.md) — the broader source-record readiness checklist for 855/856/810, including the same `aggregateItemLocation` availability check.
- [`reprocess-transaction`](../reprocess-transaction/SKILL.md) / [`build-mock-fulfillments`](../build-mock-fulfillments/SKILL.md) — re-drive the original failing flow after the adjustment lands.
