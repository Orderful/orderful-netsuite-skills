---
name: manage-datasets
description: Author, inspect, test, and save the SuiteAnalytics Datasets the Orderful SuiteApp consumes — Packaging Data Sources for 856 ASNs and carton/pallet label datasets. NetSuite has no REST API for datasets, so this skill deploys a Dataset Lab RESTlet (per-customer SDF ACP) that wraps N/dataset, then drives a describe → edit spec → dry-run → save loop with validation against the SuiteApp's packaging and label column contracts. Use when the user says "build a label dataset", "the packaging dataset is wrong", "labels aren't generating for <retailer>", "describe the carton dataset", "add <field> to the label dataset", "test the dataset for fulfillment X", or "/manage-datasets".
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
| 856 Packaging Data Source | `carton.repository.ts` → `validatePackagingAnalyticsDataSource` | Mandatory labels `Fulfillment`, `Carton`, `Item`, `Quantity`; formula-backed `Fulfillment` must return INTEGER |
| Carton/pallet labels | `label/datasetMapping.ts` → `getDatasetMapping` | `Fulfillment` required; every other label must exactly match a `LabelFieldMap` dotted path (`shipTo.name`, `shipment.sscc-18`, …). Non-matching labels are dropped **silently** — no error, no log. |

Both consumers **AND their own `Fulfillment = <id>` filter onto whatever condition the dataset already carries** at runtime. A dataset must therefore carry NO fulfillment condition of its own — a baked-in one becomes `Fulfillment = <baked> AND Fulfillment = <actual>`, which is false for every real fulfillment and surfaces as labels silently not generating. This exact failure was found live at a customer.

## Inputs the skill needs

1. **Customer slug** — `~/orderful-onboarding/<slug>/.env` must exist (run `netsuite-setup` first).
2. **Environment** — sandbox (default) or production. Author and test in sandbox.
3. **What the dataset must produce** — target consumer (packaging vs label), required fields, and a real fulfillment id with cartons to test against.

## The recipe

### Step 1 — Deploy the Dataset Lab RESTlet (one-time per account)

Until the dataset actions ship in the SuiteApp's agent RESTlets (netsuite-connector PR #880 / NS-1142), deploy the lab RESTlet from this skill folder via a per-customer SDF ACP project:

- Copy `orderful_datasetLab_RL.js` into `~/orderful-onboarding/<slug>/sdf/<slug>-acp/src/FileCabinet/SuiteScripts/orderful-dataset-lab/`
- Script object: RESTlet `customscript_orderful_dataset_lab_rl`, deployment `customdeploy_orderful_dataset_lab_rl`, status RELEASED, log level DEBUG. Keep `deploy.xml` scoped to exactly this script and object — `project:deploy` is declarative and a wide deploy.xml deletes objects.
- Auth: `suitecloud account:setup` (browser flow — the user must be at the keyboard; see the migrate-dataset skill's `sdf_setup.exp` wrapper). Verify with `suitecloud account:manageauth --list` — the wrapper exits 0 even when auth fails.
- `suitecloud project:validate --server`, then `suitecloud project:deploy`.

### Step 2 — Survey what exists

```sh
node skills/manage-datasets/dataset-tool.mjs --customer <slug> list
```

Then `describe` anything a label data source or packaging config points at. Find the wiring:

```sql
-- label data sources and which customers use them
SELECT l.id, l.name, l.custrecord_orderful_carton_data_src_id, l.custrecord_orderful_carton_template_id
FROM customrecord_orderful_label_data_src l;
SELECT c.id, c.companyname, c.custentity_orderful_label_data_src FROM customer c
WHERE c.custentity_orderful_label_data_src IS NOT NULL;
```

### Step 3 — Author the spec and iterate with dry-run

Write a JSON spec (see `reference/dataset-formula-syntax.md` for the join/formula grammar and the constraints). Iterate:

```sh
node skills/manage-datasets/dataset-tool.mjs --customer <slug> dry-run specs/my-dataset.json --limit 10
```

`dry-run` builds the dataset in memory, runs it, returns rows plus **contract validation** (`packaging` + `label`), and persists nothing. Check `ignoredColumns` — anything there will be silently dropped by the label path.

For testing, add a temporary fulfillment condition to the spec; **remove it before save** (Step 5).

### Step 4 — Verify the grain and the data

- Row count for one fulfillment must equal cartons × items in those cartons. Fan-out (hundreds/thousands of rows) means a missing correlation guard — see the reference doc's item-match pattern.
- Cross-check a sample of rows against SuiteQL ground truth before wiring anything to a customer.

### Step 5 — Save and wire

```sh
node skills/manage-datasets/dataset-tool.mjs --customer <slug> save specs/my-dataset.json --yes
```

- **Omit `id` from the spec** so NetSuite auto-names it `custdataset<N>` — the N is the internal id, which makes the dataset linkable at `/app/common/report/dataset.nl?dataset=<N>`. With a custom scriptid there is no API path to the internal id.
- Wire it: create a NEW `customrecord_orderful_label_data_src` record (carton dataset id + label template id) and point the customer's `custentity_orderful_label_data_src` at it. Don't edit a shared existing record — other customers may point at it.
- Test by generating labels for a real fulfillment, and simulate first:

```sh
node skills/manage-datasets/dataset-tool.mjs --customer <slug> run custdataset<N> --fulfillment <ifId> --limit 10
```

`--fulfillment` reproduces the exact runtime narrowing the SuiteApp applies.

## Behaviour rules

1. **Never bake a fulfillment filter into a saved dataset.** Test-only filters go in a `--test` spec variant or a `run` condition, never in what gets saved.
2. **Never save without a prior dry-run in the same session.** The driver enforces `--yes` on save; don't script around it.
3. **Don't edit a label data source record another customer points at.** Create a new record and repoint one customer. Reverting is then a one-field PATCH.
4. **Don't try to edit a dataset in place via script.** The platform rejects it ("Unable to save the dataset."). Save under a new scriptid and repoint the consumer, or edit in the Analytics UI.
5. **Clean up scratch datasets in the UI.** `N/dataset` has no delete. Name throwaways with a `ZZ` prefix and no custom scriptid so they're findable and linkable.
6. **Don't guess join names.** If a join isn't in `reference/dataset-formula-syntax.md`, build the column once in the Analytics UI, save, and `describe` the dataset — formula text round-trips, so the internal join id comes straight back out.
7. **Sandbox first, always.** Author, save, and verify labels in sandbox before repeating in production.
8. **Row-grain verification is mandatory** before wiring a dataset to a customer — silent fan-out or zero-row bugs produce wrong or missing labels with no error anywhere.

## Reference material

- [`reference/dataset-formula-syntax.md`](../../reference/dataset-formula-syntax.md) — join grammar, formula dialect limits, correlation pattern, all measured gotchas
- [`skills/migrate-dataset/SKILL.md`](../migrate-dataset/SKILL.md) — promoting a finished dataset between accounts via SDF
- [`skills/alternative-packing-source/SKILL.md`](../alternative-packing-source/SKILL.md) — authoring packaging datasets in the NS UI (the manual path this skill supersedes for most cases)
