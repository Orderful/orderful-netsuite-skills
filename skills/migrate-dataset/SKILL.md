---
name: migrate-dataset
description: Migrate a NetSuite SuiteAnalytics Dataset from one NS account to another via SDF — the typical sandbox-to-prod move for an Orderful "Packaging Data Source" (carton dataset, pallet dataset, or any Analytics Dataset the SuiteApp consumes via N/dataset at runtime). Walks through SDF project bootstrap, interactive auth setup via an expect-driven flow that only needs the user for the browser OAuth, object:import from source, the workbook-required SDF validation gotcha, customer-ID filter swap, the "file upload error" misleading-failure trap, and the post-deploy REST step to register the dataset on customrecord_orderful_pkg_data_src. Use when the user says "migrate dataset from sandbox to prod", "move the carton dataset to prod", "deploy the SuiteAnalytics dataset via SDF", "/migrate-dataset", or after authoring a dataset in sandbox per the alternative-packing-source flow and needing to promote it.
---

# Migrate Analytics Dataset (Sandbox → Prod via SDF)

## When to use this skill

Use when the user says any of:

- "migrate the dataset from sandbox to prod"
- "deploy the carton dataset to prod"
- "move `<scriptid>` from one NS account to another"
- "promote the SuiteAnalytics dataset"
- "/migrate-dataset"

Pairs with [alternative-packing-source](../alternative-packing-source/SKILL.md) — that skill covers *authoring* a dataset in one account; this skill covers *promoting* it to another. Same pattern works for any Analytics Dataset the SuiteApp consumes via `N/dataset` (carton, pallet, label data source, inventory advice).

## What you're not doing

This skill **does not** rebuild the dataset by hand in the target account. The whole point is to lift the existing dataset XML out of the source via SDF, optionally edit a couple of values (customer-id filter, ownerId), and push to the target. Editing the dataset CDATA structure by hand beyond simple regex swaps is a trap — the schema is fragile.

This skill **does not** create the dataset's underlying NetSuite Analytics workbook in the source. Use the `alternative-packing-source` skill for that — it walks through dataset authoring in the NS UI.

## Prerequisites

1. The dataset already exists in the **source** NS account (typically sandbox) and was authored via the NS UI per `alternative-packing-source`. Confirm: `suitecloud object:list --type dataset` should show the dataset's scriptid.
2. SuiteCloud CLI installed: `npm install -g @oracle/suitecloud-cli` (or `npx @oracle/suitecloud-cli` everywhere).
3. `expect` available: macOS ships with `/usr/bin/expect`; on Linux install via `apt install expect`.
4. The user can log into both accounts in a browser when prompted (one browser flow per auth setup).

## Inputs

Ask up-front:

1. **Customer slug** — names `~/orderful-onboarding/<slug>/` and the SDF auth IDs (`<slug>-sb`, `<slug>-prod`).
2. **Dataset scriptid** to migrate (e.g., `custdataset_orderful_carton_dataset_basic` or a customer-authored `custdataset_<slug>_packaging_856`).
3. **Source NS account ID** (typically sandbox) and **target account ID** (typically prod).
4. **Target customer's NS internal ID** — needed for the filter swap if the dataset has a per-customer entity filter (it often does, baked in at authoring time).

## The recipe

### Step 1 — Bootstrap the SDF project

Per-customer convention: SDF projects live at `~/orderful-onboarding/<slug>/sdf/<slug>-acp/` (acp = account customization project). Create the skeleton:

```bash
SDF_ROOT=~/orderful-onboarding/<slug>/sdf/<slug>-acp
mkdir -p $SDF_ROOT/src/Objects $SDF_ROOT/src/AccountConfiguration $SDF_ROOT/src/FileCabinet $SDF_ROOT/src/Translations
```

Write four files:

**`$SDF_ROOT/project.json`**

```json
{
	"defaultAuthId": "<slug>-sb"
}
```

**`$SDF_ROOT/suitecloud.config.js`**

```js
module.exports = {
	defaultProjectFolder: "src",
	commands: {}
};
```

**`$SDF_ROOT/src/manifest.xml`**

```xml
<manifest projecttype="ACCOUNTCUSTOMIZATION">
  <projectname><slug>-acp</projectname>
  <frameworkversion>1.0</frameworkversion>
</manifest>
```

**`$SDF_ROOT/src/deploy.xml`**

```xml
<deploy>
    <translationimports>
        <path>~/Translations/*</path>
    </translationimports>
    <objects>
        <path>~/Objects/*</path>
    </objects>
</deploy>
```

If a `<slug>-acp` SDF project already exists for this customer (e.g., from prior SuiteScript work), reuse it — don't create a parallel one. Drop the migration objects into the existing `src/Objects/`.

