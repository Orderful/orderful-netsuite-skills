---
name: o2c-discovery
description: Auto-answer Orderful's O2C Discovery Questionnaire for a NetSuite customer using SuiteQL. Runs a battery of read-only queries to fill out customer setup, item master, pricing, sales-order, fulfillment, and invoicing sections — anything that's derivable from configuration data — and produces a markdown findings file. Flags questions that genuinely require an interview (process narratives, edge-case threshold rules) so the contractor knows what's left. Use when the user is filling out the O2C discovery doc for a new customer, asks to "automate discovery", or wants a baseline of what NetSuite says before talking to stakeholders.
---

# O2C Discovery — Automated Answers

## When to use this skill

Use when the user says any of:

- "answer the O2C discovery questionnaire for \<customer\>"
- "fill out the discovery doc for \<customer\>"
- "automate discovery for \<customer\>"
- "what does NetSuite tell us about \<customer\>'s O2C config?"
- "give me a baseline before the discovery call with \<customer\>"

If the questionnaire is something other than Orderful's standard O2C discovery doc (e.g., a partner-specific intake), this skill still applies for the questions that overlap, but flag the gap clearly — don't pretend questions are answered when the source structure is different.

## Prerequisites

1. The user has run `/netsuite-setup` for the customer. `~/orderful-onboarding/<slug>/.env` exists with valid TBA credentials.
2. The customer's NetSuite has enough activity to answer fulfillment/invoicing questions — i.e., real sales orders, item fulfillments, invoices in the last few quarters. If the account is empty, most of this skill returns "no data" — say so and stop.
3. The user can produce a copy of the questionnaire (PDF or text) if it's the **non-standard** version. For the standard Orderful O2C Discovery Questionnaire, the question list is hard-coded in this skill (see Step 0 below) and no input is needed.

## Inputs

Ask up-front:

1. **Customer slug** — to load the right `.env`.
2. **Questionnaire version** — "standard Orderful O2C" (default) or "partner-specific" (in which case the user provides the PDF/markdown).
3. **(Optional) Subsidiary scope** — if the customer is OneWorld with multiple subsidiaries, ask which one(s) the discovery is for. Answer for the single subsidiary if specified; answer across the whole tenant otherwise and flag the breakdown.

## Step 0 — The standard question set

Orderful's O2C Discovery Questionnaire has six sections. This skill answers each from configuration data; questions that need a process interview are explicitly called out with **"Needs interview"**.

| § | Question | Source |
|---|---|---|
| 1.1 | How are customers set up — flat / hierarchy / subsidiaries? | `customer` + `subsidiary` |
| 1.2 | Are DCs set up as sub-customers or as ship-to addresses? | `customeraddressbook` distribution |
| 2.1 | What item types are in use? | `item.itemtype` |
| 2.2 | Custom item attributes / fields | `customfield` (scope: custitem) |
| 3.1 | Is pricing configured? | `pricelevel`, `itemprice` |
| 3.2 | Pricing structures (base / customer-specific / tiers / promo / contract) | distribution of `pricelevel` + `itemprice.priceqty` |
| 4.1 | SO approval process | `workflow` + `script` deployed on SALESORDER |
| 4.2 | How are shipping locations assigned? | `transactionline.location` distribution + script deployments |
| 4.3 | Custom fields on the SO form | `customfield` (scope: custbody) |
| 4.4 | Custom scripts / workflows on SO | `scriptdeployment` for SALESORDER + `workflow` |
| 5.1 | Own warehouse vs 3PLs | `location` + `transactionline.location` distribution |
| 5.2 | In-house vs outsourced warehouse ops | inferred from 5.1 + 5.3 |
| 5.3 | WMS in use | item-field/body-field naming patterns (Manhattan, BluJay, Körber prefixes) + `bin` granularity |
| 5.4 | Pick / pack / ship process narrative | **Needs interview.** Skill provides structural evidence (carton custom records, BOL scripts, GS1 GTIN fields) but process detail must come from the customer. |
| 5.5 | Lot / serial tracking in NetSuite | `item.itemtype` for `LotNumberedInvtItem` / `SerializedInvtItem` variants |
| 5.6 | Bin locations configured | `bin` count + distribution |
| 5.7 | Custom scripts / workflows on Item Fulfillment | `scriptdeployment` for ITEMFULFILLMENT |
| 6.1 | Auto-invoicing automation | scripts on ITEMFULFILLMENT / INVOICE + customer entity flags |
| 6.2 | Invoice delivery methods | EDI 810 entity flags (count) + email field presence |

Questions explicitly flagged **Needs interview**: 4.1 approver hierarchy + thresholds, 4.3 which custom body fields are *required* on the SO form, 5.4 process narrative, 6.1 trigger semantics for non-IF auto-invoicing.

## The recipe

