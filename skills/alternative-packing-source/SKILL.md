---
name: alternative-packing-source
description: Set up the Orderful SuiteApp's "Packaging Data Source" feature for a customer whose carton/item data lives in non-standard custom records (Manhattan WMS, BluJay, custom 3PL feeds, etc.) instead of the SuiteApp's native customrecord_orderful_carton. Walks through identifying candidate records, mapping fields to Orderful's required column contract, building a validation CSV from a real Item Fulfillment, authoring the NetSuite Analytics Dataset in the UI, pulling it back via SDF for version control, and setting the customer's Packaging Data Source entity field. Use when the user mentions an alternative packing source, a customer that already has carton records (but not Orderful's), Manhattan/3PL-fed packing data, or asks how to power 856 ASNs from existing carton/SSCC data.
---

# Alternative Packing Source for 856 ASN

## When to use this skill

Use when the user says any of:

- "set up alternative packing source for \<customer\>"
- "\<customer\> already has carton records — use those for the 856"
- "Manhattan/3PL-fed packing data"
- "use the existing carton custom records to power the ASN"
- "the SuiteApp's standard cartons are empty — \<customer\> has their own"
- "configure Packaging Data Source for \<customer\>"
- "build a NetSuite analytics dataset for the 856"

If the user is asking about the SuiteApp's standard carton flow (where the connector creates customrecord_orderful_carton itself during fulfillment), this skill does NOT apply — that's the default and needs no setup.

## Prerequisites

1. The user has already run `/netsuite-setup` for this customer. `~/orderful-onboarding/<slug>/.env` exists with valid TBA credentials.
2. The user has SDF CLI configured with an auth ID for this customer (`suitecloud account:manageauth --list` should show it). If not, route them to set up SDF first — it's needed to pull the dataset back as SDF XML for version control.
3. The customer has *some* existing custom record(s) holding carton-level data populated by their WMS / 3PL / EDI provider. Confirm before starting; if they don't, the standard SuiteApp flow is what they want.

## Inputs

Ask up-front (don't proceed without):

1. **Customer slug** — to load the right `.env`.
2. **Which custom record(s) hold the carton data** — sometimes the user knows (e.g., "we have `customrecord_xyz_carton`"), sometimes they don't and we need to discover. If unknown, see Step 1.
3. **A recent Item Fulfillment internal ID** that has carton data populated — needed to validate the mapping end-to-end.

## The connector's column contract (verbatim, do NOT paraphrase)

The SuiteApp's `CartonRepository.validatePackagingAnalyticsDataSource` checks the dataset's column **labels** (case-insensitive). Source: `netsuite-connector/FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/Models/carton.ts → columnConfigs`.

| Column | Required? | Type | Notes |
|---|---|---|---|
| Fulfillment | YES | INTEGER | Item Fulfillment internal ID. The connector filters the dataset by `Fulfillment ANY_OF [ifIds]` at 856 generation time. If a formula is used, the column type *must* be INTEGER — the validator rejects otherwise. |
| Carton | YES | string-or-number | Unique carton identifier within the dataset. Need not be a real internal ID. |
| Item | YES | NUMBER | Native NetSuite item internal ID. Coerced via `Number(...)`. |
| Quantity | YES | NUMBER | Packed quantity in the line's transaction UOM. |
| Length / Width / Height | optional | NUMBER | Carton dimensions. |
| Weight | optional | NUMBER | Carton weight. |
| IsPallet | optional | BOOLEAN | true ⇒ pallet, false/absent ⇒ carton. |
| Parent | optional | string | Carton's parent pallet identifier (= the `Carton` value of the pallet row). |
| Pallet | optional | string | Alternative way to declare a parent — connector infers a pallet from this column when no `IsPallet=true` row exists. |
| SSCC | optional | string | 18- or 20-digit SSCC label. |
| Tracking | optional | string | Tracking / PRO / parcel number. |
| Tiers / Blocks | optional | INTEGER | Pallet tier/block counts. |
| Serial | optional | string | Custom serial number. |
| Lot | optional | string | Lot/serial for the packed item. |
| Expiration | optional | DATE | Expiration date for the packed item. |

**Result must be flat — one row per (Fulfillment, Carton, Item) tuple.** Carton-level metadata (dimensions, SSCC, Tracking) is allowed to repeat across rows for the same Carton; the connector dedupes by `Carton` value. Filters in the dataset are AND-merged with the connector's runtime filter — leave the dataset unfiltered.

## The recipe

### Step 1 — Find candidate carton custom records (if unknown)

If the user can't name the record, probe via SuiteQL. Carton records typically have a name containing "carton" / "ship" / "pack" / "asn" and at least one row referencing an Item Fulfillment.

```sql
-- Custom record types likely related to packing
SELECT scriptid, name, recordtype
FROM customrecordtype
WHERE BUILTIN.LOWER(scriptid) LIKE '%carton%'
   OR BUILTIN.LOWER(scriptid) LIKE '%pack%'
   OR BUILTIN.LOWER(scriptid) LIKE '%ship_unit%'
   OR BUILTIN.LOWER(scriptid) LIKE '%asn%'
ORDER BY scriptid
```

For each candidate, check row count and field shape:

```sql
SELECT * FROM <candidate_record_scriptid> FETCH FIRST 1 ROWS ONLY
```

Look for fields that point to:
- Item Fulfillment (label often "IF" / "Item Fulfillment" / "Fulfillment Reference")
- An item (often an item internal ID stored as text or as a List/Record field)
- Quantity
- Carton identifier (SSCC-style 18- or 20-digit number, or a sequence number)

Two-record patterns are common: one record for the carton (header), another for items inside the carton (line). The line record will have a List/Record field pointing to the carton record. Confirm both records before proceeding.

### Step 2 — Sample one Item Fulfillment that has data

Pick a recent IF that has carton rows. Don't trust the first one — pick one with multiple SKUs and several cartons so the mapping gets exercised:

```sql
SELECT carton.<custrecord_if_field> AS fulfillment_id,
       COUNT(DISTINCT carton.id) AS cartons,
       COUNT(detail.id) AS detail_lines,
       COUNT(DISTINCT <item_field>) AS distinct_items
FROM <carton_record> carton
INNER JOIN <detail_record> detail
       ON detail.<carton_fk_field> = carton.id
WHERE carton.<custrecord_if_field> IS NOT NULL
  AND carton.created >= TO_DATE('<recent_date>', 'YYYY-MM-DD')
GROUP BY carton.<custrecord_if_field>
HAVING COUNT(DISTINCT carton.id) BETWEEN 5 AND 200
   AND COUNT(DISTINCT <item_field>) >= 3
ORDER BY COUNT(DISTINCT carton.id) DESC
FETCH FIRST 5 ROWS ONLY
```

Show the user the candidates and let them pick. Avoid IFs that only have 1 carton or 1 SKU — they're too narrow to validate the mapping.

### Step 3 — Confirm the item-ID source

The trickiest field: how does the carton-detail record reference the NetSuite item? Options seen in the wild:
- A direct `List/Record` field pointing to the item (easy — use the field directly)
- A free-form text field storing the item internal ID as a string (use, but note it's a text field — connector will `Number(...)` coerce it)
- A free-form text field storing a partner SKU / style code → needs lookup table or formula to resolve to NetSuite item internal ID
- A reference to the IF line, which itself has the item — requires a multi-hop join

Probe by joining a sample to the item record and confirming names match:

```sql
SELECT detail.<item_field> AS raw,
       i.itemid AS netsuite_itemid,
       i.displayname
FROM <detail_record> detail
LEFT JOIN item i ON i.id = TO_NUMBER(detail.<item_field>)
WHERE detail.created >= TO_DATE('<recent_date>', 'YYYY-MM-DD')
FETCH FIRST 10 ROWS ONLY
```

If the join lands clean values across distinct rows, the field stores item internal IDs directly — proceed. If not, escalate to the user for the lookup logic.

### Step 4 — Build the field mapping table

For the chosen records, write down the mapping in a markdown table — this becomes both the spec for the dataset and an artifact the user can review:

| Orderful column | Required? | Source field | Notes |
|---|---|---|---|
| Fulfillment | YES | `<carton>.<if_field>` | already an IF internal ID |
| Carton | YES | `<carton>.id` | NS internal ID; guaranteed unique |
| Item | YES | `<detail>.<item_field>` | confirmed = NS item ID via Step 3 |
| Quantity | YES | `<detail>.<qty_field>` |  |
| Length / Width / Height | optional | `<carton>.<dim_fields>` |  |
| Weight | optional | `COALESCE(<actual_weight>, <est_weight>)` | use the actual scale weight when available |
| SSCC | optional | `<carton>.<sscc_or_label_field>` |  |
| Tracking | optional | `<carton>.<pro_or_tracking_field>` |  |

Save this to `~/orderful-onboarding/<slug>/packing-dataset/README.md`. Cite the connector source files (`Models/carton.ts`, `Repositories/carton.repository.ts`) so future readers can verify the contract is current.

### Step 5 — Generate a flat validation CSV

Write a SuiteQL query that produces the exact column shape, one row per item/carton, and dump the result to CSV:

```sql
-- Save as ~/orderful-onboarding/<slug>/packing-dataset/preview.sql
SELECT
    carton.<if_field>                                                  AS "Fulfillment",
    carton.id                                                          AS "Carton",
    TO_NUMBER(detail.<item_field>)                                     AS "Item",
    detail.<qty_field>                                                 AS "Quantity",
    carton.<length_field>                                              AS "Length",
    carton.<width_field>                                               AS "Width",
    carton.<height_field>                                              AS "Height",
    COALESCE(carton.<actual_weight>, carton.<est_weight>)              AS "Weight",
    carton.<sscc_field>                                                AS "SSCC",
    carton.<tracking_field>                                            AS "Tracking"
FROM <carton_record> carton
INNER JOIN <detail_record> detail
       ON detail.<carton_fk_field> = carton.id
WHERE carton.<if_field> = <test_if_id>
  AND carton.<if_field> IS NOT NULL
ORDER BY carton.id
```

Run via the standard TBA SuiteQL pattern (`samples/list-edi-customers.mjs` is the reference for the OAuth 1.0a signing). Pipe the JSON output through a small flattener that emits CSV with the **exact column header strings** from the contract above. Save to `~/orderful-onboarding/<slug>/packing-dataset/sample_if<id>.csv`.

Show the user:
- Total row count
- Distribution by item (cartons + total quantity per item)
- A 5-row preview

This is the proof that the mapping is correct. If the user spots anomalies (a SKU not in their order, weights wildly off), STOP and re-check Step 3.

### Step 6 — Build the dataset in the NetSuite UI

The Orderful SuiteApp consumes a NetSuite **Analytics Dataset** (`N/dataset` module), not a SuiteQL query. The dataset MUST be built in the UI (Analytics > Datasets > New Dataset) — there's no REST endpoint for dataset creation, and SDF can't deploy a brand-new dataset without also bundling a stub workbook (which is not worth hand-authoring).

Walk the user through:

1. **Source**: select the carton-detail record as the base record. (Detail is the right base — it has 1 row per item-carton, which is the desired output shape.)
2. **Add columns** by dragging from the field tree. For each, set the column's **label override** (click the column header → edit) to the EXACT label string from the contract. Case doesn't matter for the SuiteApp's matcher, but use the canonical capitalization ("Fulfillment", "Carton", "Item", "Quantity", "Length", "Width", "Height", "Weight", "SSCC", "Tracking") for clarity.
3. **No filters** — leave the criteria block empty. The connector adds a runtime filter.
4. **Save with a meaningful scriptid**: convention `custdataset_<customer>_packaging_856`.

Hand them the field mapping from Step 4. They click through; this takes 10 minutes.

### Step 7 — Pull dataset back via SDF for version control

After the user saves the dataset, fetch it as SDF XML so you have a reviewable, committable artifact:

```bash
cd ~/orderful-onboarding/<slug>/sdf       # or wherever the customer's SDF project lives
suitecloud object:import \
    --type dataset \
    --scriptid custdataset_<slug>_packaging_856 \
    --destinationfolder /Objects
```

Also import the auto-created translation collection (it holds the column label strings as translation references):

```bash
suitecloud object:import \
    --type translationcollection \
    --scriptid custcollectiontranslations_dataset_<n>_<hash> \
    --destinationfolder /Objects
```

(Get the translation collection scriptid by reading the imported dataset's `translationScriptId` references.)

Verify each column's translation resolves to the right label:

```bash
grep -A1 'scriptid="dataset_field' src/Objects/<translationcollection>.xml \
    | grep '<defaulttranslation>'
```

Cross-reference each column's `uniqueId` against the connector's required label, like:

| ColumnId | uniqueId | Label | Match? |
|---|---|---|---|
| 2 | `<carton_join>.<if_field>` | fulfillment | ✓ |
| 3 | `<carton_join>.id` | carton | ✓ |
| ... | ... | ... | ... |

If any label doesn't match, send the user back to the UI to fix that column header. Don't try to edit the translation collection XML by hand — it's brittle.

### Step 8 — Wire up the customer

Once the dataset is verified, on each EDI customer record where this packing source should be used, set:

- **EDI → Order Management → Packaging Data Source** = the dataset scriptid

When the SuiteApp generates an 856, it will:
1. Detect the customer's Packaging Data Source field is set
2. `dataset.load()` that scriptid
3. Apply `Fulfillment ANY_OF [ifIds]` to the dataset's existing condition
4. Iterate the result, building cartons + packed items from the rows

## Behaviour rules

1. **Don't author dataset XML by hand.** SDF can validate it locally, but server-side validation rejects datasets without a referencing workbook, and authoring a stub workbook is brittle. Always build in the UI, then import.
2. **Don't skip the validation CSV.** The flat CSV from Step 5 is the proof the mapping is right. If you build the dataset before producing it, you'll find out the mapping is wrong only after the SuiteApp tries to consume it on a real 856.
3. **Don't paraphrase the column contract.** The labels and required types come straight from `netsuite-connector/Models/carton.ts → columnConfigs` and `Repositories/carton.repository.ts`. If those change in a connector release, this skill needs updating, not improvising.
4. **Pallet hierarchy is opt-in.** Many WMS feeds only stage cartons (no pallet rows). Don't fabricate `IsPallet=true` rows from carton metadata — if the user needs pallet structure on the 856, they need a real pallet record source, and that's a separate discovery.
5. **Lot / Serial / Expiration must come from the data.** If the customer doesn't track lots in NetSuite (no `LotNumberedInvtItem` records), don't add those columns to the dataset. The SuiteApp will use them when present and ignore when absent — false data is worse than no data.
6. **Don't enable the Packaging Data Source field on a customer until validation passes.** Once the field is set, the next 856 generation will use the dataset. If the dataset is broken, the ASN will be broken.
7. **Always cite the connector source.** Reference `Models/carton.ts` and `Repositories/carton.repository.ts` by file path so the user (and future-you) can verify the contract hasn't drifted.

## Reference material

- Orderful docs: [Alternative Packing Source](https://docs.orderful.com/docs/alternative-packing-source)
- Connector source: `netsuite-connector/FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/Models/carton.ts` (column contract), `Repositories/carton.repository.ts` (validator + runtime consumer)
- SuiteApp customer field: `custentity_orderful_pkg_data_src` ("Packaging Data Source" on the EDI → Order Management sub-tab)