### Step 2 — Set up SDF auths for source and target

The CLI's `account:setup` is interactive — it asks for the auth-id name as a text prompt, then opens a browser for OAuth. The `sdf_setup.exp` script in this folder drives the prompts so the user only sees the browser step.

```bash
cd $SDF_ROOT
~/Documents/GitHub/orderful-netsuite-skills/skills/migrate-dataset/sdf_setup.exp <slug>-sb
# Browser opens → user logs into SANDBOX → confirm
```

```bash
~/Documents/GitHub/orderful-netsuite-skills/skills/migrate-dataset/sdf_setup.exp <slug>-prod
# Browser opens → user logs into PROD → confirm
```

**Critical gotcha:** if the user's browser is already signed into sandbox when the second flow opens, the prod auth will end up pointing at sandbox too. Verify after each:

```bash
suitecloud account:manageauth --info <slug>-prod
# Account Type must be "Production"; account ID must NOT end in "_SB1"
```

If the prod auth points at sandbox, remove and re-run with an incognito/private browser window:

```bash
suitecloud account:manageauth --remove <slug>-prod
```

### Step 3 — Import the dataset from source

Point `defaultAuthId` at the source (sandbox):

```bash
# In $SDF_ROOT/project.json
{ "defaultAuthId": "<slug>-sb" }
```

Pull the dataset XML:

```bash
cd $SDF_ROOT
suitecloud object:import \
  --type dataset \
  --scriptid <dataset-scriptid> \
  --destinationfolder /Objects \
  --excludefiles
```

The imported XML lands at `src/Objects/<dataset-scriptid>.xml`. Open it and find any `[scriptid=custcollectiontranslations_dataset_*]` dependency references — those are translation collections that hold the column-label strings. Import each:

```bash
suitecloud object:import \
  --type translationcollection \
  --scriptid <translation-collection-scriptid> \
  --destinationfolder /Objects \
  --excludefiles
```

A typical dataset has exactly one translation collection dependency, named like `custcollectiontranslations_dataset_<n>_<hash>`.

### Step 4 — Add a placeholder workbook (the workbook-required gotcha)

SDF validation rejects datasets that aren't referenced by a workbook in the project — even though the SuiteApp at runtime queries the dataset directly via `N/dataset` and never touches the workbook. Validation error:

```
An error occurred during custom object validation. (<dataset-scriptid>)
Details: The <dataset-scriptid> dataset object must have at least one workbook
object referencing it.
File: ~/Objects/<dataset-scriptid>.xml
```

To pass validation you must include a workbook in the deploy bundle that references the dataset. Hand-crafting the workbook CDATA is brittle (server-side validation rejects subtle structural omissions with an opaque "file upload error"). The reliable approach: import any existing workbook from the source NS, then sed-swap its dataset references to point at your dataset.

```bash
# List any workbook in source
suitecloud object:list --type workbook
# Pick any one — the simpler the pivot/chart, the better

# Import it
suitecloud object:import \
  --type workbook \
  --scriptid <source-workbook-scriptid> \
  --destinationfolder /Objects \
  --excludefiles

# Sed-swap to point at YOUR dataset + give the wrapper a stable scriptid
WB=src/Objects/<source-workbook-scriptid>.xml
NEW=src/Objects/custworkbook_<slug>_dataset_wrap.xml
sed \
  -e 's/<source-workbook-scriptid>/custworkbook_<slug>_dataset_wrap/g' \
  -e 's/<source-pivot-scriptid>/custpivot_<slug>_dataset_wrap/g' \
  -e 's/<source-dataset-scriptid>/<your-dataset-scriptid>/g' \
  -e 's|<source-workbook-translation-id>|<your-dataset-translation-id>|g' \
  -e 's|<source-pivot-translation-id>|<your-dataset-translation-id>|g' \
  "$WB" > "$NEW"
rm "$WB"
```

The replacement workbook will reference fields that don't exist in your dataset (formula columns, currency types from the source). That's fine — SDF validation accepts the CDATA as opaque text; the workbook is never queried at runtime by the SuiteApp.

### Step 5 — Swap the customer-ID filter (if present)

Many SuiteAnalytics datasets authored in the UI bake in an entity filter. The dataset's CDATA looks like:

```xml
<expressions type="array">
  <_ITEM_>
    <value>
      <type>KEY</type>
      <value type="string"><sandbox-customer-id></value>
    </value>
    <label><sandbox-customer-entityid> <Customer Display Name></label>
    ...
```

This won't work in the target account — the customer's internal ID is different. Swap:

