#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Rank a NetSuite customer's most-commonly-sold products and upload them to
// Orderful's product catalog (POST /v2/products), with optional enrichment
// (PATCH /v2/products/{id}). See SKILL.md for end-to-end usage and the
// reverse-engineered /v2/products contract.
//
// Usage:
//   node upload-products.mjs <customer-dir> [flags]
//
// Flags:
//   --top N            How many top products (default 25).
//   --metric M         Rank by "invoices" (default; COUNT(DISTINCT invoice))
//                      or "units" (SUM of quantity sold).
//   --dry-run          Print the plan; make NO writes to Orderful.
//   --rank-only        Only print the NetSuite ranking; don't touch Orderful.
//   --enrich           Also PATCH stable attributes: unitCost, weight + unit, UPC.
//   --quantities       Also PATCH a one-time inventory snapshot (available/committed).
//                      WARNING: a point-in-time value that goes stale immediately.
//   --scenario-top N   Set isForScenarioTesting=true on the top N (default 0).
//   --edi-account ID   Override the resolved ediAccountId (see resolution below).
//
// Credentials all come from <customer-dir>/.env (created by /netsuite-setup):
//   NS_{SB,PROD}_*  picked by ENVIRONMENT;  ORDERFUL_API_KEY;  ORDERFUL_ORG_ID.

import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const API = 'https://api.orderful.com';

// ---------- args ----------
const args = process.argv.slice(2);
const customerDir = args.find((a) => !a.startsWith('--'));
const flag = (name, def = null) => {
  const i = args.indexOf(name);
  return i > -1 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
};
const has = (name) => args.includes(name);

if (!customerDir) {
  console.error('Usage: node upload-products.mjs <customer-dir> [--top N] [--metric invoices|units] [--dry-run] [--rank-only] [--enrich] [--quantities] [--scenario-top N]');
  process.exit(2);
}
const TOP = Number(flag('--top', 25));
const METRIC = String(flag('--metric', 'invoices'));
const SCENARIO_TOP = Number(flag('--scenario-top', 0));
const DRY = has('--dry-run');
const RANK_ONLY = has('--rank-only');
const ENRICH = has('--enrich');
const QUANTITIES = has('--quantities');
if (!['invoices', 'units'].includes(METRIC)) { console.error(`--metric must be "invoices" or "units"`); process.exit(2); }

// ---------- env ----------
const envPath = resolve(customerDir, '.env');
if (!existsSync(envPath)) { console.error(`No .env at ${envPath} — run /netsuite-setup first.`); process.exit(2); }
loadEnv({ path: envPath, quiet: true });

const envMode = (process.env.ENVIRONMENT || 'sandbox').toLowerCase();
const nsPrefix = envMode === 'production' ? 'NS_PROD' : 'NS_SB';
const PLACEHOLDER = /^<\s*paste\s*here\s*>$/i;
const need = [`${nsPrefix}_ACCOUNT_ID`, `${nsPrefix}_CONSUMER_KEY`, `${nsPrefix}_CONSUMER_SECRET`, `${nsPrefix}_TOKEN_ID`, `${nsPrefix}_TOKEN_SECRET`, 'ORDERFUL_API_KEY'];
const missing = need.filter((k) => { const v = process.env[k]; return !v || !v.trim() || PLACEHOLDER.test(v.trim()); });
if (missing.length) { console.error(`Missing/unfilled in .env (ENVIRONMENT=${envMode}):\n  - ${missing.join('\n  - ')}`); process.exit(2); }

const KEY = process.env.ORDERFUL_API_KEY;
const ofHeaders = { 'orderful-api-key': KEY, 'Content-Type': 'application/json' };

