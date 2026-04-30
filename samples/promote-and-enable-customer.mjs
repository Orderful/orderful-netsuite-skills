#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Sample: promote a NetSuite customer to an EDI parent and create the Core 4
// Enabled Transaction records (850 inbound, 856 outbound, 810 outbound).
//
// !! This script WRITES to NetSuite. !! Run against a sandbox first, and
// double-check the customer ID and ISA IDs before running against production.
//
// What it does, in order:
//   1. PATCH /record/v1/customer/<id>          — set live + test ISA IDs.
//   2. POST  /record/v1/customrecord_orderful_edi_customer_trans  (×3)
//                                              — one Enabled Transaction per
//                                                Core 4 doc type.
//   3. SuiteQL read-back to verify the writes landed.
//
// Adapt the `enabled` array if you need a different set of doc types, or
// the PATCH payload if the customer needs additional Orderful fields set
// (for example, the subcustomer-rep field on accounts that use stand-in
// EDI parents — a NetSuite list internal ID).
//
// Usage:
//   node samples/promote-and-enable-customer.mjs <env-dir> <customer-id> <live-isa> <test-isa>
//
// Example:
//   node samples/promote-and-enable-customer.mjs ~/orderful-onboarding/acme-co 12345 054677679W 054677679S
//
import { config as loadEnv } from 'dotenv';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';
import { resolve } from 'node:path';

const [, , envDir, customerId, liveIsa, testIsa] = process.argv;
if (!envDir || !customerId || !liveIsa || !testIsa) {
  console.error('Usage: node samples/promote-and-enable-customer.mjs <env-dir> <customer-id> <live-isa> <test-isa>');
  process.exit(1);
}
loadEnv({ path: resolve(envDir, '.env') });

const nsPrefix = (process.env.ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'NS_PROD' : 'NS_SB';
const acct = process.env[`${nsPrefix}_ACCOUNT_ID`];
const host = acct.replace(/_/g, '-').toLowerCase();
const recordBase = `https://${host}.suitetalk.api.netsuite.com/services/rest/record/v1`;
const suiteqlUrl = `https://${host}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

const oauth = new OAuth({
  consumer: { key: process.env[`${nsPrefix}_CONSUMER_KEY`], secret: process.env[`${nsPrefix}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (s, k) => crypto.createHmac('sha256', k).update(s).digest('base64'),
});
const token = { key: process.env[`${nsPrefix}_TOKEN_ID`], secret: process.env[`${nsPrefix}_TOKEN_SECRET`] };

async function call(method, url, body) {
  const h = oauth.toHeader(oauth.authorize({ url, method }, token));
  h.Authorization += `, realm="${acct}"`;
  const init = { method, headers: { ...h, 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  const txt = await r.text();
  return { status: r.status, ok: r.ok, body: txt, headers: Object.fromEntries(r.headers) };
}

async function suiteql(sql) {
  const h = oauth.toHeader(oauth.authorize({ url: suiteqlUrl, method: 'POST' }, token));
  h.Authorization += `, realm="${acct}"`;
  const r = await fetch(suiteqlUrl, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json', Prefer: 'transient' }, body: JSON.stringify({ q: sql }) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()).items || [];
}

// -------- Step 1: PATCH the customer --------
console.log(`\n[1/4] PATCH customer ${customerId} (env=${nsPrefix})...`);
const patchRes = await call('PATCH', `${recordBase}/customer/${customerId}`, {
  custentity_orderful_isa_id: liveIsa,
  custentity_orderful_isa_id_test: testIsa,
  // custentity_orderful_subcust_rep: { id: '<list-internal-id>' },  // optional: set if using stand-in EDI parent
});
console.log(`  HTTP ${patchRes.status} ${patchRes.ok ? 'OK' : 'FAIL'}`);
if (!patchRes.ok) { console.log(`  Response: ${patchRes.body.slice(0, 500)}`); process.exit(1); }

// -------- Step 2-4: POST 3 Enabled Transaction records --------
const enabled = [
  { name: '850 Purchase Order (inbound)',  doc: 1, dir: 1, trx: 31 /* Sales Order */ },
  { name: '856 ASN (outbound)',            doc: 3, dir: 2, trx: 32 /* Item Fulfillment */ },
  { name: '810 Invoice (outbound)',        doc: 4, dir: 2, trx: 7  /* Invoice */ },
];

const createdIds = [];
let i = 2;
for (const e of enabled) {
  console.log(`\n[${i}/4] POST Enabled Transaction: ${e.name}`);
  i++;
  const res = await call('POST', `${recordBase}/customrecord_orderful_edi_customer_trans`, {
    custrecord_edi_enab_trans_customer:      { id: customerId },
    custrecord_edi_enab_trans_document_type: { id: String(e.doc) },
    custrecord_edi_enab_trans_direction:     { id: String(e.dir) },
    custrecord_edi_enab_trans_linked_trxtype:{ id: String(e.trx) },
    custrecord_edi_enab_trans_test:          true,
  });
  console.log(`  HTTP ${res.status} ${res.ok ? 'OK' : 'FAIL'}`);
  if (!res.ok) { console.log(`  Response: ${res.body.slice(0, 500)}`); process.exit(1); }
  const loc = res.headers['location'] || res.headers['Location'] || '';
  const createdId = loc.split('/').pop();
  console.log(`  Created ID: ${createdId}`);
  createdIds.push({ ...e, id: createdId });
}

// -------- Verify --------
console.log('\n[Verify] Reading back...');
const cust = await suiteql(`SELECT custentity_orderful_isa_id AS live_isa, custentity_orderful_isa_id_test AS test_isa, BUILTIN.DF(custentity_orderful_subcust_rep) AS subcust_rep FROM customer WHERE id = ${customerId}`);
console.log(`  Customer fields: ${JSON.stringify(cust[0])}`);

const ets = await suiteql(`
  SELECT et.id,
         BUILTIN.DF(et.custrecord_edi_enab_trans_document_type) AS doctype,
         BUILTIN.DF(et.custrecord_edi_enab_trans_direction) AS direction,
         et.custrecord_edi_enab_trans_linked_trxtype AS linked_trx,
         et.custrecord_edi_enab_trans_test AS test_mode
  FROM customrecord_orderful_edi_customer_trans et
  WHERE et.custrecord_edi_enab_trans_customer = ${customerId}
  ORDER BY et.id
`);
console.log(`  Enabled Transactions (${ets.length}):`);
for (const r of ets) console.log(`    [${r.id}]  ${r.doctype}  dir=${r.direction}  linked=${r.linked_trx}  test=${r.test_mode}`);

console.log('\nDone.');