```bash
DATASET_XML=src/Objects/<your-dataset-scriptid>.xml
sed -i.bak \
  -e 's|<value type="string"><sandbox-customer-id></value>|<value type="string"><target-customer-id></value>|' \
  -e 's|<label><sandbox-customer-entityid> .*</label>|<label><target-customer-entityid> <Customer Display Name></label>|' \
  "$DATASET_XML"
rm "${DATASET_XML}.bak"
```

After the swap, verify:

```bash
grep -A1 'type="string">[0-9]\{6,\}' "$DATASET_XML"
# Should show the TARGET customer ID only
```

If the dataset filters on the customer (entity = X), the SuiteApp's runtime filter (`Fulfillment ANY_OF [ifIds]`) AND-merges with this — so leaving the wrong ID in place will produce a dataset that returns zero rows in prod, silently, when the SuiteApp tries to build the 856 carton hierarchy.

### Step 6 — Dry-run deploy against the target

Switch `defaultAuthId` to the target:

```bash
# In $SDF_ROOT/project.json
{ "defaultAuthId": "<slug>-prod" }
```

Run the deploy preview:

```bash
suitecloud project:deploy --dryrun
```

Expect "Preview COMPLETE" with the four objects listed:

```
Create object -- <translation-collection-scriptid> (translationcollection)
Create object -- <your-dataset-scriptid> (dataset)
Create object -- custworkbook_<slug>_dataset_wrap (workbook)
Create object -- custworkbook_<slug>_dataset_wrap.<pivot-scriptid> (pivot)
```

If validation fails on the dataset's workbook-reference check, you're missing the placeholder workbook from Step 4 — re-check the file is in `src/Objects/` and references your dataset's scriptid in its `<dependencies>` and CDATA `<datasets>` array.

### Step 7 — Deploy and verify (the "file upload error" trap)

```bash
suitecloud project:deploy
```

The workbook upload often fails with an opaque error even when validation passed:

```
*** ERROR ***

A file upload error occurred.
Details: A file upload error occurred.

File: ~/Objects/custworkbook_<slug>_dataset_wrap.xml
Installation FAILED
```

**The dataset and translation collection still landed in the target.** SDF deploys are not transactional — earlier objects in the bundle commit before a later failure. Verify before re-running:

```bash
# Switch to target auth and list datasets
suitecloud object:list --type dataset | grep <your-dataset-scriptid>
# Should be present in the target

# Pull the dataset back from target and verify the entity filter has the right customer
suitecloud object:import --type dataset --scriptid <your-dataset-scriptid> --destinationfolder /Objects
grep '<value type="string"><target-customer-id>' src/Objects/<your-dataset-scriptid>.xml
```

If the dataset is in the target, you're done with SDF — the workbook failure doesn't block the SuiteApp from using the dataset. Move the dataset and translation collection XMLs out of `src/Objects/` (e.g., into `_already-deployed/`) so future SDF deploys against this project don't re-trip the workbook-required validation when the dataset is already present.

If the dataset did NOT land in the target, the workbook XML you built is the culprit — try a different source workbook in Step 4 (a simpler one with fewer pivot dimensions usually deploys cleaner).

### Step 8 — Register the dataset on customrecord_orderful_pkg_data_src

The SuiteApp doesn't auto-discover datasets — you have to create a `customrecord_orderful_pkg_data_src` row pointing at the dataset's scriptid, then link that row on each customer that should use it via `custentity_orderful_pkg_data_src`.

This is REST work, not SDF. Use the customer's `.env` TBA credentials.

```bash
cat > /tmp/create_pkg_data_src.mjs << 'EOF'
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.env.HOME, 'orderful-onboarding/<slug>/.env'), override: true });

// Target = prod
const p = 'NS_PROD';
const a = process.env[`${p}_ACCOUNT_ID`];
const oauth = OAuth({
  consumer: { key: process.env[`${p}_CONSUMER_KEY`], secret: process.env[`${p}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (b, k) => crypto.createHmac('sha256', k).update(b).digest('base64'),
  realm: a,
});
const token = { key: process.env[`${p}_TOKEN_ID`], secret: process.env[`${p}_TOKEN_SECRET`] };
const host = `${a.toLowerCase()}.suitetalk.api.netsuite.com`;