// ---------- NetSuite SuiteQL (TBA) ----------
const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
const nsUrl = `https://${accountId.replace(/_/g, '-').toLowerCase()}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
const oauth = new OAuth({
  consumer: { key: process.env[`${nsPrefix}_CONSUMER_KEY`], secret: process.env[`${nsPrefix}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (s, k) => crypto.createHmac('sha256', k).update(s).digest('base64'),
});
const nsToken = { key: process.env[`${nsPrefix}_TOKEN_ID`], secret: process.env[`${nsPrefix}_TOKEN_SECRET`] };
async function suiteql(sql) {
  const auth = oauth.toHeader(oauth.authorize({ url: nsUrl, method: 'POST' }, nsToken));
  auth.Authorization += `, realm="${accountId}"`;
  const res = await fetch(nsUrl, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'transient' }, body: JSON.stringify({ q: sql }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`SuiteQL HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).items ?? [];
}
const inList = (vals) => vals.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');

// ---------- 1. rank most-commonly-sold products ----------
// Sold = customer-invoice lines. mainline='F' drops the summary line; isinactive='F'
// drops NetSuite's deprecated assembly-component duplicate SKUs (often "<sku>-A"),
// and the itemtype filter excludes non-product lines (shipping, tax, "Misc Sale",
// "AR Opening Balance", discounts, etc.).
const order = METRIC === 'units' ? 'SUM(ABS(tl.quantity))' : 'COUNT(DISTINCT tl.transaction)';
const ranked = await suiteql(`
  SELECT i.id AS item_id, i.itemid AS sku, i.displayname AS name, i.itemtype AS itemtype,
         COUNT(DISTINCT tl.transaction) AS invoices, SUM(ABS(tl.quantity)) AS units
  FROM transactionline tl
  JOIN transaction t ON t.id = tl.transaction
  JOIN item i ON i.id = tl.item
  WHERE t.type = 'CustInvc' AND tl.mainline = 'F' AND i.isinactive = 'F'
        AND i.itemtype IN ('InvtPart','Assembly','Kit')
  GROUP BY i.id, i.itemid, i.displayname, i.itemtype
  ORDER BY ${order} DESC
  FETCH FIRST ${TOP} ROWS ONLY`);

console.log(`Top ${ranked.length} products for ${process.env.CUSTOMER_NAME || customerDir} (ENVIRONMENT=${envMode}, metric=${METRIC}):`);
ranked.forEach((r, n) => console.log(`  ${String(n + 1).padStart(2)}  ${String(r.sku).padEnd(18)} inv=${String(r.invoices).padStart(5)} units=${String(r.units).padStart(7)}  ${(r.name || '').slice(0, 46)}`));
if (RANK_ONLY) process.exit(0);

// ---------- 2. pull enrichment attributes (only if needed) ----------
const attrs = new Map();   // sku -> { averagecost, lastpurchaseprice, weight, wunit, upccode }
const inv = new Map();     // sku -> { onhand, available }
if (ENRICH || QUANTITIES) {
  const ids = ranked.map((r) => r.item_id);
  if (ENRICH) {
    for (const r of await suiteql(`SELECT i.id, i.itemid AS sku, i.averagecost, i.lastpurchaseprice, i.weight, BUILTIN.DF(i.weightunit) AS wunit, i.upccode FROM item i WHERE i.id IN (${inList(ids)})`)) {
      attrs.set(r.sku, r);
    }
  }
  if (QUANTITIES) {
    for (const r of await suiteql(`SELECT i.itemid AS sku, SUM(ib.quantityonhand) AS onhand, SUM(ib.quantityavailable) AS available FROM item i LEFT JOIN inventorybalance ib ON ib.item = i.id WHERE i.id IN (${inList(ids)}) GROUP BY i.itemid`)) {
      inv.set(r.sku, r);
    }
  }
}

// ---------- 3. resolve ediAccountId (NOT the org id!) ----------
// A product's ediAccountId is sender.ediAccountId on a relationship where
// sender.organizationId == this org. It is a DIFFERENT integer from the org id.
async function resolveEdiAccountId() {
  if (flag('--edi-account')) return Number(flag('--edi-account'));
  const orgId = Number(process.env.ORDERFUL_ORG_ID);
  if (!orgId) throw new Error('ORDERFUL_ORG_ID not set in .env and no --edi-account override given.');
  let url = `${API}/v3/relationships`; // relationships is a v3 endpoint (products is v2)
  while (url) {
    const res = await fetch(url, { headers: ofHeaders });
    if (!res.ok) throw new Error(`GET relationships HTTP ${res.status}`);
    const body = await res.json();
    for (const rel of body.data ?? []) {
      for (const side of ['sender', 'receiver']) {
        if (rel[side]?.organizationId === orgId && rel[side]?.ediAccountId) return rel[side].ediAccountId;
      }
    }
    const next = body?.metadata?.pagination?.links?.next;
    url = next ? (next.startsWith('http') ? next : `${API}${next}`) : null;
  }
  throw new Error(`No ediAccountId found for org ${orgId} in /v2/relationships.`);
}
const EDI_ACCOUNT_ID = await resolveEdiAccountId();
console.log(`\nediAccountId = ${EDI_ACCOUNT_ID} (org ${process.env.ORDERFUL_ORG_ID})`);

// ---------- 4. existing catalog (idempotency) ----------
async function existingSkus() {
  const seen = new Map(); // skuId -> product id
  let url = `${API}/v2/products`;
  while (url) {
    const res = await fetch(url, { headers: ofHeaders });
    if (!res.ok) break;
    const body = await res.json();
    for (const p of body.data ?? []) if (p.skuId) seen.set(p.skuId, p.id);
    const next = body?.metadata?.pagination?.links?.next;
    url = next ? (next.startsWith('http') ? next : `${API}${next}`) : null;
  }
  return seen;
}
const idBySku = await existingSkus();

// ---------- enrichment payload builder ----------
const WEIGHT_UNIT = { lb: 'POUNDS', lbs: 'POUNDS', pound: 'POUNDS', pounds: 'POUNDS', oz: 'OUNCES', ounce: 'OUNCES', ounces: 'OUNCES', kg: 'KILOGRAMS', kgs: 'KILOGRAMS', kilogram: 'KILOGRAMS', kilograms: 'KILOGRAMS' };
const money = (v) => { const n = v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null; }; // STRING, exactly 2 decimals
const scenarioSkus = new Set(ranked.slice(0, SCENARIO_TOP).map((r) => r.sku));
function enrichBody(sku) {
  const body = {};
  if (SCENARIO_TOP) body.isForScenarioTesting = scenarioSkus.has(sku);
  if (ENRICH) {
    const a = attrs.get(sku) || {};
    const cost = money(a.averagecost) ?? money(a.lastpurchaseprice);
    if (cost) body.unitCost = cost;
    const w = a.weight == null ? NaN : Number(a.weight);
    const unit = WEIGHT_UNIT[String(a.wunit || '').toLowerCase()];
    if (Number.isFinite(w) && w > 0 && unit) { body.weight = w; body.weightUnitMeasure = unit; }
    // uniqueIdentifiers is an OBJECT {gtin12,gtin13,gtin14,upc} — NOT an array.
    // NetSuite upccode is a 12-digit UPC-A -> the `upc` field (UI "EAN/UPC").
    if (a.upccode) body.uniqueIdentifiers = { upc: String(a.upccode) };
  }
  if (QUANTITIES) {
    const q = inv.get(sku) || {};
    const oh = Number(q.onhand) || 0, av = Number(q.available) || 0;
    body.quantityAvailable = av;
    body.quantityCommitted = Math.max(0, oh - av);
    body.quantityUnitOfMeasure = 'EA'; // must match /^[A-Z0-9]{2}$/
  }
  return body;
}

// ---------- 5. plan / dry-run ----------
const toCreate = ranked.filter((r) => !idBySku.has(r.sku));
const toSkip = ranked.filter((r) => idBySku.has(r.sku));
console.log(`\nPlan: create ${toCreate.length}, skip ${toSkip.length} already in catalog${(ENRICH || QUANTITIES || SCENARIO_TOP) ? `, then enrich ${ranked.length}` : ''}.`);
if (DRY) {
  for (const r of ranked) {
    const body = { name: r.name || r.sku, skuId: r.sku, ediAccountId: EDI_ACCOUNT_ID, ...enrichBody(r.sku) };
    console.log(`  [dry] ${idBySku.has(r.sku) ? 'PATCH ' : 'CREATE'} ${r.sku.padEnd(18)} ${JSON.stringify(body)}`);
  }
  process.exit(0);
}

// ---------- 6. create ----------
const result = { created: 0, skipped: toSkip.length, enriched: 0, failed: [] };
for (const r of toCreate) {
  const res = await fetch(`${API}/v2/products`, { method: 'POST', headers: ofHeaders, body: JSON.stringify({ name: r.name || r.sku, skuId: r.sku, ediAccountId: EDI_ACCOUNT_ID }) });
  const text = await res.text();
  if (res.ok) { const p = JSON.parse(text); idBySku.set(r.sku, p.id ?? p?.data?.id); result.created++; console.log(`CREATE ${r.sku.padEnd(18)} -> id ${idBySku.get(r.sku)}`); }
  else { result.failed.push({ sku: r.sku, op: 'create', status: res.status, body: text.slice(0, 200) }); console.log(`FAIL   ${r.sku} (create) HTTP ${res.status} ${text.slice(0, 150)}`); if (res.status === 401 || res.status === 403) break; }
}

// ---------- 7. enrich ----------
if (ENRICH || QUANTITIES || SCENARIO_TOP) {
  for (const r of ranked) {
    const id = idBySku.get(r.sku);
    if (!id) continue;
    const body = enrichBody(r.sku);
    if (!Object.keys(body).length) continue;
    const res = await fetch(`${API}/v2/products/${id}`, { method: 'PATCH', headers: ofHeaders, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.ok) { result.enriched++; console.log(`PATCH  ${r.sku.padEnd(18)} ${JSON.stringify(body)}`); }
    else { result.failed.push({ sku: r.sku, op: 'enrich', status: res.status, body: text.slice(0, 200) }); console.log(`FAIL   ${r.sku} (enrich) HTTP ${res.status} ${text.slice(0, 150)}`); }
  }
}

console.log(`\n=== created: ${result.created}  skipped: ${result.skipped}  enriched: ${result.enriched}  failed: ${result.failed.length} ===`);
if (result.failed.length) { console.log(JSON.stringify(result.failed, null, 2)); process.exit(1); }
