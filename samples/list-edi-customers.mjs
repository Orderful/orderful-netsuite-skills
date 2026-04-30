#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Sample: list NetSuite customers configured for Orderful EDI.
//
// Reads the customer's onboarding `.env` (NS_SB_* or NS_PROD_* depending on
// ENVIRONMENT), then runs three SuiteQL queries against the NetSuite REST API:
//
//   1. SuiteApp sanity check — confirms the Orderful EDI document type seed
//      records are present (proxy for "is the SuiteApp installed and working?").
//   2. EDI candidate customers — top-level customers (parent IS NULL) that
//      have an Orderful ISA ID populated. For each one, also counts the number
//      of subcustomers and Enabled Transaction records.
//   3. All Enabled Transactions in the account (capped at 20 rows shown).
//
// Useful as a first-pass recon when starting on a new customer account, to
// see what's already been configured before you start enabling more.
//
// Usage:
//   node samples/list-edi-customers.mjs <path-to-env-dir>
//
// Where <path-to-env-dir> is the directory containing the customer's `.env`
// (typically ~/orderful-onboarding/<customer-slug>).
//
import { config as loadEnv } from 'dotenv';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';
import { resolve } from 'node:path';

const envDir = process.argv[2];
if (!envDir) {
  console.error('Usage: node samples/list-edi-customers.mjs <path-to-env-dir>');
  process.exit(1);
}
loadEnv({ path: resolve(envDir, '.env') });

const nsPrefix = (process.env.ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'NS_PROD' : 'NS_SB';
const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const url = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

const oauth = new OAuth({
  consumer: { key: process.env[`${nsPrefix}_CONSUMER_KEY`], secret: process.env[`${nsPrefix}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (s, k) => crypto.createHmac('sha256', k).update(s).digest('base64'),
});
const token = { key: process.env[`${nsPrefix}_TOKEN_ID`], secret: process.env[`${nsPrefix}_TOKEN_SECRET`] };

async function q(sql) {
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  authHeader.Authorization += `, realm="${accountId}"`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q: sql }),
  });
  const text = await res.text();
  if (!res.ok) return { error: `${res.status} ${text.slice(0, 300)}` };
  return JSON.parse(text).items || [];
}

console.log('--- SuiteApp sanity (document type seeds) ---');
const docTypes = await q(`SELECT id, name FROM customrecord_orderful_edi_document_type ORDER BY name`);
if (docTypes.error) { console.log(docTypes.error); process.exit(1); }
console.log(`  ${docTypes.length} document type rows present`);

console.log('\n--- Customers with ISA IDs (top-level only) ---');
const candidates = await q(`
  SELECT BUILTIN.DF(id) AS idlabel, id AS internalid, entityid, companyname, custentity_orderful_isa_id AS isa
  FROM customer
  WHERE custentity_orderful_isa_id IS NOT NULL
    AND TRIM(custentity_orderful_isa_id) != ''
    AND parent IS NULL
  ORDER BY companyname
`);
if (candidates.error) { console.log(candidates.error); process.exit(1); }
if (candidates.length === 0) console.log('  (none)');
for (const c of candidates) {
  const subs = await q(`SELECT COUNT(*) AS n FROM customer WHERE parent = ${c.internalid}`);
  const ets = await q(`SELECT COUNT(*) AS n FROM customrecord_orderful_edi_customer_trans WHERE custrecord_edi_enab_trans_customer = ${c.internalid}`);
  const subn = subs.error ? '?' : subs[0]?.n ?? 0;
  const etn = ets.error ? '?' : ets[0]?.n ?? 0;
  console.log(`  ${c.companyname}  [id=${c.internalid}  entityid=${c.entityid}  isa=${c.isa}]  subs=${subn}  enabled_trans=${etn}`);
}

console.log('\n--- Existing Enabled Transactions (any parent) ---');
const anyET = await q(`
  SELECT et.id, BUILTIN.DF(et.custrecord_edi_enab_trans_customer) AS customer, BUILTIN.DF(et.custrecord_edi_enab_trans_document_type) AS doctype
  FROM customrecord_orderful_edi_customer_trans et
  ORDER BY et.id
`);
if (anyET.error) console.log(anyET.error);
else {
  console.log(`  ${anyET.length} total`);
  for (const r of anyET.slice(0, 20)) console.log(`    ${r.id}  ${r.customer}  ${r.doctype}`);
  if (anyET.length > 20) console.log(`    ... (${anyET.length - 20} more)`);
}