async function call(method, path, body) {
  const url = `https://${host}${path}`;
  const auth = oauth.toHeader(oauth.authorize({ url, method }, token));
  auth.Authorization = auth.Authorization.replace('OAuth ', `OAuth realm="${a}", `);
  const r = await fetch(url, {
    method,
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, location: r.headers.get('location'), body: r.status === 204 ? null : await r.json().catch(() => null) };
}

const DATASET_SCRIPTID = '<your-dataset-scriptid>';
const TARGET_CUSTOMER_ID = '<target-customer-id>';
const PKG_NAME = '<Packaging Source Display Name>';

console.log('Step 1: create pkg_data_src record');
const create = await call('POST', '/services/rest/record/v1/customrecord_orderful_pkg_data_src', {
  name: PKG_NAME,
  custrecord_orderful_pkg_data_src_id: DATASET_SCRIPTID, // text field, stores dataset scriptid
});
console.log('  POST →', create.status, 'loc:', create.location);
const pkgId = create.location?.split('/').pop();
if (!pkgId) process.exit(1);

console.log(`Step 2: link pkg_data_src ${pkgId} on customer ${TARGET_CUSTOMER_ID}`);
const link = await call('PATCH', `/services/rest/record/v1/customer/${TARGET_CUSTOMER_ID}`, {
  custentity_orderful_pkg_data_src: { id: pkgId },
});
console.log('  PATCH →', link.status);
EOF
node /tmp/create_pkg_data_src.mjs
```

**Field shape:** `custrecord_orderful_pkg_data_src_id` is a plain TEXT field that holds the dataset scriptid as a string. Don't try to send `{ id: ... }` — it expects a flat string. This is required on create (`Please enter value(s) for: Dataset ID` on POST if missing).

After this, the SuiteApp will use the dataset when generating 856 ASNs for the target customer.

### Step 9 — End-to-end verify

Build (or pick) an Item Fulfillment in the target account that has cartons, trigger 856 generation, and confirm:

1. The outbound 856 reaches Orderful and validates against the partner guideline.
2. The carton hierarchy (HL*P loops, MAN*GM, item-level HL*I) matches what the dataset produces. If carton rows are missing, recheck the dataset filter (Step 5) — `entity = wrong-customer-id` is the most common silent failure.

## Behaviour rules

1. **Never hand-author workbook CDATA.** Always source the placeholder workbook from an existing one in the source account via `object:import` and sed-swap the dataset references. Crafted-from-scratch workbook XML fails with opaque "file upload errors" that aren't worth debugging.
2. **Always verify after a failed deploy.** Don't re-run blindly — check whether the dataset + translations actually landed despite the workbook upload error. Re-running a partial-success deploy produces "Update object" entries in the next preview that suggest a fresh write but actually no-op.
3. **Don't skip the customer-ID swap.** Datasets authored in the UI typically bake in `entity = <customer-id>` filters. The target customer's ID is different from the source's. Skipping this step produces a dataset that returns zero rows in the target account — and the SuiteApp will fail 856 generation silently with "no cartons found" instead of a clear error.
4. **Move deployed objects out of `src/Objects/` after first successful deploy.** Future SDF deploys against the same project will re-validate the workbook-required check; keeping the dataset XML in `src/Objects/` after deploy guarantees the next unrelated SDF deploy will fail.
5. **Verify the prod auth's account type before deploying.** The browser-session leakage from sandbox to prod is the most common setup error. `suitecloud account:manageauth --info <slug>-prod` should show `Account Type: Production` and an account ID without `_SB1`.
6. **One dataset per customer when filters are baked in.** If the dataset's entity filter is per-customer (i.e., it can't be made customer-agnostic), each future customer using this packaging pattern needs their own dataset migrated/authored. This is a SuiteApp design limitation worth flagging for the SuiteApp team if it comes up repeatedly.
7. **Translation-collection scriptids carry over.** The translation collection's scriptid (`custcollectiontranslations_dataset_<n>_<hash>`) is generated when the dataset is first authored in the UI and is referenced by the dataset's column-label `<translationScriptId>` entries. Don't rename it during migration — the cross-references will break.

## Reference material

- [`alternative-packing-source`](../alternative-packing-source/SKILL.md) — authoring the dataset in the source NS (precursor to this skill)
- [`netsuite-setup`](../netsuite-setup/SKILL.md) — TBA credentials needed for Step 8's REST call
- [SuiteApp source: `Models/carton.ts → columnConfigs`](https://github.com/Orderful/netsuite-connector) — the dataset's required column contract (Fulfillment, Carton, Item, Quantity, etc.)
- [SuiteApp source: `Repositories/carton.repository.ts → queryCartonsFromDataset`](https://github.com/Orderful/netsuite-connector) — the runtime query the SuiteApp makes against the dataset

## Why this skill exists

The dataset migration story spans SDF, NS Analytics, and the SuiteApp's runtime — three different surfaces, each with non-obvious behaviour. Without this skill the path is: hit the workbook-required validation; spend an hour hand-crafting a workbook XML; hit the "file upload error" with no log detail; assume the deploy failed entirely; re-deploy; double-create translations; finally discover the dataset landed the first time; then forget the customer-ID swap and have an empty 856 production. Each of those traps surfaced in a single onboarding — capturing them here saves the next contractor several hours.
