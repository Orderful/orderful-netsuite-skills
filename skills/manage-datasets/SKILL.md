---
name: manage-datasets
description: Author, inspect, test, and save the SuiteAnalytics Datasets the Orderful SuiteApp consumes — Packaging Data Sources for 856 ASNs and carton/pallet label datasets. NetSuite has no REST API for datasets, so this skill drives the SuiteApp's dataset actions on the agent RESTlets through a describe → edit spec → dry-run → save loop, with validation against the SuiteApp's own packaging and label column contracts. Use when the user says "build a label dataset", "the packaging dataset is wrong", "labels aren't generating for <retailer>", "describe the carton dataset", "add <field> to the label dataset", "test the dataset for fulfillment X", or "/manage-datasets".
---

# Manage SuiteAnalytics Datasets (856 packaging + label data sources)

## When to use this skill

- "Build a carton label dataset for `<retailer>`"
- "Labels aren't generating for `<retailer>` — figure out why"
- "What does the packaging dataset for `<customer>` return for fulfillment `<id>`?"
- "Add the buyer's item number / item description to the label dataset"
- "Describe / dump the dataset the label config points at"

Datasets feed two SuiteApp features, matched by **column label, case-insensitively — never by field id**:

| Consumer | Code path | Contract |
| --- | --- | --- |
| 856 Packaging Data Source | `carton.repository.ts` → `validatePackagingAnalyticsDataSource` | At least one of `Fulfillment` / `SalesOrder`, plus mandatory `Carton`, `Item`, `Quantity`. A formula-backed source column must return INTEGER. |
| Carton/pallet labels | `label/datasetMapping.ts` → `getDatasetMapping` | At least one of `Fulfillment` / `SalesOrder`; every other label must exactly match a `LabelFieldMap` dotted path (`shipTo.name`, `shipment.sscc-18`, …). Non-matching labels are dropped **silently** — no error, no log. |

The tool does not restate either contract. The SuiteApp validates with the same
`columnConfigs` (`Models/carton.ts`) and `LabelFieldMap` its runtime matches
against, so what the tool reports is what the runtime accepts, by construction.

### Source columns: `Fulfillment` and `SalesOrder`

Historically every dataset filtered by Item Fulfillment. Since NS-689 (Sales
Order packing) a dataset can filter by **Sales Order** instead, so labels can be
generated pre-fulfillment — before any Item Fulfillment exists. Consequently:

- Neither source column is individually mandatory; **at least one** is required.
- Every pre-NS-689 dataset stays valid unchanged.
- A dataset carrying **both** serves both contexts. Prefer that for a customer
  who packs on Sales Orders but still generates the 856 off the fulfillment.
- At runtime the consumer filters on `SalesOrder` when the caller asked for SO
  cartons, otherwise on `Fulfillment` — one column per run, never both.

> The `SalesOrder` column arrives with netsuite-connector #907 (NS-689), not yet
> merged. Against an older SuiteApp, only `Fulfillment` is recognised and a
> `SalesOrder` column reports as unrecognised. `describe` tells you which
> contract the target account actually enforces — trust it over this table.

## Prerequisites

