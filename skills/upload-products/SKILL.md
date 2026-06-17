---
name: upload-products
description: Rank a NetSuite customer's most-commonly-sold products and upload them to Orderful's product catalog via the v2 products API, optionally enriching each with unit cost, weight, UPC, and inventory. Use when the user says "upload <customer>'s products to Orderful", "find the top products and add them to the catalog", "sync the product catalog", "populate Orderful products from NetSuite", "/upload-products", "load <customer>'s best sellers into Orderful", or wants a customer's SKUs registered in Orderful so they resolve inside EDI transactions.
---

# Upload Products to Orderful

Builds a customer's Orderful product catalog from what they actually sell in NetSuite. Two phases:

1. **Rank** — query NetSuite for the most-commonly-sold products (by how many customer invoices each appears on, or by total units), filtered to real, active, sellable items.
2. **Upload** — `POST` each to Orderful's `/v2/products`, then optionally `PATCH` enrichment (unit cost, weight, UPC, a one-time inventory snapshot, and the scenario-testing flag).

The catalog tells Orderful which SKUs the customer owns so they can be matched inside inbound/outbound transactions (LIN/PO1 product identifiers). The script `upload-products.mjs` does the whole flow from a customer's `.env`.

## When to use this skill

- "upload acme-foods' products to Orderful"
- "find Acme's top 25 sellers and add them to the catalog"
- "populate the Orderful product catalog from NetSuite for <customer>"
- "sync <customer>'s products / best sellers into Orderful"
- "/upload-products"

## Inputs the skill needs

- **Customer slug** — which `~/orderful-onboarding/<slug>/` to use. Ask if unspecified; list the dirs. The `.env` (from `/netsuite-setup`) supplies NS credentials, `ORDERFUL_API_KEY`, and `ORDERFUL_ORG_ID`.
- **How many** — top-N cut (default 25). "Most commonly sold" has no fixed cutoff; confirm with the user.
- **Metric** — `invoices` (default, = appears on the most invoices) or `units` (total quantity sold). They rank differently: high-volume small items jump up under `units`.
- **Enrichment scope** — whether to also push unit cost / weight / UPC (`--enrich`), an inventory snapshot (`--quantities`), and how many top items to flag for scenario testing (`--scenario-top`).

## The recipe

### Step 1 — Pick the customer and preview the ranking

```sh
node <path-to-this-skill>/upload-products.mjs ~/orderful-onboarding/<slug> --rank-only --top 30
```

`--rank-only` runs the NetSuite query and prints the ranking without touching Orderful. Show it to the user and confirm the **count** and **metric** before any write. Add `--metric units` to rank by quantity instead of invoice frequency.

### Step 2 — Dry-run the upload

```sh
node <path-to-this-skill>/upload-products.mjs ~/orderful-onboarding/<slug> --top 25 --enrich --scenario-top 5 --dry-run
```

Prints the exact create/patch payloads, the resolved `ediAccountId`, and what already exists in the catalog — but makes **no** writes. Review the payloads (especially that `ediAccountId` looks like an EDI-account integer, not the org id — see contract below).

### Step 3 — Run it

Drop `--dry-run`:

```sh
node <path-to-this-skill>/upload-products.mjs ~/orderful-onboarding/<slug> --top 25 --enrich --scenario-top 5
```

Creates are idempotent — the script reads the existing catalog and skips SKUs already present, so re-running to add more or to re-apply enrichment is safe. Append `--quantities` to also push a one-time available/committed snapshot (see rule 5 — it goes stale immediately).

### Step 4 — Verify

The script echoes each created id and each patched body, then a summary line. Spot-check in the Orderful UI (Order Fulfillment → Products) or `GET /v2/products`.

## The /v2/products contract

Base `https://api.orderful.com`, header `orderful-api-key: <key>`. The API validates strictly and rejects unknown properties ("property X should not exist"), which makes it self-documenting — see rule 7.

**Create** — `POST /v2/products`
- Required: `name` (string), `skuId` (string), `ediAccountId` (integer).
- Optional: `description` (string) and every enrichment field below.

**Update** — `PATCH /v2/products/{id}` (partial; `GET/HEAD/PUT/PATCH/POST/DELETE` are all allowed).

**`ediAccountId` is NOT the org id.** This is the easy way to corrupt the upload. It's `sender.ediAccountId` from `GET /v3/relationships` (note: relationships is a v3 endpoint, products is v2) where `sender.organizationId == ORDERFUL_ORG_ID` — a different integer from the org id. Example: org `7654321` → ediAccountId `7777777`. The script resolves it from relationships automatically; override with `--edi-account <id>`.

