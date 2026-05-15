// Copyright (c) 2026 Orderful, Inc.
// Read or write the singleton Orderful Feature Flags record.
//
// Usage:
//   node set-feature-flag.mjs <customer-dir>                       (read current flags)
//   node set-feature-flag.mjs <customer-dir> --set '<json-object>' (replace flags JSON)
//
// The custom record `customrecord_orderful_feature_flags` holds a single row whose
// `custrecord_orderful_feature_flags` (CLOBTEXT) field stores a JSON object of
// boolean flags. A UE script enforces singleton-ness; this helper PATCHes the
// existing row when present and POSTs a new one otherwise.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const dir = process.argv[2];
const setIdx = process.argv.indexOf('--set');
const newFlagsJson = setIdx > -1 ? process.argv[setIdx + 1] : null;

if (!dir) {
  console.error('Usage: node set-feature-flag.mjs <customer-dir> [--set \'<json>\']');
  process.exit(1);
}
if (newFlagsJson) {
  try { JSON.parse(newFlagsJson); }
  catch (e) { console.error('--set value is not valid JSON:', e.message); process.exit(1); }
}

loadEnv({ path: resolve(dir, '.env') });
const p = (process.env.ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'NS_PROD' : 'NS_SB';
const accountId = process.env[`${p}_ACCOUNT_ID`];
if (!accountId) { console.error(`No ${p}_ACCOUNT_ID in ${dir}/.env`); process.exit(1); }
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const oauth = new OAuth({
  consumer: { key: process.env[`${p}_CONSUMER_KEY`], secret: process.env[`${p}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (b, k) => crypto.createHmac('sha256', k).update(b).digest('base64'),
});
const token = { key: process.env[`${p}_TOKEN_ID`], secret: process.env[`${p}_TOKEN_SECRET`] };

function af(url, method, body) {
  const auth = oauth.toHeader(oauth.authorize({ url, method }, token));
  auth.Authorization += `, realm="${accountId}"`;
  const opts = { method, headers: { ...auth, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

const base = `https://${urlHost}.suitetalk.api.netsuite.com`;
const sqlUrl = `${base}/services/rest/query/v1/suiteql`;

async function readFlags() {
  const sqlAuth = oauth.toHeader(oauth.authorize({ url: sqlUrl, method: 'POST' }, token));
  sqlAuth.Authorization += `, realm="${accountId}"`;
  const r = await fetch(sqlUrl, {
    method: 'POST',
    headers: { ...sqlAuth, 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q: `SELECT id, custrecord_orderful_feature_flags AS flags FROM customrecord_orderful_feature_flags` }),
  });
  const j = await r.json();
  return j.items?.[0] ?? null;
}

console.log('Account:', accountId, `(${process.env.ENVIRONMENT})`);
const existing = await readFlags();
console.log('Current:', existing ? `id=${existing.id} flags=${existing.flags}` : 'no record');

if (!newFlagsJson) process.exit(0);

const recUrl = `${base}/services/rest/record/v1/customrecord_orderful_feature_flags`;
const r = existing
  ? await af(`${recUrl}/${existing.id}`, 'PATCH', { custrecord_orderful_feature_flags: newFlagsJson })
  : await af(recUrl, 'POST', { custrecord_orderful_feature_flags: newFlagsJson });
console.log(`\n${existing ? 'PATCH' : 'POST'} ${existing ? `${recUrl}/${existing.id}` : recUrl} → ${r.status}`);
const txt = await r.text();
if (txt) console.log('  body:', txt.slice(0, 500));
const loc = r.headers.get('location');
if (loc) console.log('  location:', loc);

if (r.status >= 300) process.exit(1);
const after = await readFlags();
console.log('\nAfter:', after ? `id=${after.id} flags=${after.flags}` : 'no record');