1. **Customer slug** — `~/orderful-onboarding/<slug>/.env` must exist (run `netsuite-setup` first).
2. **SuiteApp version** — the dataset actions ship from **NS-1142** (netsuite-connector #880, merged 2026-09-02). On an older SuiteApp the tool says so and exits; fall back to the `alternative-packing-source` skill's Analytics-UI path.
3. **Environment** — `ENVIRONMENT=sandbox` (default) or `production` in the customer `.env`. Author and test in sandbox.
4. **What the dataset must produce** — target consumer (packaging vs label), required fields, and a real fulfillment or sales order with cartons to test against.

No SDF deploy and no per-customer script installation: these actions are part of
the SuiteApp. `list` / `describe` / `run` / `dry-run` go to the agent-**read**
RESTlet and are pure reads; only `save` touches agent-**write**.

## The recipe

### Step 1 — Survey what exists

```sh
node skills/manage-datasets/dataset-tool.mjs ~/orderful-onboarding/<slug> list
```

Then `describe` whatever a label data source or packaging config points at.
`describe` returns the round-trippable spec **and** the contract validation, so
it is also the fastest way to diagnose "labels stopped generating". Find the wiring:

```sql
-- label data sources and which customers use them
SELECT l.id, l.name, l.custrecord_orderful_carton_data_src_id, l.custrecord_orderful_carton_template_id
FROM customrecord_orderful_label_data_src l;
SELECT c.id, c.companyname, c.custentity_orderful_label_data_src FROM customer c
WHERE c.custentity_orderful_label_data_src IS NOT NULL;
```

### Step 2 — Diagnose a broken dataset before rebuilding it

Read `describe` output in this order:

1. **`contracts.label.problems` / `contracts.packaging.problems`** — a missing or
   non-INTEGER source column means the consumer returns zero rows.
2. **`spec.condition`** — a stored condition naming `Fulfillment` or `SalesOrder`
   is the headline failure mode: the consumer ANDs its own source filter on top,
   the two contradict for every real record, and the dataset silently returns
   nothing. This has been found live at a customer (a leftover debug filter).
3. **`contracts.label.ignoredColumns`** — labels the label path drops silently.
   Deliberate formula guard columns land here harmlessly (see the reference doc's
   correlation pattern); a *typo'd* label field lands here too and shows up as a
   blank field on the printed label. Read the list before deleting anything from it.

### Step 3 — Author the spec and iterate with dry-run

Write a JSON spec (see `reference/dataset-formula-syntax.md` for the join/formula
grammar and the platform limits), then:

```sh
node skills/manage-datasets/dataset-tool.mjs ~/orderful-onboarding/<slug> \
  dry-run specs/my-dataset.json --limit 10
```

`dry-run` builds the dataset in memory, runs it, returns rows plus contract
validation, and persists nothing.

**Testing against a real fulfillment / sales order — use a probe spec.**
`dryRunDataset` filters only on `spec.condition`; it takes no separate ANDed
condition (tracked in NS-1189). Do **not** solve that by adding a source filter
to the spec you intend to save — that is exactly the bug in Step 2.2. Instead:

```sh
cp specs/my-dataset.json specs/my-dataset.probe.json
# add the source condition to the .probe.json ONLY
node ... dry-run specs/my-dataset.probe.json --limit 10   # iterate here
node ... save specs/my-dataset.json --yes                 # save the unfiltered one
```

Two files, so there is no "remember to strip it" step to forget. The tool
enforces this from both ends: `dry-run` refuses `--fulfillment`/`--sales-order`
and points at this procedure, and `save` refuses a spec whose condition names a
source column.

### Step 4 — Verify the grain and the data

- Row count for one fulfillment must equal cartons × items in those cartons.
  Fan-out (hundreds/thousands of rows) means a missing correlation guard — see
  the reference doc's item-match pattern.
- Cross-check a sample of rows against SuiteQL ground truth before wiring
  anything to a customer.

### Step 5 — Save and wire

```sh
node skills/manage-datasets/dataset-tool.mjs ~/orderful-onboarding/<slug> \
  save specs/my-dataset.json --yes
```

- **Omit `id` from the spec** so NetSuite auto-names it `custdataset<N>` — the N
  is the internal id, which makes the dataset linkable at
  `/app/common/report/dataset.nl?dataset=<N>`. With a custom scriptid there is no
  API path to the internal id.
- Check `reloaded` / `reloadError` in the response: `saveDataset` reloads by
  scriptid to confirm the round-trip. A dataset that saved but won't load back is
  useless to the runtime.
- Wire it: create a NEW `customrecord_orderful_label_data_src` record (carton
  dataset id + label template id) and point the customer's
  `custentity_orderful_label_data_src` at it. Don't edit a shared existing
  record — other customers may point at it.
- Simulate the runtime narrowing, then generate real labels:

```sh
node ... run custdataset<N> --fulfillment <ifId> --limit 10
node ... run custdataset<N> --sales-order <soId> --limit 10   # NS-689 datasets
```

### Fidelity of `run` — read this before trusting a zero-row result

`run` ANDs the source filter onto whatever condition the dataset carries. That
matches the **label** path exactly. The **856 packaging** path differs: it ANDs
only when the stored condition has children, and **replaces** a single-leaf
stored condition outright (`carton.repository.ts`; tracked as NS-1188).

So for a packaging dataset carrying a **single-leaf** condition, `run` shows zero
rows where production returns rows — `run` is stricter than the runtime, never
looser. A zero-row `run` on such a dataset is not proof the runtime is broken;
`describe` the condition and reason about it. For datasets with no stored
condition, or a multi-leaf one, `run` and both consumers agree.

## Behaviour rules

1. **Never bake a source filter into a saved dataset.** Source filters live in a
   `.probe.json` variant or a `run` condition, never in what gets saved.
2. **Never save without a prior dry-run in the same session.** The driver
   enforces `--yes` on save; don't script around it.
3. **Don't edit a label data source record another customer points at.** Create a
   new record and repoint one customer. Reverting is then a one-field PATCH.
4. **Don't try to edit a dataset in place via script.** The platform rejects it
   ("Unable to save the dataset."). Save under a new scriptid and repoint the
   consumer, or edit in the Analytics UI.
5. **Clean up scratch datasets in the UI.** `N/dataset` has no delete. Name
   throwaways with a `ZZ` prefix and no custom scriptid so they're findable and
   linkable.
6. **Don't guess join names.** If a join isn't in
   `reference/dataset-formula-syntax.md`, build the column once in the Analytics
   UI, save, and `describe` the dataset — formula text round-trips, so the
   internal join id comes straight back out. Probing burns a lot of time for
   little return.
7. **Sandbox first, always.** Author, save, and verify labels in sandbox before
   repeating in production.
8. **Row-grain verification is mandatory** before wiring a dataset to a
   customer — silent fan-out or zero-row bugs produce wrong or missing labels
   with no error anywhere.

## Reference material

- [`reference/dataset-formula-syntax.md`](../../reference/dataset-formula-syntax.md) — join grammar, formula dialect limits, correlation pattern, all measured platform gotchas
- [`skills/migrate-dataset/SKILL.md`](../migrate-dataset/SKILL.md) — promoting a finished dataset between accounts via SDF
- [`skills/alternative-packing-source/SKILL.md`](../alternative-packing-source/SKILL.md) — authoring packaging datasets in the NS UI (the fallback when the SuiteApp predates NS-1142)
