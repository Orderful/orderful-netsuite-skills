#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Restore one or more enabled-trans-type records to their pre-deploy JSONata,
// reading from the most recent audit-summary backup.
//
// Usage:
//   node restore.mjs <customer-dir> <doc-type-name> <recordId>
//   node restore.mjs <customer-dir> <doc-type-name> 149,153,164
//   node restore.mjs <customer-dir> <doc-type-name> --all

import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const customerDir = args[0];
const docTypeQuery = args[1];
const idsOrAll = args[2];
if (!customerDir || !docTypeQuery || !idsOrAll) {
  console.error('Usage: node restore.mjs <customer-dir> <doc-type-name> <recordId|id,id,...|--all>');
  process.exit(2);
}
const ALL = idsOrAll === '--all';
const RECORD_IDS = ALL ? null : new Set(idsOrAll.split(',').map((s) => s.trim()));

loadEnv({ path: resolve(customerDir, '.env') });
const envMode = (process.env.ENVIRONMENT || 'sandbox').toLowerCase();
const nsPrefix = envMode === 'production' ? 'NS_PROD' : 'NS_SB';
const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const oauth = new OAuth({
  consumer: { key: process.env[`${nsPrefix}_CONSUMER_KEY`], secret: process.env[`${nsPrefix}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (b, k) => crypto.createHmac('sha256', k).update(b).digest('base64'),
});
const token = { key: process.env[`${nsPrefix}_TOKEN_ID`], secret: process.env[`${nsPrefix}_TOKEN_SECRET`] };

const backupRoot = resolve(customerDir, 'jsonata-backups');
if (!existsSync(backupRoot)) { console.error(`No backups at ${backupRoot}`); process.exit(2); }

const docSlug = docTypeQuery.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/-+/g, '-');
let backupDir, summaryFile;
for (const slug of readdirSync(backupRoot)) {
  if (!slug.includes(docSlug.split('-')[0]) && !slug.includes(docSlug)) continue;
  const candidate = resolve(backupRoot, slug);
  const summaries = readdirSync(candidate).filter((f) => f.startsWith('audit-summary-') && f.endsWith('.json')).sort();
  if (summaries.length > 0) { backupDir = candidate; summaryFile = summaries[summaries.length - 1]; break; }
}
if (!backupDir) { console.error(`No audit summary found for "${docTypeQuery}"`); process.exit(2); }
const summary = JSON.parse(readFileSync(`${backupDir}/${summaryFile}`, 'utf-8'));

const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const logPath = `${backupDir}/restore-${ts}.log.jsonl`;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\n');

async function patch(recordId, jsonata) {
  const url = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/record/v1/customrecord_orderful_edi_customer_trans/${recordId}`;
  const r = { url, method: 'PATCH' };
  const h = oauth.toHeader(oauth.authorize(r, token));
  h.Authorization += `, realm="${accountId}"`;
  const res = await fetch(url, { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ custrecord_edi_enab_jsonata: jsonata }) });
  if (!res.ok) throw new Error(`PATCH ${recordId}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

let ok = 0, err = 0, skip = 0;
for (const rec of summary.records) {
  if (!ALL && !RECORD_IDS.has(rec.id)) { skip++; continue; }
  if (!rec.backup) { console.log(`[skip] ${rec.id} (no backup file)`); skip++; continue; }
  const original = readFileSync(rec.backup, 'utf-8');
  try {
    await patch(rec.id, original);
    console.log(`[ok] restored ${rec.id} (${rec.customer}) from ${rec.backup}`);
    log({ recordId: rec.id, customer: rec.customer, ok: true, source: rec.backup });
    ok++;
  } catch (e) {
    console.log(`[FAIL] ${rec.id}: ${e.message}`);
    log({ recordId: rec.id, ok: false, error: e.message });
    err++;
  }
}
console.log(`\nOK: ${ok}  FAIL: ${err}  SKIP: ${skip}  Log: ${logPath}`);
process.exit(err > 0 ? 1 : 0);
