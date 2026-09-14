---
name: auto-pack-fulfillment
description: Run and debug the Orderful SuiteApp's Auto Pack on an Item Fulfillment (or Sales Order), which splits fulfilled quantity into carton and shipped-item records for the 856 ASN. Covers predicting carton count before packing, the 20-carton Map/Reduce threshold where cartons do not exist when the button returns, unpack semantics, and every Auto Pack error message mapped to its cause. Use when the user says "auto pack this IF", "why did it build N cartons", "Auto Pack failed", "unpack and repack", or is debugging carton counts on an ASN.
---

# Auto Pack an Item Fulfillment

## When to use this skill

Use when the user says any of:

- "auto pack this IF" / "run auto pack for \<fulfillment\>"
- "why did it build 8 cartons" / "the carton count is wrong"
- "Auto Pack failed" / pastes an Auto Pack error
- "unpack and repack this fulfillment"
- "the cartons didn't show up after I clicked Auto Pack"

**Configuring** the pack rule is [`configure-packing-groups`](../configure-packing-groups/SKILL.md). This skill is for running the pack and explaining what came out.

## Prerequisites

- A customer `.env` at `~/orderful-onboarding/<slug>/.env`
- The items on the fulfillment resolve to a pack config — either a packing group or `custitem_orderful_units_p_carton`. Auto Pack hard-errors before writing anything otherwise
- The fulfillment is **not already packed**. Auto Pack refuses to add to an existing pack

## Step 1 — Predict the carton count first

Predict before you run, so an unexpected result is visibly unexpected rather than quietly accepted.

Carton count does **not** depend on the strategy:

```
numberOfCartons = ceil(totalQuantity / unitsPerCarton)
```

Strategy only changes the distribution across that fixed count:

| Strategy | 100 units @ 30/carton |
|---|---|
| `1` Full Cartons | `30 / 30 / 30 / 10` |
| `2` Even Distribution | `25 / 25 / 25 / 25` |

**Even Distribution never produces fewer cartons.** If someone wants fewer, larger cartons, the fix is a bigger `unitsPerCarton`, not a strategy change.

Resolve what config the items will actually use:

```bash
node ../configure-packing-groups/audit-packing-config.mjs ~/orderful-onboarding/<slug> --item <itemId> --customer <customerId>
```

It prints every assignment for the item, which one wins, and whether the result is the group or a silent fallback to the item field.

Then account for the grouping key — items are grouped by:

```
itemInternalId : locationInternalId : packingGroupId
```

The same item shipping from **two locations** yields separate cartons even with identical config. That is the usual answer to "why did I get twice as many cartons as I expected".

## Step 2 — Run Auto Pack

Use the **product path**: the Auto Pack button on the Item Fulfillment, served by the buttonHandler Suitelet.

The SuiteApp's testHook RESTlet does expose `autoPackFulfillment` and `unpack` actions, but **do not reach for them**. Sandbox SuiteApp versions are routinely downlevel from the source repo, so an action that exists in source is often not deployed, and each probe costs a permission prompt and a round of log review. Use the RESTlet only if a script in this repo already invokes that action.

Above **20 cartons**, the work is handed to `orderful_bulkCartonCreation_MR` and the button returns immediately:

> Auto Pack initiated for N. This is being processed in the background and may take a few minutes to complete. Please refresh the page to see the created cartons.

**The cartons do not exist yet when that message appears.** Any script that packs and then reads cartons must poll rather than read once. Below 20 cartons the work is synchronous and complete on return. See [`monitor-mr`](../monitor-mr/SKILL.md) and [`reference/mapreduce-monitoring.md`](../../reference/mapreduce-monitoring.md).

## Step 3 — Verify what was built

```sql
SELECT id,
       custrecord_orderful_carton_sequence AS seq,
       custrecord_orderful_carton_is_pallet AS pallet,
       custrecord_orderful_carton_length AS len,
       custrecord_orderful_carton_weight AS wt,
       custrecord_orderful_carton_pallet AS parent
FROM customrecord_orderful_carton
WHERE custrecord_orderful_carton_fulfillment = <ifId>
ORDER BY seq
```

Two signals tell you **which config path actually won** — useful when the carton count is right but you are not sure the group was applied:

