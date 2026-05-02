#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Audit every customrecord_orderful_edi_customer_trans record for a target
// document type. Saves per-record JSONata backups + a summary JSON.
//
// Usage:
//   node audit.mjs <customer-dir> <doc-type-name>
//
// Where <customer-dir> contains a .env populated by the netsuite-setup skill,
// and <doc-type-name> is matched case-insensitively against
// customrecord_orderful_edi_document_type.name (e.g., "850_PURCHASE_ORDER",
// "850 Purchase Order", or just "850" if unambiguous).
//
// Backups land in <customer-dir>/jsonata-backups/<sanitized-doc-type>/.
//
// Reads ENVIRONMENT=sandbox|production from .env. Always start in sandbox.

import { config as loadEnv } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const customerDir = process.argv[2];
const docTypeQuery = process.argv[3];
if (!customerDir || !docTypeQuery) {
  console.error('Usage: node audit.mjs <customer-dir> <doc-type-name>');
  process.exit(2);
}

const envPath = resolve(customerDir, '.env');
if (!existsSync(envPath)) { console.error(`No .env at ${envPath}`); process.exit(2); }
loadEnv({ path: envPath });

const envMode = (process.env.ENVIRONMENT || 'sandbox').toLowerCase();
const nsPrefix = envMode === 'production' ? 'NS_PROD' : 'NS_SB';
const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
if (!accountId) { console.error(`Missing ${nsPrefix}_ACCOUNT_ID`); process.exit(2); }
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const baseUrl = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

const oauth = new OAuth({
  consumer: { key: process.env[`${nsPrefix}_CONSUMER_KEY`], secret: process.env[`${nsPrefix}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (b, k) => crypto.createHmac('sha256', k).update(b).digest('base64'),
});
const token = { key: process.env[`${nsPrefix}_TOKEN_ID`], secret: process.env[`${nsPrefix}_TOKEN_SECRET`] };

async function suiteql(q) {
  const r = { url: baseUrl, method: 'POST' };
  const h = oauth.toHeader(oauth.authorize(r, token));
  h.Authorization += `, realm="${accountId}"`;
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SuiteQL ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// 1. Resolve doc-type FK id
const docTypes = await suiteql(
  `SELECT id, name FROM customrecord_orderful_edi_document_type WHERE UPPER(name) LIKE '%${docTypeQuery.toUpperCase().replace(/[^A-Z0-9_ ]/g, '')}%'`
);
const matches = docTypes.items || [];
if (matches.length === 0) { console.error(`No doc type matched "${docTypeQuery}"`); process.exit(1); }
if (matches.length > 1) {
  console.error(`Multiple doc types matched "${docTypeQuery}":`);
  for (const m of matches) console.error(`  id=${m.id}  name=${m.name}`);
  console.error('Refine the query.');
  process.exit(1);
}
const docType = matches[0];
console.log(`Doc type: id=${docType.id} name="${docType.name}" (env=${envMode}, account=${accountId})`);

// 2. Pull all enabled-trans-type records for that doc type
const recs = await suiteql(`
  SELECT
    e.id,
    e.custrecord_edi_enab_trans_customer AS customer_id,
    BUILTIN.DF(e.custrecord_edi_enab_trans_customer) AS customer_name,
    e.custrecord_edi_enab_trans_isa_company AS company_isa,
    BUILTIN.DF(e.custrecord_edi_enab_trans_jsonata_ver) AS jsonata_ver,
    e.custrecord_edi_enab_trans_cust_process AS use_custom,
    e.custrecord_edi_enab_jsonata AS jsonata
  FROM customrecord_orderful_edi_customer_trans e
  WHERE e.custrecord_edi_enab_trans_document_type = ${docType.id}
  ORDER BY e.id
`);
const records = recs.items || [];
console.log(`Found ${records.length} enabled-trans-type records for "${docType.name}".`);

// 3. Backup + summarize
const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const docSlug = docType.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const backupDir = resolve(customerDir, 'jsonata-backups', docSlug);
mkdirSync(backupDir, { recursive: true });

const summary = [];
for (const r of records) {
  const customerSlug = (r.customer_name || `customer-${r.customer_id}`).replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
  const path = `${backupDir}/jsonata-${docSlug}-${r.id}-${customerSlug}-${ts}.txt`;
  if (r.jsonata) writeFileSync(path, r.jsonata);

  const j = r.jsonata || '';
  const lower = /"userdefinedfields"\s*:\s*\{/.test(j);
  const camel = /"userDefinedFields"\s*:\s*\{/.test(j);
  const usesMerge = j.includes('$merge');
  const usesTransform = j.includes('~>');

  const sideFindings = [];
  if (lower && !camel) sideFindings.push('lowercase userdefinedfields (broken — SuiteApp expects camelCase)');
  if (!lower && !camel) sideFindings.push('no userDefinedFields block');
  if (j.length === 0) sideFindings.push('empty JSONata');
  if (j.length > 0 && j.length < 200) sideFindings.push('very short JSONata (possibly a default)');

  summary.push({
    id: r.id,
    customerId: r.customer_id,
    customer: r.customer_name,
    companyIsa: r.company_isa,
    jsonataVer: r.jsonata_ver,
    useCustom: r.use_custom,
    length: j.length,
    style: usesMerge && !usesTransform ? '$merge' : usesTransform && !usesMerge ? '~>' : usesMerge ? 'mixed' : 'none',
    hasUserDefinedFields: camel,
    hasLowercaseUserDefinedFields: lower && !camel,
    sideFindings,
    backup: r.jsonata ? path : null,
  });
}

const summaryPath = `${backupDir}/audit-summary-${ts}.json`;
writeFileSync(summaryPath, JSON.stringify({
  pulledAt: new Date().toISOString(),
  customerDir,
  envMode,
  docType,
  records: summary,
}, null, 2));

console.log('\nSummary:');
console.log(`  records: ${summary.length}`);
console.log(`  with userDefinedFields (camelCase): ${summary.filter((s) => s.hasUserDefinedFields).length}`);
console.log(`  with lowercase userdefinedfields (broken): ${summary.filter((s) => s.hasLowercaseUserDefinedFields).length}`);
console.log(`  use custom-process mode: ${summary.filter((s) => s.useCustom === 'T').length}`);
const flagged = summary.filter((s) => s.sideFindings.length > 0);
if (flagged.length) {
  console.log(`\nSide findings (${flagged.length}):`);
  for (const f of flagged) console.log(`  id=${f.id} customer=${f.customer}: ${f.sideFindings.join('; ')}`);
}
console.log(`\nBackups: ${backupDir}`);
console.log(`Summary: ${summaryPath}`);
