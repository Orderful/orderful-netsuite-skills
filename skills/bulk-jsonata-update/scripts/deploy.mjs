#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Apply a transformation to every JSONata backup from the most recent audit
// run, with dry-run preview and live deploy modes. Live mode PATCHes one
// record at a time and verifies via read-back.
//
// Usage:
//   node deploy.mjs <customer-dir> <doc-type-name> <transform.mjs> --dry-run
//   node deploy.mjs <customer-dir> <doc-type-name> <transform.mjs> --execute
//   node deploy.mjs <customer-dir> <doc-type-name> <transform.mjs> --execute --only=149,153
//   node deploy.mjs <customer-dir> <doc-type-name> <transform.mjs> --execute --exclude=28
//
// <transform.mjs> must default-export a function:
//   (originalJsonata, recordId) => ({ newJsonata: string, notes: string[] })
//
// The function MUST throw on any record where the change can't be safely
// applied — silent no-ops are not allowed.

import { config as loadEnv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const customerDir = args[0];
const docTypeQuery = args[1];
const transformPath = args[2];
const DRY = args.includes('--dry-run');
const EXEC = args.includes('--execute');
const onlyArg = args.find((a) => a.startsWith('--only='));
const excludeArg = args.find((a) => a.startsWith('--exclude='));
const ONLY = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null;
const EXCLUDE = excludeArg ? new Set(excludeArg.split('=')[1].split(',')) : new Set();

if (!customerDir || !docTypeQuery || !transformPath) {
  console.error('Usage: node deploy.mjs <customer-dir> <doc-type-name> <transform.mjs> [--dry-run|--execute] [--only=...] [--exclude=...]');
  process.exit(2);
}
if (DRY === EXEC) { console.error('Specify exactly one of --dry-run or --execute'); process.exit(2); }

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

// Find the most recent audit summary for this doc type
const docSlug = docTypeQuery.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/-+/g, '-');
// docSlug from CLI input may not match how audit.mjs slugged it. We look for any audit-summary-*.json
// in jsonata-backups/<slug>/ where slug starts with the user-provided substring.
const backupRoot = resolve(customerDir, 'jsonata-backups');
if (!existsSync(backupRoot)) { console.error(`No audit backups at ${backupRoot}. Run audit.mjs first.`); process.exit(2); }

let backupDir, summaryFile;
for (const slug of readdirSync(backupRoot)) {
  if (!slug.includes(docSlug.split('-')[0]) && !slug.includes(docSlug)) continue;
  const candidate = resolve(backupRoot, slug);
  const summaries = readdirSync(candidate).filter((f) => f.startsWith('audit-summary-') && f.endsWith('.json')).sort();
  if (summaries.length > 0) {
    backupDir = candidate;
    summaryFile = summaries[summaries.length - 1];
    break;
  }
}
if (!backupDir) { console.error(`No audit summary found for doc-type "${docTypeQuery}". Run audit.mjs first.`); process.exit(2); }
const summary = JSON.parse(readFileSync(`${backupDir}/${summaryFile}`, 'utf-8'));
console.log(`Loaded ${summaryFile} (${summary.records.length} records, env=${envMode})`);

// Load the transform module
const transformModule = await import(pathToFileURL(resolve(transformPath)).href);
const transform = transformModule.default || transformModule.transform;
if (typeof transform !== 'function') {
  console.error(`${transformPath} must default-export (or export "transform") a function`);
  process.exit(2);
}

const transformedDir = `${backupDir}/transformed`;
mkdirSync(transformedDir, { recursive: true });

const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const logPath = `${backupDir}/deploy-${DRY ? 'dryrun' : 'live'}-${ts}.log.jsonl`;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\n');

async function patchRecord(recordId, newJsonata) {
  const url = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/record/v1/customrecord_orderful_edi_customer_trans/${recordId}`;
  const r = { url, method: 'PATCH' };
  const h = oauth.toHeader(oauth.authorize(r, token));
  h.Authorization += `, realm="${accountId}"`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ custrecord_edi_enab_jsonata: newJsonata }),
  });
  if (!res.ok) throw new Error(`PATCH ${recordId}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function readbackJsonata(recordId) {
  const baseUrl = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const r = { url: baseUrl, method: 'POST' };
  const h = oauth.toHeader(oauth.authorize(r, token));
  h.Authorization += `, realm="${accountId}"`;
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q: `SELECT custrecord_edi_enab_jsonata AS j FROM customrecord_orderful_edi_customer_trans WHERE id = ${recordId}` }),
  });
  return JSON.parse(await res.text()).items?.[0]?.j;
}

let okCount = 0, errCount = 0, skipCount = 0;

for (const rec of summary.records) {
  if (ONLY && !ONLY.has(rec.id)) { skipCount++; continue; }
  if (EXCLUDE.has(rec.id)) { skipCount++; continue; }
  if (!rec.backup) { console.log(`[skip] ${rec.id} (no backup file in audit summary)`); skipCount++; continue; }

  const original = readFileSync(rec.backup, 'utf-8');
  let result;
  try {
    result = transform(original, rec.id);
    if (!result || typeof result.newJsonata !== 'string') {
      throw new Error('transform must return { newJsonata: string, notes: string[] }');
    }
  } catch (e) {
    console.log(`[FAIL] ${rec.id} (${rec.customer}): ${e.message}`);
    log({ recordId: rec.id, customer: rec.customer, ok: false, mode: DRY ? 'dry' : 'live', error: e.message });
    errCount++;
    if (EXEC) { console.log('Stopping on first failure (live mode).'); break; }
    continue;
  }

  const outPath = `${transformedDir}/jsonata-${rec.id}-NEW.txt`;
  writeFileSync(outPath, result.newJsonata);

  if (DRY) {
    console.log(`[dry] ${rec.id} (${rec.customer}): ${original.length}b -> ${result.newJsonata.length}b. Notes: ${(result.notes || []).join('; ')}`);
    log({ recordId: rec.id, customer: rec.customer, mode: 'dry', notes: result.notes, lengthDelta: result.newJsonata.length - original.length, transformedAt: outPath });
    okCount++;
    continue;
  }

  // EXECUTE
  try {
    await patchRecord(rec.id, result.newJsonata);
    const back = await readbackJsonata(rec.id);
    if (back !== result.newJsonata) throw new Error(`read-back mismatch (got ${back?.length}b, expected ${result.newJsonata.length}b)`);
    console.log(`[ok]  ${rec.id} (${rec.customer}): patched + verified. Notes: ${(result.notes || []).join('; ')}`);
    log({ recordId: rec.id, customer: rec.customer, mode: 'live', ok: true, notes: result.notes });
    okCount++;
  } catch (e) {
    console.log(`[FAIL] ${rec.id} (${rec.customer}): ${e.message}`);
    log({ recordId: rec.id, customer: rec.customer, mode: 'live', ok: false, error: e.message });
    errCount++;
    console.log('Stopping on first failure to avoid further damage.');
    break;
  }
}

console.log(`\n=== Summary ===`);
console.log(`Mode: ${DRY ? 'DRY-RUN' : 'LIVE'}  Env: ${envMode}`);
console.log(`OK: ${okCount}  FAIL: ${errCount}  SKIP: ${skipCount}`);
console.log(`Log: ${logPath}`);
process.exit(errCount > 0 ? 1 : 0);
