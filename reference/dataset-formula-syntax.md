# SuiteAnalytics Dataset spec grammar and platform limits

Everything here was measured against a live account (2026-07) via the SuiteApp's dataset
actions on the agent RESTlets (`skills/manage-datasets/`, NS-1142). NetSuite documents almost
none of it. The community typings (`@hitc/netsuite-types`) are wrong in several places noted
below.

SuiteApp behaviour described here was read from **netsuite-connector `dev` @ `b81d2192`**,
plus **#907 (NS-689)** where noted for the `SalesOrder` source column — that PR is not yet
merged. Consumer-behaviour claims below cite the file they were verified against; re-check
them against the connector when revisiting, and update the commit above.

## Join grammar (dataset columns)

A column reaches other records through a join chain. In JSON specs (base-first array):

```jsonc
{ "label": "shipTo.city", "fieldId": "city",
  "join": [{ "fieldId": "custrecord_orderful_carton_fulfillment", "target": "transaction" },
           "shippingaddress"] }
```

- A bare string hop is shorthand for `{ "fieldId": ... }`.
- `target` re-types a polymorphic reference (e.g. a custom-record field pointing at
  `transaction` can be re-typed to `itemfulfillment`). **`target` works only on the hop it
  terminates — using it mid-chain fails with `Invalid identifier 'field^target'`.**

## Formula reference grammar

Formulas embed field paths in `{braces}`:

| Shape | Syntax |
| --- | --- |
| Forward hop | `{joinField^targetRecord.field}` |
| Chained forward | `{joinField^targetRecord.nextField^targetRecord.field}` (caret per typed hop) |
| Reverse (parent → child rows) | `{childRefField<childRecordType.fieldOnChild}` |
| Reverse then forward | `{childRefField<childRecordType.fieldOnChild^targetRecord.field}` |
| After a typed `^record` hop | subsequent hops are plain dots: `{a^itemfulfillment.location.mainaddress.city}` |

Example — item grain from a carton (via the Orderful shipped-item child record):

```
{custrecord_orderful_shipped_carton<customrecord_orderful_shipped_item.custrecord_orderful_shipped_item^item.displayname}
```

## Join vocabulary is context-dependent (measured)

| Join | Exists on | Does NOT exist on |
| --- | --- | --- |
| `transactionlines` | generic `transaction` | typed `itemfulfillment` |
| `location` | typed `itemfulfillment` | generic `transaction` |
| `shippingaddress` | generic `transaction` | — |
| `previouslinks` (on a transaction line) | `transaction.transactionlines` | — |

Practical consequences:

- **A dataset that needs transaction-line data must use base type `transaction`**, filtered to
  the record type via a condition on `type` (e.g. `ANY_OF ["ItemShip"]`). A custom-record base
  cannot reach `transactionlines` at all.
- **shipFrom (location) data from a `transaction` base** requires bouncing through a custom
  record reverse join and re-typing back:
  `{custrecord_orderful_carton_fulfillment<customrecord_orderful_carton.custrecord_orderful_carton_fulfillment^itemfulfillment.location.mainaddress.city}`
- **IF line → originating SO** is `transactionlines.previouslinks.previousdoc^transaction` —
  note `previouslinks`, NOT the SuiteQL table name `previoustransactionlinelink`. Roughly
  "Related Transaction Lines – Previous" in the Analytics UI.
- **There is no line-level previous-line join.** `previouslinks.previousline` exists as a
  field but not as a join, and comparing it to a joined SO line's `id` matches nothing (that
  `id` reads as constant 0). Correlate by business key instead — see below.

**Don't guess unknown join names** — probing burns time (60+ candidates failed before the
`previouslinks` name was recovered). Build the column once in the Analytics UI, save, then
`describe` the dataset: formula text round-trips verbatim, so the internal join id comes back out.

## The item-match correlation pattern

Dataset conditions compare a column **to literals only** — never to another column. To
correlate rows across a multi-join fan-out (e.g. carton × shipped-item × IF line × SO line),
add formula guard columns and condition on them:

```jsonc
{ "label": "mSoLine", "alias": "m1", "type": "INTEGER",
  "formula": "CASE WHEN {transactionlines.item} = {transactionlines.previouslinks.previousdoc^transaction.transactionlines.item} THEN 1 ELSE 0 END" },
// condition: { "columnLabel": "mSoLine", "operator": "EQUAL", "values": [1] }
```

