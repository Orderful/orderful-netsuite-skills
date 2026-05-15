#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.

// Bill one or more Sales Orders into Invoices via NS's SO→Invoice transform endpoint,
// then set the Orderful outbound-trigger flag on each Invoice. Polls until the SuiteApp
// MR has cleared the flags, then prints the resulting outbound 810 transaction state.
//
// Usage:
//   node bill-and-fire-810.mjs <slug> <soId> [<soId>...] [--trandate=YYYY-MM-DD]

import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const soIds = args.filter((a) => /^\d+$/.test(a)).map(Number);
const tranDateFlag = args.find((a) => a.startsWith('--trandate='));
const tranDate = tranDateFlag ? tranDateFlag.split('=')[1] : null;

if (!slug || !soIds.length) {
  console.error('Usage: node bill-and-fire-810.mjs <slug> <soId> [<soId>...] [--trandate=YYYY-MM-DD]');
  process.exit(1);
}

const envPath = resolve(process.env.HOME, 'orderful-onboarding', slug, '.env');
if (!existsSync(envPath)) {
  console.error(`No .env at ${envPath}. Run /netsuite-setup for ${slug} first.`);
  process.exit(1);
}
loadEnv({ path: envPath });

const env = (process.env.ENVIRONMENT || 'SB').toUpperCase();
const prefix = env === 'PROD' ? 'NS_PROD' : 'NS_SB';
const accountId = process.env[`${prefix}_ACCOUNT_ID`];
const consumerKey = process.env[`${prefix}_CONSUMER_KEY`];
const consumerSecret = process.env[`${prefix}_CONSUMER_SECRET`];
const tokenId = process.env[`${prefix}_TOKEN_ID`];
const tokenSecret = process.env[`${prefix}_TOKEN_SECRET`];
if (!accountId || !consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
  console.error(`Missing ${prefix}_* TBA credentials in ${envPath}.`);
  process.exit(1);
}
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const baseUrl = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest`;
const oauth = new OAuth({
  consumer: { key: consumerKey, secret: consumerSecret },
  signature_method: 'HMAC-SHA256',
  hash_function: (b, k) => crypto.createHmac('sha256', k).update(b).digest('base64'),
});
const token = { key: tokenId, secret: tokenSecret };

async function rest(method, path, body) {
  const url = `${baseUrl}${path}`;
  const auth = oauth.toHeader(oauth.authorize({ url, method }, token));
  auth.Authorization += `, realm="${accountId}"`;
  const r = await fetch(url, {
    method,
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed, headers: Object.fromEntries(r.headers) };
}

async function suiteQL(q) {
  const url = `${baseUrl}/query/v1/suiteql?limit=1000`;
  const auth = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  auth.Authorization += `, realm="${accountId}"`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q }),
  });
  return r.json();
}

console.log(`=== Step 1: confirm SO eligibility (${soIds.length} SOs) ===\n`);
const soList = soIds.join(', ');
const soStatus = await suiteQL(
  `SELECT id, tranid, BUILTIN.DF(status) AS status FROM transaction WHERE id IN (${soList}) AND type = 'SalesOrd'`
);
const ineligible = (soStatus.items || []).filter((s) => !/Pending Billing/i.test(s.status));
if (soStatus.items?.length !== soIds.length) {
  console.error(`Found ${soStatus.items?.length || 0} of ${soIds.length} SOs. Some IDs are wrong or not SOs.`);
  process.exit(1);
}
if (ineligible.length) {
  console.error('SOs not in Pending Billing — cannot bill:');
  for (const s of ineligible) console.error(`  ${s.id} (${s.tranid}): ${s.status}`);
  process.exit(1);
}
for (const s of soStatus.items) console.log(`  ${s.id} (${s.tranid}): ${s.status} ✓`);

console.log(`\n=== Step 2: transform each SO → Invoice ===\n`);
const invoiceIds = [];
for (const soId of soIds) {
  const body = tranDate ? { tranDate } : null;
  const res = await rest('POST', `/record/v1/salesOrder/${soId}/!transform/invoice`, body);
  if (res.status >= 400) {
    console.error(`  SO ${soId}: HTTP ${res.status} — ${JSON.stringify(res.body).slice(0, 300)}`);
    process.exit(1);
  }
  const loc = res.headers.location || '';
  const invId = Number(loc.split('/').pop());
  invoiceIds.push({ soId, invoiceId: invId });
  console.log(`  SO ${soId} → Invoice ${invId}`);
}

console.log(`\n=== Step 3: verify each Invoice ===\n`);
for (const { soId, invoiceId } of invoiceIds) {
  const inv = await rest('GET', `/record/v1/invoice/${invoiceId}`);
  if (inv.status >= 400) {
    console.error(`  Invoice ${invoiceId}: HTTP ${inv.status}`);
    continue;
  }
  console.log(`  Invoice ${invoiceId} (from SO ${soId}):`);
  console.log(`    tranId=${inv.body.tranId}  PO#=${inv.body.otherRefNum}  total=${inv.body.total}`);
  console.log(`    tranDate=${inv.body.tranDate}  shipDate=${inv.body.shipDate}  dueDate=${inv.body.dueDate}`);
  if (inv.body.terms) console.log(`    terms=${inv.body.terms.refName} (id ${inv.body.terms.id})`);
  if (inv.body.shipMethod) console.log(`    shipMethod=${inv.body.shipMethod.refName}`);
}