**Enrichment fields and their constraints:**

| Field | Type / rule | NetSuite source |
|---|---|---|
| `unitCost`, `manufacturerSuggestedRetailPrice` | **String**, regex `^(0\|[1-9]\d*)\.\d{2}$` — exactly 2 decimals (`"176.03"`; the number `176.0` is rejected) | `unitCost` ← item `averagecost`, fallback `lastpurchaseprice`. No standard source for MSRP. |
| `weight` | number | item `weight` |
| `weightUnitMeasure` | enum: `KILOGRAMS`, `OUNCES`, `POUNDS` | item `weightunit` (`lb`→`POUNDS`) |
| `length` / `width` / `height` | number | usually unmaintained in NetSuite |
| `dimensionUnitMeasure` | enum: `CENTIMETERS`, `INCHES`, `METERS` | — |
| `quantityAvailable` / `quantityCommitted` / `quantityUnsellable` | number | `inventorybalance` aggregate (committed ≈ `SUM(onhand) − SUM(available)`) |
| `quantityUnitOfMeasure` | regex `^[A-Z0-9]{2}$` (use `EA`) | — |
| `uniqueIdentifiers` | **object** `{ gtin12, gtin13, gtin14, upc }` — see below | `upc` ← item `upccode` (12-digit UPC-A) |
| `isForScenarioTesting` | boolean — includes the SKU in sample/test transactions | — |

**`uniqueIdentifiers` is an object, not an array.** The UI "Product Identifiers" section (GTIN-12/13/14, EAN/UPC) maps to one object: `{"upc": "036000291452"}`. Sending an *array* like `[{"upc": "..."}]` passes request validation but then 500s on persistence with the opaque `{"message":"An unexpected error occurred"}` — that error means wrong shape, not a server bug. The per-product UI toggle only shows/hides the section; supplying the object via the API enables it (there is no separate enable flag). A 12-digit `upccode` is a UPC-A → put it in `upc`.

## Behaviour rules

1. **Always preview the ranking and dry-run before writing.** Catalog writes hit the customer's live Orderful org. Confirm count + metric with the user, then `--dry-run`, then run for real. Never go straight to a live write.
2. **Resolve `ediAccountId` from relationships — never pass the org id.** The script does this; if you hand-build a call, do not use `ORDERFUL_ORG_ID` as `ediAccountId`.
3. **Filter to real, active, sellable items.** The ranking query uses `isinactive='F'` (drops NetSuite's deprecated `-A` assembly-component duplicate SKUs) and `itemtype IN ('InvtPart','Assembly','Kit')` (drops shipping/tax/discount lines and generic catch-alls like "Misc Sale" / "AR Opening Balance"). Don't loosen these without a reason.
4. **`unitCost` / MSRP must be 2-decimal strings.** `Number(x).toFixed(2)`. A bare number or `"12.5"` is rejected by the regex.
5. **Inventory quantities are a stale snapshot — opt-in only.** `--quantities` pushes a point-in-time value that does not update as stock moves (this isn't a live feed). Tell the user that before using it; prefer leaving quantities off unless they explicitly want the snapshot.
6. **Don't fabricate data Orderful asks for but NetSuite doesn't have.** MSRP, dimensions, and pack quantities have no standard NetSuite item source — leave them blank rather than guessing.
7. **Reverse-engineer the schema by probing, not by guessing in the dark.** The validator is strict and descriptive. To learn an unknown field/shape, `POST` with a required field (e.g. `name`) omitted so the request 400s and creates nothing — the response enumerates invalid properties ("should not exist") and returns enum/regex constraints. Never probe by sending a valid body you don't intend to persist.
8. **Don't paste the API key or TBA secrets into chat.** They stay in the `.env`; the script reads them locally.
9. **One customer per invocation.** Each customer's credentials are per-account; no batch mode across customers.

## Reference material

- `samples/list-edi-customers.mjs` — the TBA OAuth 1.0a SuiteQL signing pattern this script reuses
- `skills/netsuite-setup/SKILL.md` — creates the customer `.env` (NS credentials, `ORDERFUL_API_KEY`, `ORDERFUL_ORG_ID`)
- `skills/o2c-discovery/SKILL.md` — related read-only SuiteQL recon over the same item/transaction tables
- Orderful product identifiers (UPC / GTIN concepts): [docs.orderful.com](https://docs.orderful.com)
