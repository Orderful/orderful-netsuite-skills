#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Inject a test inbound EDI transaction to Orderful with routing guardrails.
//
// Usage:
//   node inject.mjs <customer-dir> <message-body.json> \
//     --doc-type=850_PURCHASE_ORDER \
//     --sender-test-isa=4253138601CHQT \
//     --receiver-test-isa=5146366668T \
//     --sandbox-bucket=56996 \
//     --prod-bucket=62078 \
//     [--po-prefix=TEST-EXTID]
//
// Behavior:
//   1. POSTs the transaction to Orderful with stream=TEST and the provided
//      test-side ISAs.
//   2. Polls BOTH the sandbox and prod polling buckets every 3s for 60s.
//   3. If the transaction appears in the prod bucket, immediately calls
//      confirm-retrieval to evict it; reports + exits non-zero.
//   4. If it appears in the sandbox bucket, exits 0 with the orderful-txn-id
//      printed for downstream watch tooling.
//
// This script does the POST + bucket verification only. Pre-flight checks
// (relationship lookup, NS test_isa alignment) and post-landing NS
// monitoring are separate steps in the skill — see SKILL.md.

import { config as loadEnv } from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const customerDir = args[0];
const messagePath = args[1];
function flag(name) {
  const a = args.find((x) => x.startsWith(`${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}
const docType = flag('--doc-type');
const senderTestIsa = flag('--sender-test-isa');
const receiverTestIsa = flag('--receiver-test-isa');
const sandboxBucket = flag('--sandbox-bucket');
const prodBucket = flag('--prod-bucket');
const poPrefix = flag('--po-prefix') || 'TEST';

if (!customerDir || !messagePath || !docType || !senderTestIsa || !receiverTestIsa || !sandboxBucket || !prodBucket) {
  console.error('Missing required args. See header for usage.');
  process.exit(2);
}

loadEnv({ path: resolve(customerDir, '.env') });
const KEY = process.env.ORDERFUL_API_KEY;
if (!KEY) { console.error('ORDERFUL_API_KEY missing from .env'); process.exit(2); }

const message = JSON.parse(readFileSync(messagePath, 'utf-8'));
delete message.href; // strip retrieval-only fields if present

// Rewrite the PO number so the test is grep-able and never collides
const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const newPO = `${poPrefix}-${ts}`;
const beg = message?.transactionSets?.[0]?.beginningSegmentForPurchaseOrder?.[0];
if (beg && 'purchaseOrderNumber' in beg) {
  beg.purchaseOrderNumber = newPO;
  console.log(`Rewrote BEG.purchaseOrderNumber → ${newPO}`);
}

const payload = {
  type: { name: docType },
  stream: 'TEST',
  sender: { isaId: senderTestIsa },
  receiver: { isaId: receiverTestIsa },
  message,
};

console.log(`POSTing TEST ${docType} ${senderTestIsa} → ${receiverTestIsa}…`);
const res = await fetch('https://api.orderful.com/v3/transactions', {
  method: 'POST',
  headers: { 'orderful-api-key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const text = await res.text();
console.log(`POST: ${res.status}`);
if (!res.ok) { console.error(text); process.exit(1); }
const txnId = JSON.parse(text).id;
console.log(`Orderful transaction id: ${txnId}`);

// Save the run record up-front so we have an artifact even if later steps fail
const runDir = resolve(customerDir, 'test-injections');
mkdirSync(runDir, { recursive: true });
const runPath = `${runDir}/${txnId}.json`;
const runRecord = {
  startedAt: new Date().toISOString(),
  txnId,
  newPO,
  docType,
  senderTestIsa,
  receiverTestIsa,
  sandboxBucket,
  prodBucket,
  bucketObservations: [],
};
const writeRun = () => writeFileSync(runPath, JSON.stringify(runRecord, null, 2));
writeRun();

async function bucketHas(bucket, id) {
  const r = await fetch(`https://api.orderful.com/v3/polling-buckets/${bucket}?limit=100`, {
    headers: { 'orderful-api-key': KEY },
  });
  const items = await r.json();
  return Array.isArray(items) && items.some((it) => it.id === id);
}

async function confirmRetrieve(bucket, id) {
  const r = await fetch(`https://api.orderful.com/v3/polling-buckets/${bucket}/confirm-retrieval`, {
    method: 'POST',
    headers: { 'orderful-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceIds: [id] }),
  });
  return r.json();
}

console.log(`\nVerifying routing: sandbox=${sandboxBucket}, prod=${prodBucket}…`);
const start = Date.now();
let landedIn = null;
while (Date.now() - start < 60000) {
  await new Promise((r) => setTimeout(r, 3000));
  const inSb = await bucketHas(sandboxBucket, txnId);
  const inProd = await bucketHas(prodBucket, txnId);
  const elapsed = Math.round((Date.now() - start) / 1000);
  runRecord.bucketObservations.push({ at: new Date().toISOString(), elapsed, inSandbox: inSb, inProd });
  writeRun();
  console.log(`[t+${elapsed}s] sandbox=${inSb ? 'FOUND' : '-'}  prod=${inProd ? 'FOUND' : '-'}`);
  if (inProd) {
    console.error('\n*** ABORT — txn appeared in PROD bucket. Confirm-retrieving immediately. ***');
    const cr = await confirmRetrieve(prodBucket, txnId);
    console.error(`confirm-retrieval result: ${JSON.stringify(cr)}`);
    runRecord.outcome = 'aborted-prod-bucket';
    runRecord.confirmRetrievalResult = cr;
    writeRun();
    process.exit(2);
  }
  if (inSb) {
    landedIn = 'sandbox';
    console.log('\n✓ Txn is in sandbox bucket — safe to wait for SuiteApp ingest.');
    break;
  }
}
runRecord.outcome = landedIn || 'unobserved';
runRecord.endedAt = new Date().toISOString();
writeRun();

if (!landedIn) {
  console.log('\nNeither bucket showed the txn within 60s. It may have been polled+confirmed by a SuiteApp.');
  console.log('Check the customer\'s sandbox NS for ingest using the watch-ingest.mjs script.');
}
console.log(`\nRun record: ${runPath}`);
console.log(`Next: node watch-ingest.mjs ${customerDir} ${txnId}`);
process.exit(landedIn ? 0 : 1);
