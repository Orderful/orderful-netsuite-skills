---
name: configure-packing-groups
description: Configure how the Orderful SuiteApp splits fulfilled quantity into cartons for the 856 ASN — starting with the zero-record "Units per Carton" item field and escalating to packing group records only when pallets, default dimensions, even distribution, or per-customer variation are actually needed. Audits what a customer already has before changing anything. Use when the user says "set up packing groups", "configure units per carton", "the ASN is making one carton per unit", "how many cartons will this build", "set up auto pack for <customer>", or is standing up 856 packing for a new customer.
---

# Configure Packing Groups

## When to use this skill

Use when the user says any of:

- "set up packing groups for \<customer\>"
- "configure units per carton" / "items per carton" / "case pack"
- "the ASN is building one carton per unit" (or per line)
- "set up auto pack for \<customer\>"
- "how do I get pallets on the 856"
- "\<customer\> needs different pack sizes per trading partner"

**Do not use this skill** when the customer's carton data comes from a 3PL/WMS custom record — that is [`alternative-packing-source`](../alternative-packing-source/SKILL.md). And do not use it to mock a specific carton shape for a certification test; that is [`build-mock-fulfillments`](../build-mock-fulfillments/SKILL.md).

Read [`reference/packing-groups.md`](../../reference/packing-groups.md) before making changes. This skill is the procedure; that document is the model.

## Prerequisites

- A customer `.env` at `~/orderful-onboarding/<slug>/.env` (see [`netsuite-setup`](../netsuite-setup/SKILL.md))
- The SuiteApp installed. Both packing records ship with it and exist in every account sampled — their presence proves nothing about whether the feature is in use

## Inputs

Ask for whatever is not obvious:

1. **Customer slug** and whether we are working in sandbox or production
2. **The pack rule in plain words** — "24 per case", "1 per carton, 40 cartons per pallet", "12 per case for Costco but 6 for everyone else"
3. **Whether pallets are required** by the partner's ASN guideline (BSN05 hierarchy). A pallet tier the partner does not expect will be rejected

## Step 1 — Audit before you change anything

Never create records before knowing what is there. This skill ships a script that runs the whole audit and flags every silent-null trap:

```bash
node <path-to-this-skill>/audit-packing-config.mjs ~/orderful-onboarding/<slug>
```

It reports the four counts below, names the path the account is actually on, and lists orphaned groups, dangling assignments, duplicate general assignments, inactive assignments, and groups carrying no more information than the item field.

```sql
SELECT COUNT(*) AS groups FROM customrecord_orderful_packing_group;
SELECT COUNT(*) AS assignments FROM customrecord_orderful_item_pack_group WHERE custrecord_ofipg_is_active = 'T';
SELECT COUNT(*) AS items_with_field FROM item WHERE custitem_orderful_units_p_carton > 0;
SELECT COUNT(*) AS cartons FROM customrecord_orderful_carton;
```

Interpreting the result:

| Shape | Meaning | Action |
|---|---|---|
| All zeros, cartons > 0 | Cartons come from a dataset or were hand-built | Check `custentity_orderful_pkg_data_src` before assuming this skill applies |
| Groups ≫ assignments | Orphaned groups from a bulk import — inert records | Do not add more. Find out what is actually driving packing first |
| Groups ≈ assignments ≈ items_with_field | Both paths configured in parallel | Confirm they agree, or one will silently mask the other |
| Only items_with_field > 0 | Already on the simple path | Only escalate if the rule genuinely needs a group |

## Step 2 — Take the simple path if it fits

**Default to the item field.** If the rule is "N units per carton per item, same for every trading partner", set one field and create **zero** custom records:

```
Item → Orderful EDI tab → "Units per Carton"   (custitem_orderful_units_p_carton)
```

Set it in the UI, or PATCH `inventoryitem/<itemId>` with `{"custitem_orderful_units_p_carton": 24}`.

This is not a lesser option — it is the path most live accounts actually run on, and it is what packing groups fall back to anyway. An account with 18,075 one-per-item packing groups and only 4 assignments is a real thing that happened; see the anti-pattern in the reference doc.

**Escalate to a packing group only when you need at least one of:**

- Cartons per pallet (a pallet HL tier on the 856)
- Default length/width/height/weight stamped on each carton
- Even Distribution instead of Full Cartons
- A different pack size for the same item **per customer**

If none of those apply, stop here.

### Do not confuse the fields

`custitem_orderful_case_pack_size` and `custcol_orderful_case_pack_size` look like the right fields and are not read by the packing engine at all. Only `custitem_orderful_units_p_carton` drives packing.

## Step 3 — Create the packing group

One group per **distinct packing behavior**, not one per item. Ten items that all ship 24-to-a-carton on 40-carton pallets share one group.

POST to `customrecord_orderful_packing_group`:

```json
{
  "name": "24ct Case / 40 per Pallet",
  "custrecord_orderful_units_per_carton": 24,
  "custrecord_orderful_cartons_per_pallet": 40,
  "custrecord_orderful_packing_strategy": "1",
  "custrecord_orderful_default_weight": 12.5,
  "custrecord_orderful_default_length": 18,
  "custrecord_orderful_default_width": 12,
  "custrecord_orderful_default_height": 10
}
```