### Step 1 — Set up a SuiteQL runner

If the customer's dir doesn't already have one, drop in a short Node helper that reads the `.env`, signs OAuth 1.0a, and runs a SuiteQL query passed as an arg. Pattern from `samples/list-edi-customers.mjs` and `skills/netsuite-setup/test-connections.mjs`. Save as `~/orderful-onboarding/<slug>/query.mjs`. Symlink the repo's `node_modules` for `dotenv` + `oauth-1.0a`:

```bash
ln -sf ~/Documents/GitHub/orderful-netsuite-skills/node_modules \
       ~/orderful-onboarding/<slug>/node_modules
```

Test with:

```bash
cd ~/orderful-onboarding/<slug>
node query.mjs "SELECT TOP 1 id FROM customer"
```

### Step 2 — Run the battery

Each query below maps to a section of the questionnaire. Run sequentially, capture results, build the findings doc as you go. **Output findings progressively** — don't wait until the end. The user wants to monitor as you make progress.

#### § 1.1 — Customer setup

```sql
SELECT COUNT(*) AS total,
       COUNT(parent) AS with_parent,
       COUNT(DISTINCT subsidiary) AS distinct_subsidiaries
FROM customer
WHERE isinactive = 'F'
```

```sql
SELECT s.name AS sub, COUNT(c.id) AS cnt
FROM customer c LEFT JOIN subsidiary s ON c.subsidiary = s.id
WHERE c.isinactive = 'F'
GROUP BY s.name
ORDER BY cnt DESC
```

```sql
SELECT id, name, fullname FROM subsidiary
```

Interpret: zero parents → flat list. Multiple subsidiaries used → multi-subsidiary OneWorld. Report top-level subsidiary name (the one with no parent or the shortest fullname).

#### § 1.2 — DCs as sub-customers vs ship-to addresses

```sql
SELECT c.entityid, c.companyname, COUNT(ab.entity) AS addr_count
FROM customer c
INNER JOIN customeraddressbook ab ON ab.entity = c.id
WHERE c.isinactive = 'F'
GROUP BY c.entityid, c.companyname
HAVING COUNT(ab.entity) >= 10
ORDER BY COUNT(ab.entity) DESC
```

