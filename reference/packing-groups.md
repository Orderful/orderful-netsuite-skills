# Packing Groups and Auto Pack

How the SuiteApp decides **how many cartons to build and what goes in each one**, and which of the three packing paths a customer is actually on.

This is the shared model behind [`configure-packing-groups`](../skills/configure-packing-groups/SKILL.md) and [`auto-pack-fulfillment`](../skills/auto-pack-fulfillment/SKILL.md). Read it before changing any packing configuration.

## The three packing paths

A customer's 856 is built from `customrecord_orderful_carton` + `customrecord_orderful_shipped_item` rows. There are three ways those rows come to exist, in ascending order of effort:

| Path | Config required | When to use |
|---|---|---|
| **Item field** (`custitem_orderful_units_p_carton`) | One numeric field per item. **Zero custom records.** | Uniform pack size per item, same for every trading partner. Start here. |
| **Packing groups** | `customrecord_orderful_packing_group` + one `customrecord_orderful_item_pack_group` assignment per item | You need pallets, default dimensions/weight, even distribution, or per-customer variation |
| **Analytics dataset** (`custentity_orderful_pkg_data_src`) | A SuiteAnalytics Dataset | Carton data already lives in a 3PL/WMS record — see [`alternative-packing-source`](../skills/alternative-packing-source/SKILL.md) |

Hand-building carton records via REST (as [`build-mock-fulfillments`](../skills/build-mock-fulfillments/SKILL.md) does) is a **fourth, test-only** path. It is the right tool for mocking a specific carton shape during certification, and the wrong tool for standing up a customer.

## Resolution precedence

`PackingGroupService.getPackingConfigsForItems(itemIds, customerId)` resolves each item independently:

```
1. Customer-specific assignment   custrecord_ofipg_customers contains customerId
                ↓ (none found)
2. General assignment             custrecord_ofipg_customers is empty
                ↓ (none found, or the group is unusable — see below)
3. null  →  caller falls back to custitem_orderful_units_p_carton on the item
                ↓ (also unset)
4. Hard error before anything is written
```

**Four ways a configured group silently resolves to `null`** and drops to the item field with no warning in the execution log:

| Cause | Detail |
|---|---|
| `custrecord_orderful_units_per_carton` is 0, null, or negative | Explicitly checked; returns `null` |
| The assignment points at a deleted packing group | Group not found in the map; returns `null` |
| The assignment is inactive | Filtered in SQL (`custrecord_ofipg_is_active = 'T'`), invisible to the engine |
| Every assignment for the item is customer-specific and none matches | The general-assignment fallback finds nothing |

When two **general** assignments exist for the same item, the engine takes whichever SuiteQL returns first. There is no tiebreak, no "most recent" rule, and no error. Treat duplicate general assignments as a configuration bug.

### `customerId` is the transaction's entity, with no parent walk

`customerId` comes from `getValue({fieldId: 'entity'})` on the Item Fulfillment (or Sales Order for a pre-fulfillment pack), and is matched with `assignment.customerIds.includes(customerId)` — an exact id match.

**If the order sits on a subcustomer, a customer-specific assignment must name that subcustomer.** An assignment on the parent will not match.

This is the **opposite** of Orderful Enabled Transaction records, which are configured at the parent level and inherited by subcustomers. Two adjacent features, two opposite conventions — check which one you are configuring.

## Record schema

### `customrecord_orderful_packing_group`

| Field | Type | Notes |
|---|---|---|
| `custrecord_orderful_units_per_carton` | INTEGER | **Required.** Must be > 0 or the whole group resolves to `null` |
| `custrecord_orderful_cartons_per_pallet` | INTEGER | 0/null = no pallet tier. > 0 builds pallet cartons (`is_pallet = T`) |
| `custrecord_orderful_packing_strategy` | SELECT → `customlist_ofpg_packing_strategy` | `1` = Full Cartons, `2` = Even Distribution. Any other value **throws** |
| `custrecord_orderful_default_length` / `_width` / `_height` / `_weight` | FLOAT | Copied onto each carton the group creates. The item-field path leaves these null |

### `customrecord_orderful_item_pack_group`

| Field | Type | Notes |
|---|---|---|
| `custrecord_ofipg_item` | SELECT → item | The item being assigned |
| `custrecord_ofipg_packing_group` | SELECT → packing group | The group to apply |
| `custrecord_ofipg_customers` | MULTISELECT → customer | **Empty = general.** Populated = customer-specific. See the read warning below |
| `custrecord_ofipg_is_active` | CHECKBOX | `F` makes the assignment invisible to the engine while leaving it visible in the UI |

### Not the auto-pack driver

