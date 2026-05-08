#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// After inject.mjs lands a test transaction in the sandbox bucket, watch
// the customer's sandbox NS for SuiteApp ingest and report the resulting
// Orderful Transaction record + Sales Order state.
//
// Also defensively re-checks production NS each cycle to confirm the test
// transaction has not leaked to prod.
//
// Usage:
//   node watch-ingest.mjs <customer-dir> <orderful-txn-id> [--timeout-min=10]

import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const customerDir = args[0];
const txnId = args[1];
const timeoutArg = args.find((a) => a.startsWith('--timeout-min='));
const TIMEOUT_MS = (timeoutArg ? parseInt(timeoutArg.split('=')[1], 10) : 10) * 60 * 1000;

if (!customerDir || !txnId) {
  console.error('Usage: node watch-ingest.mjs <customer-dir> <orderful-txn-id> [--timeout-min=10]');
  process.exit(2);
}

loadEnv({ path: resolve(customerDir, '.env') });

function makeQuery(envPrefix) {
  const accountId = process.env[`${envPrefix}_ACCOUNT_ID`];
  if (!accountId) return null; // env not configured
  const urlHost = accountId.replace(/_/g, '-').toLowerCase();
  const baseUrl = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const oauth = new OAuth({
    consumer: { key: process.env[`${envPrefix}_CONSUMER_KEY`], secret: process.env[`${envPrefix}_CONSUMER_SECRET`] },
    signature_method: 'HMAC-SHA256',
    hash_function: (b, k) => crypto.createHmac('sha256', k).update(b).digest('base64'),
  });
  const token = { key: process.env[`${envPrefix}_TOKEN_ID`], secret: process.env[`${envPrefix}_TOKEN_SECRET`] };
  return async (q) => {
    const r = { url: baseUrl, method: 'POST' };
    const h = oauth.toHeader(oauth.authorize(r, token));
    h.Authorization += `, realm="${accountId}"`;
    const res = await fetch(baseUrl, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json', Prefer: 'transient' }, body: JSON.stringify({ q }) });
    return JSON.parse(await res.text());
  };
}

const sb = makeQuery('NS_SB');
const prod = makeQuery('NS_PROD');
if (!sb) { console.error('NS_SB credentials missing in .env'); process.exit(2); }

console.log(`Watching for orderful_id=${txnId} in sandbox NS (timeout: ${TIMEOUT_MS / 60000} min)…`);
if (prod) console.log('Defensively cross-checking production NS each cycle.');

const start = Date.now();
while (Date.now() - start < TIMEOUT_MS) {
  const elapsed = Math.round((Date.now() - start) / 1000);
  const sbR = await sb(`SELECT id, BUILTIN.DF(custrecord_ord_tran_status) AS status, custrecord_ord_tran_inbound_transaction AS so_id, custrecord_ord_tran_validation_results AS errors FROM customrecord_orderful_transaction WHERE custrecord_ord_tran_orderful_id = '${txnId}'`);
  const prodR = prod ? await prod(`SELECT id FROM customrecord_orderful_transaction WHERE custrecord_ord_tran_orderful_id = '${txnId}'`) : null;
  const sbHit = sbR.items?.[0];
  const prodHit = prodR?.items?.[0];

  console.log(`[t+${elapsed}s] sandbox=${sbHit ? `id=${sbHit.id} status=${sbHit.status} so_id=${sbHit.so_id || '(none)'}` : '-'}  prod=${prodHit ? `LEAK id=${prodHit.id}` : 'clean'}`);

  if (prodHit) {
    console.error('\n*** PROD LEAK detected. The test transaction was processed in production. ***');
    console.error('Investigate: query Sales Order by externalid / otherrefnum / custbody_orderful_document.');
    process.exit(2);
  }

  if (sbHit?.so_id) {
    const so = await sb(`SELECT id, externalid, tranid, otherrefnum, BUILTIN.DF(entity) AS entity FROM transaction WHERE id = ${sbHit.so_id}`);
    console.log('\n--- Sales Order created in sandbox ---');
    console.log(JSON.stringify(so.items?.[0], null, 2));
    process.exit(0);
  }

  if (sbHit?.status && sbHit.status !== 'Pending' && sbHit.status !== 'Processing' && !sbHit.so_id) {
    console.log(`\nStopped at sandbox status=${sbHit.status} (no SO created).`);
    if (sbHit.errors) console.log('errors:', sbHit.errors.slice(0, 600));
    process.exit(3);
  }

  await new Promise((r) => setTimeout(r, 20000));
}

console.log('Timeout reached without SO creation.');
process.exit(4);