| Observation | Meaning |
|---|---|
| Dimensions/weight populated | The packing group resolved; its defaults were stamped on |
| All dimensions null | Resolved to `null` and fell back to `custitem_orderful_units_p_carton` |
| Rows with `is_pallet = 'T'` | A group with `cartons_per_pallet > 0` was used; the item field cannot produce pallets |

If you expected a group and got null dimensions, the group silently failed to resolve. Run the audit script's `--item` mode to find out which of the four silent-null causes applied.

## Step 4 — Unpack when you need to repack

Auto Pack refuses to run on an already-packed fulfillment, so iterating means unpacking first. Use the Unpack button.

**Sales Order-packed cartons are handed back to the order, not deleted.** Cartons packed pre-fulfillment carry `custrecord_orderful_carton_sales_order`; unpacking the IF clears the fulfillment reference and returns them to the Sales Order for re-transfer. Deleted-carton counts will not match your expectation on those, and that is correct behavior.

## Error messages

Every message below is thrown **before** anything is written, so a failed Auto Pack leaves no partial cartons.

| Message | Cause | Fix |
|---|---|---|
| `The following Item(s) ... do not have the Units Per Carton setting: <items>. Please set it in the Inventory Item -> Orderful EDI tab` | No packing group resolved **and** `custitem_orderful_units_p_carton` is unset | Set the item field, or fix why the group is not resolving — the message names the item field even when a group was the intent |
| `This Item Fulfillment (ID: X) has already been packed` | Cartons already exist for this IF | Unpack first |
| `This Sales Order (ID: X) has already been packed` | Same, on the pre-fulfillment path | Unpack the order |
| `Invalid units per carton configuration for Item(s): ... The packing group "N" has units per carton set to 0` | The resolved group has `units_per_carton <= 0` **and** no `cartons_per_pallet` | Fix the group. Note it names the group id, which distinguishes this from the item-field case |
| `The following Item(s) have invalid shipped quantities (...). All items must have positive shipped quantities` | A line has zero or negative shipped quantity | Fix the fulfillment lines |
| `Invalid packing strategy value: N. Expected 1 (full) or 2 (even)` | The strategy field holds something other than 1 or 2 | Reset it to a valid list value |
| `Item Fulfillment X was not created from a Sales Order` | Standalone IF | Auto Pack requires an originating order |
| `Sales Order X has no packable line items. Auto Pack only packs inventory, assembly and kit items` | Non-inventory lines only | Expected for service/description lines |
| `No cartons to create. Auto-pack generated zero cartons.` | Distribution produced nothing | Usually zero total quantity |

## Two save paths, two validators

Auto Pack and the packing SPA both write via `CartonRepository` but validate **differently** — a carton shape accepted by one is not guaranteed acceptable to the other. This has drifted before in production. The comparison table is in [`reference/packing-groups.md`](../../reference/packing-groups.md#two-save-paths-two-validators).

The practical consequence: if a pack succeeds in the SPA and the same shape fails from Auto Pack, do not assume data corruption — check the validator differences first.

## Behaviour rules

1. **Predict, then run.** State the expected carton count before packing. An unexplained count is a config problem, not a rounding quirk
2. **Never conclude "no cartons were created" from a single read above the 20-carton threshold.** Poll — the Map/Reduce may still be running
3. **Do not use the testHook RESTlet** for Auto Pack or unpack unless a script in this repo already calls that action on this account
4. **Check dimensions to confirm the path.** Correct carton count does not prove the packing group was used; null dimensions mean it silently was not
5. **Unpack before repacking.** Do not delete carton records by hand to work around the already-packed guard — the unpack path also handles the Sales Order hand-back
6. **Check the partner's ASN hierarchy before introducing pallets.** A Tare HL that a flat-ASN partner (BSN05 `0001`) does not expect will be rejected, and Orderful's validator will not catch it

## Reference material

- [`reference/packing-groups.md`](../../reference/packing-groups.md) — resolution precedence, distribution math, validator drift
- [`configure-packing-groups`](../configure-packing-groups/SKILL.md) — setting up the pack rule
- [`build-mock-fulfillments`](../build-mock-fulfillments/SKILL.md) — the IF→856 cycle this fits into
- [`monitor-mr`](../monitor-mr/SKILL.md) — tracking the bulk carton creation Map/Reduce