console.log(`\n=== Step 4: set ready_to_process_inv = true on each Invoice ===\n`);
for (const { invoiceId } of invoiceIds) {
  const r = await rest('PATCH', `/record/v1/invoice/${invoiceId}`, { custbody_orderful_ready_to_process_inv: true });
  console.log(`  Invoice ${invoiceId}: HTTP ${r.status}`);
}

console.log(`\n=== Step 5: poll for MR completion (~30–120s) ===\n`);
const start = Date.now();
const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;
while (true) {
  const flagState = await suiteQL(
    `SELECT id, custbody_orderful_ready_to_process_inv FROM transaction WHERE id IN (${invoiceIds.map((i) => i.invoiceId).join(', ')})`
  );
  const flags = (flagState.items || []).map((i) => i.custbody_orderful_ready_to_process_inv);
  if (flags.every((f) => f === 'F')) {
    console.log(`  MR completed after ${Math.round((Date.now() - start) / 1000)}s`);
    break;
  }
  if (Date.now() - start > TIMEOUT_MS) {
    console.error(`  Timeout waiting for MR (5 min). Current flags: ${flags.join('')}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

console.log(`\n=== Step 6: outbound 810 transaction(s) ===\n`);
const outbound = await suiteQL(
  `SELECT id, custrecord_ord_tran_orderful_id AS ofid, custrecord_ord_tran_status AS status, ` +
    `custrecord_ord_tran_inbound_transaction AS inbound, custrecord_ord_tran_error AS err ` +
    `FROM customrecord_orderful_transaction ` +
    `WHERE custrecord_ord_tran_document = '4' AND custrecord_ord_tran_direction = '2' ` +
    `AND custrecord_ord_tran_inbound_transaction IN (${invoiceIds.map((i) => i.invoiceId).join(', ')}) ` +
    `ORDER BY id DESC`
);
for (const t of outbound.items || []) {
  console.log(`  NS ${t.id}  ofId=${t.ofid}  status=${t.status}  fromInvoice=${t.inbound}`);
  if (t.err) console.log(`    err: ${(t.err || '').slice(0, 150)}`);
}

console.log(`\nNext steps:`);
console.log(`  • Inspect outbound state on Orderful: https://ui.orderful.com/transactions/<ofId>`);
console.log(`  • If INVALID, run /fetch-validations <ofId> for structured errors.`);
console.log(`  • If JSONata is needed, route to /writing-outbound-jsonata for the 810 ECT.`);