Interpret: customers with hundreds-to-thousands of addresses (named like big-box retailers — JC Penney, Kohl's, Target, etc.) → **ship-to addresses**. Combined with §1.1's "zero parents" → confirms ship-to-address pattern. If addr_count caps out at single digits per customer and you saw parent-customer hierarchies, → **sub-customer** pattern.

#### § 2.1 — Item types

```sql
SELECT itemtype, COUNT(*) AS cnt
FROM item
GROUP BY itemtype
```

Interpret: report counts. Lot/serial-numbered variants (`LotNumberedInvtItem`, `SerializedInvtItem`, `LotNumberedAssemblyItem`, `SerializedAssemblyItem`) inform §5.5.

#### § 2.2 — Custom item fields

```sql
SELECT scriptid, name, fieldvaluetype
FROM customfield
WHERE LOWER(scriptid) LIKE 'custitem%'
ORDER BY scriptid
```

Group results by integration prefix. Common groupings to call out explicitly:
- **EDI-critical**: GTIN inner/outer, EAN, UPC, case-pack quantity, harmonization code, NMFC, country of origin
- **WMS-related**: standard-pallet-quantity, synced-to-\<wms\>, error-message, integration-status fields (Manhattan, BluJay, Körber)
- **PIM-related**: Salsify, Akeneo prefixes
- **Marketplace**: Celigo Amazon/eBay/Magento/Shopify/Walmart prefixes
- **Tax / regulatory**: Avalara (CUSTITEM_AVA_*), state compliance (CO PFAS, MN HF, WA HB)
- **Lot/serial**: ALN bundle (Auto Lot Numbering)

Save the full list as `~/orderful-onboarding/<slug>/custitem_fields.json` for reference.

#### § 3.1 + 3.2 — Pricing

```sql
SELECT COUNT(*) AS active_price_levels FROM pricelevel WHERE isinactive='F'
```

```sql
SELECT COUNT(*) AS rows_in_itemprice FROM itemprice
```

```sql
SELECT COUNT(*) AS volume_tier_rows FROM itemprice WHERE priceqty > 1
```

```sql
SELECT id, name FROM pricelevel WHERE isinactive='F' ORDER BY id
```

Interpret:
- `active_price_levels = 0` or `rows_in_itemprice = 0` → 3.1 = "No, managed outside NetSuite"
- `volume_tier_rows > 0` → tier pricing in use
- Many price levels named after specific customers (Macy's, Costco, Amazon, etc.) → **customer-specific** dominates
- If iTPM custom records exist (`CUSTOMRECORD_ITPM_*`), call out promotional pricing lives there, not in core `itemprice`

#### § 4.1 + 4.4 — SO approval + custom scripts/workflows

```sql
SELECT s.scripttype, s.name, s.scriptid
FROM script s
INNER JOIN scriptdeployment sd ON sd.script = s.id
WHERE s.isinactive='F' AND sd.isdeployed='T' AND sd.recordtype = 'SALESORDER'
ORDER BY s.scripttype, s.name
```

```sql
SELECT name, scriptid, releasestatus
FROM workflow
WHERE isinactive='F'
  AND (UPPER(name) LIKE '%SALES%'
       OR UPPER(name) LIKE '%APPROVAL%'
       OR UPPER(name) LIKE '%RESERV%')
```

Interpret:
- 4.1: approval workflow with status RELEASED whose name mentions "approval" / "reservation" / "credit hold" → "Yes — approval gating in place"
- 4.4: list every active script/workflow on SALESORDER. Flag customer-specific ones (named after the customer) separately from standard bundles (iTPM, Avalara, Celigo, SCM, Braintree).

Approver thresholds are a **Needs interview** topic — workflow XML can have them but they're hard to extract programmatically.

#### § 4.2 — Shipping location assignment

```sql
SELECT location, COUNT(*) AS line_cnt
FROM transactionline
WHERE transaction IN (
    SELECT id FROM transaction
    WHERE type='SalesOrd' AND trandate >= TO_DATE('<recent_date>','YYYY-MM-DD')
)
AND location IS NOT NULL
GROUP BY location
```

```sql
SELECT id, name, makeinventoryavailable, isinactive
FROM location
WHERE id IN (<top_location_ids_from_above>)
```

Interpret: distribution shows whether one warehouse dominates (default-location pattern) or it's split across many (item-availability or script-driven). If you see a `customscript_*shipcalc*` or similar in the §4.4 SALESORDER scripts → script-driven assignment.

#### § 4.3 — Custom fields on the SO form

```sql
SELECT scriptid, name, fieldvaluetype
FROM customfield
WHERE LOWER(scriptid) LIKE 'custbody%'
ORDER BY scriptid
```

Save full list as `custbody_fields.json`. Group by domain (EDI, billing, tax, payment, approval, fulfillment routing). **Which of these are *required* on the SO form is Needs interview** — `customfield.ismandatory` reflects the field-level setting, but field visibility per form is a separate concept stored in form definitions.

#### § 5.1 + 5.2 + 5.3 — Warehousing

```sql
SELECT id, name, makeinventoryavailable, isinactive
FROM location
WHERE isinactive='F'
ORDER BY name
```

Interpret naming patterns. Locations whose names contain "CastleGate" / "Flexport" / "Amazon FBA" / "Walmart Fulfillment" / "Shopify" → **3PL or marketplace-fulfilled**. "Warehouse" / a city name + "Warehouse" → likely **own**. Phantom locations (named "Build to Order", "Factory PO", "DropShip") → not real warehouses, used for routing logic.

For 5.3, also probe item field naming for WMS prefix:

```sql
SELECT scriptid, name FROM customfield
WHERE LOWER(scriptid) LIKE 'custitem%'
  AND (LOWER(name) LIKE '%manhattan%'
       OR LOWER(name) LIKE '%blujay%'
       OR LOWER(name) LIKE '%korber%'
       OR LOWER(name) LIKE '%highjump%')
```

Manhattan-prefixed fields → **Manhattan Active WMS in use** (very common for high-volume CPG / wholesale). BluJay / Körber / HighJump similar. No matches → either NetSuite-native WMS (check for the WMS feature) or no formal WMS.

#### § 5.5 — Lot / serial

```sql
SELECT
    SUM(CASE WHEN itemtype='LotNumberedInvtItem' OR itemtype='LotNumberedAssemblyItem' THEN 1 ELSE 0 END) AS lot_tracked,
    SUM(CASE WHEN itemtype='SerializedInvtItem' OR itemtype='SerializedAssemblyItem' THEN 1 ELSE 0 END) AS serial_tracked
FROM item
```

Both zero → **Neither in NetSuite** (often despite Auto Lot Numbering bundle being installed — lot tracking lives in the WMS). Non-zero counts → confirm tracking type.

#### § 5.6 — Bin locations

```sql
SELECT COUNT(*) AS bins, COUNT(DISTINCT location) AS locations_with_bins
FROM bin
WHERE isinactive='F'
```

```sql
SELECT id, location, binnumber FROM bin WHERE isinactive='F'
```

Interpret: large bin count (thousands) → real pick paths in NetSuite (uncommon when a 3rd-party WMS is in use). Small count (under 50) → likely **status-only buckets** (HOLD AVAIL, QA HOLD, RETURNS, etc.), not real picking. Real bin operations live in the WMS.

#### § 5.7 — Item Fulfillment scripts

```sql
SELECT s.scripttype, s.name, s.scriptid
FROM script s
INNER JOIN scriptdeployment sd ON sd.script = s.id
WHERE s.isinactive='F' AND sd.isdeployed='T' AND sd.recordtype = 'ITEMFULFILLMENT'
ORDER BY s.scripttype, s.name
```

Look for: BOL generation, Celigo realtime exports (marketplace shipment confirmations), customer-specific auto-invoicing UE scripts.

#### § 6.1 — Auto-invoicing

Look at IF + Invoice scripts (above + below). A user-event script on ITEMFULFILLMENT named like `*autoinv*` / `*auto-invoice*` → auto-invoicing on IF. Plus check the customer-side flag:

```sql
SELECT COUNT(*) AS auto_invoice_customers
FROM customer
WHERE isinactive='F'
  AND (custentity_<customer-prefix>_autoinv = 'T'
       OR custentity_orderful_auto_invoice = 'T')
```

(Replace `<customer-prefix>` with the customer's MHI/XYZ prefix discovered from §2.2.)

```sql
SELECT s.scripttype, s.name, s.scriptid
FROM script s
INNER JOIN scriptdeployment sd ON sd.script = s.id
WHERE s.isinactive='F' AND sd.isdeployed='T' AND sd.recordtype = 'INVOICE'
ORDER BY s.scripttype, s.name
```

#### § 6.2 — Invoice delivery

```sql
SELECT scriptid, name FROM customfield
WHERE LOWER(scriptid) LIKE 'custentity%'
  AND name LIKE '%EDI%'
ORDER BY scriptid
```

Look for: `EDI 810 On Invoice Create (automatic)` flag, EDI 880 (grocery invoice) flag, manual-generate buttons. Count enabled customers:

```sql
SELECT COUNT(*) AS edi_810_auto
FROM customer
WHERE isinactive='F'
  AND custentity_<customer-prefix>_edi_810_on_invoice_create = 'T'
```

Also check for a customer-side "Invoicing Email" entity field — presence indicates email-PDF delivery is also in use. Common pattern: **Both EDI 810 + Emailed PDF**, depending on the customer.

### Step 3 — Compose the findings file

Output everything to `~/orderful-onboarding/<slug>/o2c_discovery_answers.md` with this structure:

- Header noting source NS account ID + query date
- One section per questionnaire section (1 through 6)
- For each question: the answer + the supporting numbers
- Final "Summary stats" table with key counts
- Final "Open items needing interview" list (the explicit `Needs interview` items)

Format expectations:
- Numbers are concrete (e.g., "1,443 active customers", not "many")
- Quote exact field scriptids when relevant
- Cite the connector source where the questionnaire intersects with what the SuiteApp expects

### Step 4 — Hand off

Show the user:
- Path to the findings file
- The "Open items needing interview" list — these are the questions to bring to the discovery call
- A one-line summary: e.g., *"Multi-subsidiary OneWorld; ship-to-address customer model; Manhattan WMS; ~70% of customers on Auto Invoice; EDI 810 enabled for 88 customers."*

## Behaviour rules

1. **Output findings progressively.** As each section completes, post a finding to the user — they want to monitor progress, not get a wall of text at the end.
2. **Never invent data.** If a query returns zero rows or the data doesn't support a definitive answer, say "no data" / "needs interview" instead of guessing.
3. **Don't paraphrase question wording.** When you save the findings file, copy the questionnaire section headers verbatim so reviewers can match findings to questions 1:1.
4. **Quote exact scriptids.** When mentioning custom fields, scripts, or workflows, use the actual scriptid (e.g., `custscript_mhi_meyer_so_approval_ue`), not a paraphrased name. The contractor will need to find these later.
5. **Flag interview-only questions explicitly.** Don't try to answer 4.1 approver thresholds or 5.4 process narratives from data alone — the result will be wrong. Add them to the Open Items list.
6. **Don't run mutating queries.** This skill is read-only. SuiteQL is naturally read-only, but be careful: if you find yourself wanting to *fix* something the discovery surfaced, that's a separate skill / separate session.
7. **Don't bundle unrelated discovery.** Stay scoped to O2C. P2P (procurement), inventory replenishment, returns flow are out of scope for this skill — flag them and stop, don't expand.
8. **Save raw query outputs alongside the findings.** Reviewers will sometimes want to see `customfield.json` or the raw `pricelevel` list. Drop them next to `o2c_discovery_answers.md` so they're auditable.

## Reference material

- `samples/list-edi-customers.mjs` — TBA OAuth 1.0a SuiteQL signing pattern
- `skills/netsuite-setup/test-connections.mjs` — credential plumbing
- Reference doc: `reference/record-types.md` — Orderful's custom record schemas (often overlap with what this skill discovers)
