---
name: partner-packing-slip
description: Build a retailer-mandated packing slip as a NetSuite Advanced PDF/HTML template for an Orderful EDI customer, including landing the EDI elements the retailer requires onto the Sales Order via inbound JSONata. Use when a retailer (HD Supply, Lowe's, Home Depot, or any Rithum/CommerceHub or SPS drop-ship program) sends a "Packing Slip Guide" the supplier must match, or the user says "can our packing slips be customized", "build the packing slip for <retailer>", "the retailer rejected our packing slip format", "/partner-packing-slip", or asks why a required field is blank on a printed slip.
---

# Partner Packing Slip

Drop-ship retailers publish a packing slip specification the supplier must reproduce exactly, then approve sample slips before the supplier may use them in production. This skill covers producing one from NetSuite.

**The trap this skill exists to prevent:** the layout is almost never the hard part. These specs call for 15–20 variable elements, and most of them arrive in the EDI purchase order and are **discarded on ingest** — they never reach the Sales Order, so no template can print them. Check data availability *before* touching a template, or you will build a beautiful slip full of blanks.

## When to use this skill

- "Can our packing slips be customized?"
- "Build the HD Supply packing slip for this customer"
- "The retailer says our packing slip is missing the order number"
- "Why is the PART # column blank on the packing slip?"
- "/partner-packing-slip"

## Inputs the skill needs

- **Customer slug** — which `~/orderful-onboarding/<slug>/` to use.
- **The retailer's packing slip guide** (PDF). These ship with a data-element table mapping each printed field to an EDI position — that table is the whole job.
- **Which retailer/customer record** the slip applies to. Ask; do not infer from the trading partner name, since one supplier often has two records for the same retailer (a legacy VAN lane and a new portal lane).

## The recipe

### Step 1 — Build the element table before anything else

From the guide's data-element table, list every element with its EDI position. Then, for a real inbound purchase order for that customer, check each one in three places:

1. **Is it in the EDI?** Pull the message: `node _diag/of_get.mjs "/v3/transactions/<id>/message"`.
2. **Does the SuiteApp already land it?** Load a natively-created Sales Order and look for it. Several elements are already populated for free and must not be duplicated — check `custbody_orderful_edi_po_date` (EDI order date), `custcol_orderful_units` (EDI UOM), `custcol_orderful_line_ref` (PO line #), and `custcol_orderful_item_identification` (the PO1 item-ID pairs, as a JSON blob).
3. **Is there an existing field that is shipped but never populated?** `custbody_orderful_cust_order_num` is the common one — it exists for exactly this purpose and is usually empty.

Only what survives all three checks needs a new custom field.

### Step 2 — Create the missing custom fields via SDF

Body fields are `transactionbodycustomfield` with `<bodysale>T</bodysale>`; line fields are `transactioncolumncustomfield` with `<colsale>T</colsale>`. Use a customer-specific prefix, not `custbody_orderful_*` / `custcol_orderful_*`, so a future SuiteApp release cannot collide with them.

`object:import` of an existing field returns every `body*` / `col*` flag. Delete the ones set to `F` before deploying — each unused flag drags in a feature dependency and produces a "field depends on the X feature" validation warning.

### Step 3 — Map them from the EDI with inbound JSONata

Set header values in `transaction.userDefinedFields` and per-line values in each `transactionLines[i].userDefinedFields`. Per-line `userDefinedFields` requires SuiteApp **v1.22.4+**; on older accounts use the line-mapping bridge in [`writing-inbound-jsonata`](../writing-inbound-jsonata/SKILL.md).

Match EDI lines to Sales Order lines on the PO line number (`assignedIdentification`, coerced with `$string()`), with a positional fallback — line order is usually but not always preserved through item lookup and order splitting.

Dry-run locally before deploying. Evaluate the expression with the `jsonata` npm package against a captured `custrecord_ord_tran_message`, passing the same bindings the engine uses. Exercise at minimum: exact match, out-of-order lines, missing match key, and a line count greater than one.

### Step 4 — Build the template

Copy the retailer's static text verbatim — phone numbers, returns policy, the "thank you" banner. These are fixed elements and the retailer checks them.

Many guides require a **second page** the supplier keeps out of the box (HD Supply calls it a Vendor Order Supplement). Emit it with `<pbr />` and repeat the header.

### Step 5 — Render it programmatically to verify

Do not eyeball the template or ask the user to print it. Deploy `assets/orderful_renderPackingSlip_RL.js` and drive it with `render-packing-slip.mjs` to get a real PDF locally, then read the PDF.

```sh
node skills/partner-packing-slip/render-packing-slip.mjs <customer-slug> <fulfillmentId> <templateId> out.pdf
```

Iterate template → deploy → render → read until every element is populated.

### Step 6 — Scope it to the right customer, safely

**Check which form the fulfillments actually use before changing anything:**

```sql
SELECT customform, COUNT(*) FROM transaction WHERE type = 'ItemShip' GROUP BY customform
```

In practice one form serves nearly every fulfillment in the account, across hundreds of customers. That means setting the new template `preferred`, or pointing that form at it, gives **every** customer the retailer's packing slip.

The safe pattern is a branch at the top of the template the form already uses, where each arm emits its own complete `<head>` and `<body>` so the retailer's global CSS cannot leak into anyone else's slip:

```
<#assign isRetailer = (salesorder.entity!"")?contains("<Retailer>") />
<pdf>
<#if isRetailer>
  ... retailer head + body ...
<#else>
  ... previous template content, byte-for-byte ...
</#if>
</pdf>
```

`${salesorder.entity@internalid}` does **not** resolve in a packing-slip context — only the display name does. Say so in a template comment, because a customer rename then silently stops the branch firing.

### Step 7 — Prove the other customers did not change

Render a fulfillment for two unrelated customers before and after, and compare.

**Do not compare PDF bytes or PNG file hashes — both give false positives.** NetSuite PDFs are not byte-deterministic; the same template rendered twice differs across tens of thousands of bytes. Rasterise and compare **decoded pixel data**, and always run a control (same template rendered twice) first to prove the method is stable before trusting a pass:

```sh
node skills/partner-packing-slip/compare-render.mjs before.pdf after.pdf
```

### Step 8 — Hand off the approval path

Most programs require sample slips, produced from named test cases in the retailer's test plan, to be approved through the supplier's onboarding representative before production use. That approval has lead time outside Orderful's control, so start it early and say who owns it.

Guides commonly allow the portal-produced packing slip as a fallback if the supplier cannot meet the spec. Surface that option — it decouples the go-live date from the approval.

## Behaviour rules

1. **Audit data availability before building a template.** If an element is not in the EDI at all, say so and ask the retailer rather than inventing a source.
2. **Never set the new template `preferred`, and never repoint a shared form at it,** until Step 6's form query proves the blast radius. This is the one step in this skill that can break every other customer's printing.
3. **Reuse the SuiteApp's shipped fields before creating new ones.** Duplicating `custbody_orderful_edi_po_date` is a common and avoidable mess.
4. **Verify by rendering, never by reading the template.** Two defects that only appear in a render: `render.create()` binds only the records you pass, so a packing slip template needs `salesorder` bound explicitly or every `salesorder.*` field is blank; and `quantityordered` returns an *empty string* outside NetSuite's own print flow, so `!` defaults never fire — test with `?has_content`.
5. **Pin both width and height on logos.** The PDF engine does not infer aspect ratio from width alone and will distort the retailer's mark.
6. **Use the retailer's own logo file from their portal**, not one found elsewhere. The guide names the file; programs approve against it.
7. **Do not re-run a processed transaction to re-prove a mapping change.** The SuiteApp will not create a second Sales Order for a purchase order that already has one — it logs completion and silently creates nothing. Pick a purchase order with no Sales Order yet.
8. **Strip nothing from the retailer's static text.** Reword nothing. It is checked during approval.

## Known gap — this needs SDF today

Reading and writing an Advanced PDF template, uploading a logo to the File Cabinet, and rendering a PDF all require SDF and a browser OAuth refresh. None are reachable through the SuiteApp's agent RESTlet, and the template source is not in the `file` table (the PDF Templates folder returns zero rows to SuiteQL), so there is no REST fallback.

Until native actions exist, this skill deploys its own render RESTlet per customer — the same route the dataset lab took before it shipped in the SuiteApp.

## Reference material

- [`writing-inbound-jsonata`](../writing-inbound-jsonata/SKILL.md) — `userDefinedFields`, bindings, and the pre-v1.22.4 line bridge
- [`migrate-dataset`](../migrate-dataset/SKILL.md) — SDF project bootstrap and the interactive auth flow
- [`reprocess-transaction`](../reprocess-transaction/SKILL.md) — re-driving an inbound transaction after a mapping change