Measured effect on one real fulfillment: 3,841 fan-out rows → 60 correct carton×item rows,
verified row-for-row against SuiteQL. Guard labels aren't in `LabelFieldMap`, so the label
path ignores them harmlessly (they show up in a `describe`/`dry-run` response's `ignoredColumns` — expected).

Caveat: item-match correlation keys on the **item**, so two SO lines with the same item won't
be distinguished. Acceptable for label datasets keyed by item; check per use case.

## Formula dialect limits (vs SuiteQL)

| Construct | SuiteQL | Dataset formula |
| --- | --- | --- |
| `REGEXP_SUBSTR(s, pat, 1, 1, NULL, 1)` (capture group) | works | **fails** ("unexpected error") |
| `REGEXP_REPLACE(s, pat, '\1')` (backreference) | works | **fails** |
| `REGEXP_SUBSTR(s, pat)` (2-arg, whole match) | works | works |
| `INSTR` / `SUBSTR` / `RTRIM` / `NVL` / `TO_CHAR` / `CASE WHEN` | works | works |

To extract a capture-group-style value, match the whole chunk and strip with string functions:

```
RTRIM(SUBSTR(chunk, INSTR(chunk, '":"', -1) + 3), '"')
```

(Example use: extracting one qualifier's value from the JSON stored in
`custcol_orderful_item_identification`, where the pair's position varies per line.)

## Column rules (measured)

- **Formula columns require an `alias`.** Without one NetSuite fails with a bare
  `An alias is missing` that names no column.
- **Two plain-field columns resolving to the same field name collide** (`Duplicate alias`) —
  e.g. `addr1` via a shipTo join and `addr1` via a shipFrom join. Give explicit aliases.
- **A formula's declared `type` must match the underlying field type.** A FLOAT field declared
  INTEGER fails with an opaque "unexpected error". When probing an unknown field, wrap in
  `TO_CHAR(...)` and declare STRING.

## Lifecycle limits (measured)

| Operation | Result |
| --- | --- |
| `dataset.load({id})` | works — full columns + condition tree |
| mutate loaded `columns` / replace `condition` | works in memory |
| clear condition (`condition = null`) | **fails** — `Wrong parameter type`. Conditions can be replaced, never removed, via script. To neutralise a bad condition, *replace* it with a tautology, or rebuild the dataset under a new scriptid without one. |
| rename via `ds.name = x` | **fails** — read-only; pass `name` to `save()` |
| `save()` no-arg | **fails** — "Missing a required argument: options" (typings say `save(): void` — wrong) |
| `save({name, id})` | works — returns `{id}` |
| re-save under the SAME scriptid | **fails** — "Unable to save the dataset." Edits persist only under a NEW scriptid; repoint the consumer. Fails clean (no partial write). |
| delete | **does not exist** in `N/dataset` — UI only |

## Runtime behavior of the SuiteApp consumers

Both consumers narrow the dataset to one source transaction at execution time, but
**they do it differently** — worth knowing precisely, because the two failure modes
are opposite.

| | Label path (`label/datasetMapping.ts`) | 856 packaging path (`Repositories/carton.repository.ts`) |
| --- | --- | --- |
| Trigger | `if (loadedDataset?.condition)` | `if (condition?.children && children.length > 0)` |
| Any stored condition | ANDs its filter on | ANDs its filter on |
| **Single-leaf** stored condition | ANDs it on | **REPLACES it** |
| No stored condition | creates the filter | creates the filter |
| Operator / values | `EQUAL`, single id | `ANY_OF`, array |

Consequences:

- **A dataset must not carry its own source filter.** On the label path a baked-in
  `Fulfillment = <id>` becomes `<baked> AND <actual>`, false for every real
  fulfillment, and the consumer processes zero rows **silently** — labels just don't
  generate. Found live at a customer.
- **On the packaging path, a single-leaf baked filter is silently *discarded* instead**
  — rows come back, but whatever the dataset author intended that condition to do is
  simply not applied. Opposite symptom, same root cause. The single-leaf replace is a
  genuine SuiteApp bug, tracked as **NS-1188**.
- The lab's `run` action ANDs whenever any condition exists (label-path behaviour),
  deliberately: this endpoint must not show more rows than the real dataset returns.
  For a packaging dataset with a single-leaf condition, `run` is therefore **stricter
  than the packaging runtime** — it can show zero rows where production returns rows.
  It is never looser. Don't read a zero-row `run` on such a dataset as proof the
  runtime is broken.

### Source columns (NS-689, connector #907)

Packing can now happen against a **Sales Order**, before any Item Fulfillment exists,
so a dataset may identify its source transaction by either column:

- `columnConfigs` exports `SOURCE_TRANSACTION_COLUMN_LABELS = ['Fulfillment', 'SalesOrder']`.
  Neither is individually `mandatory`; the **at-least-one** rule is enforced in
  `validatePackagingAnalyticsDataSource`, and mirrored for labels in
  `validateLabelContract`.
- Every pre-NS-689 dataset stays valid unchanged.
- The runtime filters on `SalesOrder` when the caller asked for SO cartons, otherwise
  on `Fulfillment` — one column per run.
- A formula-backed source column must return INTEGER (both paths filter it against
  internal ids).
- The source column is the filter, not a label field: it is neither `recognized` nor
  `ignored` in the label contract result.

### Silent-drop rule (label path)

`getDatasetMapping` silently drops any column whose label isn't an exact
case-insensitive `LabelFieldMap` dotted path. A typo'd label = a blank field on the
label, no error anywhere. `LabelFieldMap` is the authority, not `LabelPayload` and not
any hand-kept list — the connector reconstructs it in
`TransactionHandling/label/labelFieldMap.ts` (#907) after the `@orderful/platform-types`
import turned out to be a *type* used as a runtime value. Read the current paths from
that file, or from a `describe` response's `ignoredColumns`; do not transcribe them.

## Misc

- Dataset UI URL: `/app/common/report/dataset.nl?dataset=<internal id>` — numeric internal id,
  not scriptid. Datasets saved WITHOUT a custom scriptid are auto-named `custdataset<N>` where
  N **is** the internal id; with a custom scriptid there is no API path to the internal id
  (datasets aren't queryable in SuiteQL and `dataset.list()` returns scriptids).
- `runPaged().count` appears capped at 5000 — don't read it as a true total on big datasets.
- `dataset.list()` / `describe` / dry-run are safe on production accounts (pure reads).