Rules that will bite:

- `custrecord_orderful_units_per_carton` **must be > 0**. Zero or null makes the entire group resolve to `null` and silently fall back to the item field — no error, no log line
- `custrecord_orderful_packing_strategy` accepts **only** `1` (Full Cartons) or `2` (Even Distribution). Any other value throws `Invalid packing strategy value: N`
- Leave `cartons_per_pallet` at 0 unless the partner's ASN expects a pallet tier
- Name the group after its **behavior** (`24ct Case / 40 per Pallet`), never after a SKU. A SKU-named group is the tell that someone is creating one group per item

## Step 4 — Assign items to the group

POST to `customrecord_orderful_item_pack_group`, one per item:

```json
{
  "name": "24ct Case - ABC-123",
  "custrecord_ofipg_item": {"id": "9087"},
  "custrecord_ofipg_packing_group": {"id": "1088"},
  "custrecord_ofipg_is_active": true
}
```

Leaving `custrecord_ofipg_customers` **empty makes it a general assignment** — it applies to every trading partner. That is what you want in almost all cases, and it is the only variant proven in live accounts.

**One general assignment per item.** Two general assignments for the same item means the engine takes whichever SuiteQL returns first, with no tiebreak and no error.

### Customer-specific assignments

Only when the same item genuinely packs differently per partner. Add the customers to the multiselect:

PATCH `customrecord_orderful_item_pack_group/<id>`:

```json
{"custrecord_ofipg_customers": {"items": [{"id": "12345"}]}}
```

Three things to get right:

1. **Use the exact entity on the order.** `customerId` is read straight off the transaction's `entity` field with no parent walk. If orders land on a **subcustomer**, name the subcustomer — a parent-level assignment will not match. This is the opposite of Orderful Enabled Transaction records, which are parent-level and inherited
2. **Keep a general assignment as the fallback.** If every assignment for an item is customer-specific and none matches the order's customer, resolution returns `null` and drops to the item field — the customer-specific config is bypassed entirely
3. **This path is unproven in the field.** No sampled account uses it. Verify the resulting carton count by hand on a real fulfillment before trusting it in production

## Step 5 — Verify the resolution, not the records

Creating the records is not evidence the engine will use them. Confirm with a real pack.

Predict first — carton count is always `ceil(totalQuantity / unitsPerCarton)`, and strategy changes only the distribution:

| Strategy | 100 units @ 30 | |
|---|---|---|
| Full Cartons | `30 / 30 / 30 / 10` | last carton takes the remainder |
| Even Distribution | `25 / 25 / 25 / 25` | same 4 cartons, evenly filled |

Then run Auto Pack on a real Item Fulfillment ([`auto-pack-fulfillment`](../auto-pack-fulfillment/SKILL.md)) and check which path won:

```sql
SELECT id,
       custrecord_orderful_carton_sequence AS seq,
       custrecord_orderful_carton_is_pallet AS pallet,
       custrecord_orderful_carton_length AS len,
       custrecord_orderful_carton_weight AS wt
FROM customrecord_orderful_carton
WHERE custrecord_orderful_carton_fulfillment = <ifId>
ORDER BY seq
```

**Null dimensions on every carton means the group did not resolve** and the item field was used instead — the group path stamps its defaults onto each carton. Pallet rows (`is_pallet = 'T'`) only ever come from a group with `cartons_per_pallet > 0`. These two signals are how you tell the paths apart after the fact.

## Behaviour rules

1. **Audit before creating.** Step 1 is not optional. Most "packing groups aren't working" reports are an orphaned-group or duplicate-assignment problem, not a missing record
2. **Prefer the item field.** Escalate only for pallets, dimensions, even distribution, or per-customer variation. One group per item is a smell
3. **Never trust SuiteQL for `custrecord_ofipg_customers`.** The REST SuiteQL endpoint returns the literal string `RELATIONSHIP FIELD` for every row, so `COUNT()` on it is meaningless and makes every assignment look customer-specific. Read it with `GET /record/v1/customrecord_orderful_item_pack_group/{id}?expandSubResources=true` and check `.items[]`
4. **Never deactivate instead of deleting** when removing an assignment you no longer want mid-test — an inactive assignment is invisible to the engine but still visible in the UI, which reads as "configured but broken"
5. **Confirm pallets against the partner guideline** before setting `cartons_per_pallet`. A pallet tier inserts a Tare HL that a flat-ASN partner (BSN05 `0001`) will reject, and Orderful's validator does not catch it
6. **Do not change production packing config without the user's explicit go-ahead** on the specific records. Show the audit, propose the change, then apply

## Reference material

- [`reference/packing-groups.md`](../../reference/packing-groups.md) — resolution precedence, schema, distribution math, adoption data
- [`auto-pack-fulfillment`](../auto-pack-fulfillment/SKILL.md) — running and debugging the pack
- [`alternative-packing-source`](../alternative-packing-source/SKILL.md) — dataset-driven packing
- [`build-mock-fulfillments`](../build-mock-fulfillments/SKILL.md) — hand-built cartons for certification tests