`custitem_orderful_case_pack_size` and `custcol_orderful_case_pack_size` are similarly named and are **not** read by the packing engine. They are line attributes carried into the line-item models for EDI output. The only item field that drives packing is `custitem_orderful_units_p_carton` (label: "Units per Carton", on the item's Orderful EDI tab).

## Reading `custrecord_ofipg_customers` — REST SuiteQL lies

A `SELECT custrecord_ofipg_customers` through the **REST SuiteQL endpoint** returns the literal string `RELATIONSHIP FIELD` for every row, whether the multiselect has members or not.

```
SELECT id, custrecord_ofipg_customers, LENGTH(custrecord_ofipg_customers) AS len
  → { "id": "2172", "as_char": "RELATIONSHIP FIELD", "len": "18" }
```

Consequences when auditing:

- **`COUNT(custrecord_ofipg_customers)` is meaningless.** It counts the sentinel, so it returns the full row count and makes every assignment look customer-specific.
- The column is often omitted entirely from the JSON row while still being counted as non-null.

**The only reliable read is the REST record GET:**

```
GET /record/v1/customrecord_orderful_item_pack_group/{id}?expandSubResources=true
→ body.custrecord_ofipg_customers.items[]   // array of {id}; count: 0 means general
```

This is a REST-endpoint artifact, **not** a SuiteApp bug — the connector's own `N/query` reads inside NetSuite resolve correctly, which is why general assignments demonstrably work in production data. This mirrors the wider multiselect problem documented for item lookups: SuiteQL is not a trustworthy read for any multiselect field.

## Carton distribution math

Carton **count** is always the same regardless of strategy:

```
numberOfCartons = ceil(totalQuantity / unitsPerCarton)
```

Strategy only changes how quantity is spread across that fixed count:

| Strategy | 100 units @ 30/carton | Behavior |
|---|---|---|
| `1` Full Cartons | `30 / 30 / 30 / 10` | Fill each carton; the last one takes the remainder |
| `2` Even Distribution | `25 / 25 / 25 / 25` | Spread evenly across the same count; the first `remainder` cartons get one extra |

Both produce `ceil(100/30) = 4` cartons. With 101 units the same split gives `30/30/30/11` (Full) and `26/25/25/25` (Even).

**Even Distribution never reduces the carton count.** It only avoids a short final carton. If someone expects "even" to produce fewer, larger cartons, that expectation is wrong — raise `unitsPerCarton` instead.

## Grouping key

Items are grouped for packing by:

```
itemInternalId : locationInternalId : packingGroupId
```

The same item shipping from **two locations** produces separate cartons even with identical packing config. `packingGroupId` is the literal string `legacy` when the item resolved to the item-field path, so an item on the group path and an item on the item-field path never share a carton.

## Synchronous vs Map/Reduce

Above `MAP_REDUCE_THRESHOLD = 20` cartons, carton creation is handed to `orderful_bulkCartonCreation_MR` and the UI returns immediately with "Auto Pack initiated … may take a few minutes to complete. Please refresh the page."

**The cartons do not exist when the button returns.** Any script that packs and then immediately reads cartons must poll. Below 20 cartons the work is synchronous and complete on return. The threshold exists because each custom record create costs ~4 governance units against a 1,000-unit limit (~250 cartons), and the Map/Reduce startup overhead (10–30s) is not worth paying below 20.

See [`mapreduce-monitoring.md`](mapreduce-monitoring.md) for tracking the MR to completion.

## Two save paths, two validators

Auto Pack and the packing SPA both write through `CartonRepository`, but they validate **differently**. This has drifted before (a fix was needed when the Auto Pack validator hard-required `itemFulfillmentId`, blocking Sales Order packing).

| Rule | Auto Pack (`validateCartonsBeforeSave`) | SPA save (`validatePackingResults`) |
|---|---|---|
| Carton anchored to an IF or SO | Enforced | Not checked |
| Carton with zero items | Rejected | Allowed |
| Zero cartons overall | Rejected | Allowed |
| `isPallet` consistency | Not checked | Enforced |
| Negative dimensions | Rejected | Rejected |
| Error reporting | Throws on the first problem | Accumulates and reports all |

If a carton shape works from the SPA but fails from Auto Pack (or vice versa), this table is the reason. Do not assume a shape validated by one path is acceptable to the other.

## Sales Order packing (pre-fulfillment)

Cartons can be packed on the Sales Order before an Item Fulfillment exists. Such cartons carry `custrecord_orderful_carton_sales_order` instead of `custrecord_orderful_carton_fulfillment`; the fulfillment reference is added later by the SO→IF transfer. Unpacking an IF whose cartons came from a Sales Order **hands them back to the order** rather than deleting them.

The 856 still sources from the Item Fulfillment either way.

## Adoption reality (as of September 2026)

Both record types are **deployed in every account sampled** (25 accounts) — the tables always exist, so their presence proves nothing. Actual use is rare, so never assume a customer is on this path without running the audit.

Anonymized shape of what the sample found:

| Account | Groups | Assignments | Items with `units_p_carton` | Reading |
|---|---|---|---|---|
| A | 2,394 | 1,414 | 1,414 | Real adoption; 1:1 item→group, all **general** assignments, full dims + cartons-per-pallet |
| B | 18,075 | **4** | 22,700 | See the anti-pattern below |
| C | 215 | 21 | 24 | Partial |
| D, E | 1 | 1 | 0 | Single-record pilots |
| The other 20 | 0 | 0 | 0–254 | Item field or dataset only |

**No sampled account uses customer-specific assignments.** Every populated assignment had an empty `custrecord_ofipg_customers`. That path is therefore *unproven in the field* — if you are the first to configure it, verify the resulting carton count by hand rather than trusting it.

### The one-group-per-item anti-pattern

Account B carries 18,075 packing groups named `Packing Group - <SKU>`, each with `units_per_carton = 1` and `cartons_per_pallet = 0`, against only **4** assignments. 18,071 of those groups are orphaned — created by a bulk import, never linked to an item, and completely inert. The account's packing actually runs off the 22,700 items carrying `custitem_orderful_units_p_carton`.

The lesson: **one group per item is a smell.** A group earns its existence by carrying pallet config, dimensions, a non-Full strategy, or per-customer variation. If every group would just say "N per carton," set the item field and create nothing.
