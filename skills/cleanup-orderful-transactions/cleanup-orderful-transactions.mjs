#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Clean up failed/duplicate "Orderful Transaction" (customrecord_orderful_transaction)
// records — and their customrecord_orderful_edi_trx_join rows — left behind when an
// outbound document is (re)fired several times during debugging. Keeps the valid
// (Success) record for each consolidation group and deletes only the Error-status
// duplicates that have a successful sibling.
//
// DRY-RUN by default: prints the plan and changes nothing. Pass --apply to delete.
//
// Usage:
//   node cleanup-orderful-transactions.mjs <customer-dir> <source-transaction-id> [--apply]
//
// <source-transaction-id> is the NetSuite internal id of the SOURCE record the OTs were
// generated from (e.g. the Invoice for an 810, the Item Fulfillment for an 856) — NOT
// the OT id and NOT the Orderful UUID.

import { config as loadEnv } from 'dotenv';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

// Status scriptids from OrderfulTransactionStatus (Models/orderful_transaction.ts).
// SuiteQL returns scriptids uppercase, hence the comparisons below.
const STATUS_SUCCESS = 'TRANSACTION_STATUS_SUCCESS';
const STATUS_ERROR = 'TRANSACTION_STATUS_ERROR';

const OT_TYPE = 'customrecord_orderful_transaction';
const JOIN_TYPE = 'customrecord_orderful_edi_trx_join';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positionals = args.filter((a) => !a.startsWith('--'));
const customerDir = positionals[0];
const sourceId = positionals[1];

if (!customerDir || !sourceId) {
  console.error('Usage: node cleanup-orderful-transactions.mjs <customer-dir> <source-transaction-id> [--apply]');
  process.exit(2);
}
if (!/^\d+$/.test(sourceId)) {
  console.error(`Source transaction id must be a positive integer (got "${sourceId}").`);
  console.error('Hint: this is the NetSuite internal id of the source record (e.g. the invoice), not the OT id or Orderful UUID.');
  process.exit(2);
}

const envPath = resolve(customerDir, '.env');
if (!existsSync(envPath)) {
  console.error(`No .env found at ${envPath}`);
  process.exit(2);
}
loadEnv({ path: envPath });

const envMode = (process.env.ENVIRONMENT || 'sandbox').toLowerCase();
if (envMode !== 'sandbox' && envMode !== 'production') {
  console.error(`ENVIRONMENT must be "sandbox" or "production" (got "${envMode}")`);
  process.exit(2);
}
const nsPrefix = envMode === 'production' ? 'NS_PROD' : 'NS_SB';

const required = [
  `${nsPrefix}_ACCOUNT_ID`,
  `${nsPrefix}_CONSUMER_KEY`,
  `${nsPrefix}_CONSUMER_SECRET`,
  `${nsPrefix}_TOKEN_ID`,
  `${nsPrefix}_TOKEN_SECRET`,
];
const PLACEHOLDER = /^<\s*paste\s*here\s*>$/i;
const missing = required.filter((k) => {
  const v = process.env[k];
  return !v || v.trim() === '' || PLACEHOLDER.test(v.trim());
});
if (missing.length > 0) {
  console.error(`Missing or unfilled env vars for ENVIRONMENT=${envMode}:`);
  missing.forEach((k) => console.error(`  - ${k}`));
  process.exit(2);
}

const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
// Sandbox/RP account ids use underscores in the id (1234567_SB1) but hyphens in URL hosts.
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const customerLabel = process.env.CUSTOMER_NAME || process.env.CUSTOMER_SLUG || customerDir;

const oauth = new OAuth({
  consumer: {
    key: process.env[`${nsPrefix}_CONSUMER_KEY`],
    secret: process.env[`${nsPrefix}_CONSUMER_SECRET`],
  },
  signature_method: 'HMAC-SHA256',
  hash_function(baseString, key) {
    return crypto.createHmac('sha256', key).update(baseString).digest('base64');
  },
});
const token = {
  key: process.env[`${nsPrefix}_TOKEN_ID`],
  secret: process.env[`${nsPrefix}_TOKEN_SECRET`],
};
function signedHeaders(url, method, extra = {}) {
  const header = oauth.toHeader(oauth.authorize({ url, method }, token));
  header.Authorization += `, realm="${accountId}"`;
  return { ...header, ...extra };
}

const restBase = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/record/v1`;
const suiteqlUrl = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

async function suiteql(q) {
  const res = await fetch(suiteqlUrl, {
    method: 'POST',
    headers: signedHeaders(suiteqlUrl, 'POST', { 'Content-Type': 'application/json', Prefer: 'transient' }),
    body: JSON.stringify({ q }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SuiteQL HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text).items || [];
}
async function getRecord(type, id) {
  const url = `${restBase}/${type}/${id}?expandSubResources=true`;
  const res = await fetch(url, { headers: signedHeaders(url, 'GET') });
  return { status: res.status, body: await res.text() };
}
async function deleteRecord(type, id) {
  const url = `${restBase}/${type}/${id}`;
  const res = await fetch(url, { method: 'DELETE', headers: signedHeaders(url, 'DELETE') });
  return { status: res.status, body: await res.text() };
}

// ── Orderful-side cleanup (optional) ──
// When an error OT actually reached Orderful it carries an orderful_id pointing at a
// transaction on the platform. Orderful lets you delete a transaction ONLY while it is
// unsent (deliveryStatus PENDING). The keeper's transaction is never in the delete set.
const ORDERFUL_API_KEY = process.env.ORDERFUL_API_KEY;
const ORDERFUL_ORG_ID = process.env.ORDERFUL_ORG_ID;
const orderfulEnabled = !!ORDERFUL_API_KEY && !!ORDERFUL_ORG_ID;
const ofHeaders = { 'orderful-api-key': ORDERFUL_API_KEY, 'X-ActingOrgId': String(ORDERFUL_ORG_ID), accept: 'application/json' };
async function getOrderfulTx(id) {
  const r = await fetch(`https://api.orderful.com/v3/transactions/${id}`, { headers: ofHeaders });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}
async function deleteOrderfulTx(id) {
  // Non-org-scoped path + X-ActingOrgId header; the org-scoped path returns 403 for deletes.
  const r = await fetch(`https://api.orderful.com/v2/transactions/${id}`, { method: 'DELETE', headers: ofHeaders });
  return { status: r.status, body: await r.text() };
}

console.log(`Cleanup Orderful Transactions for source #${sourceId} — ${customerLabel} (ENVIRONMENT=${envMode})`);
console.log(apply ? 'MODE: APPLY (will delete)\n' : 'MODE: dry-run (no changes — pass --apply to delete)\n');

// ── Step 1: enumerate every OT in the consolidation group(s) linked to this source ──
// Find the consolidation keys this source feeds (via the join table), then pull ALL OTs in
// those keys with a LEFT JOIN to the join table — so join-less orphans are caught too, and
// each OT's full set of join rows is visible (to detect consolidations spanning sources).
const rows = await suiteql(`
  SELECT
    ot.id AS ot_id,
    j.id AS join_id,
    j.custrecord_orderful_netsuite_transaction AS join_source,
    s.scriptid AS status_scriptid,
    BUILTIN.DF(ot.custrecord_ord_tran_status) AS status_label,
    ot.custrecord_ord_tran_orderful_id AS orderful_id,
    ot.custrecord_orderful_consolidation_key AS ckey,
    ot.custrecord_ord_tran_testmode AS testmode,
    BUILTIN.DF(ot.custrecord_ord_tran_document) AS doc
  FROM ${OT_TYPE} ot
  LEFT JOIN ${JOIN_TYPE} j ON j.custrecord_orderful_edi_document = ot.id
  JOIN customlist_orderful_transaction_status s ON s.id = ot.custrecord_ord_tran_status
  WHERE ot.custrecord_orderful_consolidation_key IN (
    SELECT ot2.custrecord_orderful_consolidation_key
    FROM ${OT_TYPE} ot2
    JOIN ${JOIN_TYPE} j2 ON j2.custrecord_orderful_edi_document = ot2.id
    WHERE j2.custrecord_orderful_netsuite_transaction = ${Number(sourceId)}
  )
  ORDER BY ot.custrecord_orderful_consolidation_key, ot.id
`);

if (rows.length === 0) {
  console.log(`No Orderful Transaction records are linked to source #${sourceId}. Nothing to clean up.`);
  process.exit(0);
}

// Collapse the LEFT JOIN fan-out: one entry per OT, with the set of join ids + source txns it links to.
const ots = new Map();
for (const r of rows) {
  const id = String(r.ot_id);
  if (!ots.has(id)) {
    ots.set(id, {
      ot_id: id,
      status: String(r.status_scriptid || '').toUpperCase(),
      statusLabel: r.status_label || r.status_scriptid,
      orderfulId: r.orderful_id || null,
      ckey: r.ckey,
      testmode: r.testmode,
      doc: r.doc,
      joins: new Map(), // join_id -> source txn id
    });
  }
  if (r.join_id != null) ots.get(id).joins.set(String(r.join_id), String(r.join_source));
}

// Group by consolidation key.
const groups = new Map();
for (const ot of ots.values()) {
  if (!groups.has(ot.ckey)) groups.set(ot.ckey, []);
  groups.get(ot.ckey).push(ot);
}

const toDeleteOts = [];
const toDeleteJoins = new Set();
for (const [ckey, members] of groups) {
  const keepers = members.filter((m) => m.status === STATUS_SUCCESS);
  const errors = members.filter((m) => m.status === STATUS_ERROR);

  console.log(`Consolidation key: ${ckey}  (${members[0].doc})`);
  for (const m of members) {
    const tag = m.status === STATUS_SUCCESS ? 'KEEP (Success)'
      : m.status === STATUS_ERROR ? 'error'
      : `skip (${m.statusLabel})`;
    console.log(`  OT ${m.ot_id}  [${m.statusLabel}] testmode=${m.testmode} orderfulId=${m.orderfulId || '-'} joins=${[...m.joins.keys()].join(',') || '-'}  -> ${tag}`);
  }

  if (keepers.length === 0) {
    console.log('  ⚠ No Success keeper in this group — refusing to delete the only attempt(s). Skipping.\n');
    continue;
  }
  if (keepers.length > 1) {
    console.log(`  ⚠ ${keepers.length} Success records in this group — ambiguous. Skipping (resolve manually).\n`);
    continue;
  }
  for (const e of errors) {
    const otherSources = [...e.joins.values()].filter((s) => s !== String(sourceId));
    if (otherSources.length > 0) {
      console.log(`  ⚠ OT ${e.ot_id} also links to other source txn(s) ${otherSources.join(',')} (consolidation) — skipping for safety.`);
      continue;
    }
    toDeleteOts.push(e);
    for (const jid of e.joins.keys()) toDeleteJoins.add(jid);
  }
  console.log('');
}

if (toDeleteOts.length === 0) {
  console.log('Nothing safe to delete. (No Error duplicates with a Success sibling, or all were skipped.)');
  process.exit(0);
}

console.log(`Plan (NetSuite): delete ${toDeleteJoins.size} join row(s) then ${toDeleteOts.length} OT record(s):`);
console.log(`  joins: ${[...toDeleteJoins].join(', ') || '(none)'}`);
console.log(`  OTs:   ${toDeleteOts.map((o) => o.ot_id).join(', ')}`);

// Orderful-side: error OTs that reached the platform carry an orderful_id. Plan to delete
// each one that is still unsent (deliveryStatus PENDING). The keeper's transaction (Success)
// is never in this set, so it is never at risk.
const orderfulTargets = toDeleteOts.filter((o) => o.orderfulId).map((o) => ({ ot_id: o.ot_id, orderfulId: String(o.orderfulId) }));
console.log('\nPlan (Orderful):');
if (orderfulTargets.length === 0) {
  console.log('  none of the OTs reached Orderful (no orderful_id) — nothing to delete on the platform.');
} else if (!orderfulEnabled) {
  console.log(`  ${orderfulTargets.length} transaction(s) reached Orderful but ORDERFUL_API_KEY/ORDERFUL_ORG_ID are not set — skipping platform cleanup.`);
  orderfulTargets.forEach((t) => console.log(`    OT ${t.ot_id} -> Orderful ${t.orderfulId}`));
} else {
  for (const t of orderfulTargets) {
    const tx = await getOrderfulTx(t.orderfulId);
    if (tx.status !== 200) { console.log(`  Orderful ${t.orderfulId} (OT ${t.ot_id}) -> HTTP ${tx.status}, already gone or inaccessible — skip`); t.skip = true; continue; }
    t.deliveryStatus = tx.body.deliveryStatus;
    t.validationStatus = tx.body.validationStatus;
    const deletable = tx.body.deliveryStatus === 'PENDING';
    t.skip = !deletable;
    console.log(`  Orderful ${t.orderfulId} (OT ${t.ot_id}) -> ${tx.body.validationStatus}/${tx.body.deliveryStatus}  ${deletable ? '-> delete (unsent)' : '-> SKIP (sent/undeletable)'}`);
  }
}

if (!apply) {
  console.log('\nDry-run only. Re-run with --apply to perform the deletion.');
  if (envMode === 'production') console.log('NOTE: ENVIRONMENT=production — confirm with the customer/owner before applying.');
  process.exit(0);
}

// ── Step 2: back up, then delete (joins first, then OTs) ──
const backup = { capturedAt: new Date().toISOString(), account: accountId, env: envMode, sourceId, deleted: { joins: [], ots: [] } };
for (const jid of toDeleteJoins) {
  const g = await getRecord(JOIN_TYPE, jid);
  backup.deleted.joins.push({ id: jid, record: safeParse(g.body) });
}
for (const o of toDeleteOts) {
  const g = await getRecord(OT_TYPE, o.ot_id);
  backup.deleted.ots.push({ id: o.ot_id, record: safeParse(g.body) });
}
const backupPath = resolve(customerDir, `cleanup-backup-${sourceId}-${backup.capturedAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(`\nBacked up ${backup.deleted.joins.length} join(s) + ${backup.deleted.ots.length} OT(s) -> ${backupPath}\n`);

console.log('Deleting join rows...');
for (const jid of toDeleteJoins) {
  const r = await deleteRecord(JOIN_TYPE, jid);
  console.log(`  join ${jid}: HTTP ${r.status}${r.status >= 400 ? '  ' + r.body.slice(0, 200) : ''}`);
  if (r.status >= 400) { console.error('Aborting before deleting OTs — joins are in a partial state; review the backup.'); process.exit(1); }
}
console.log('Deleting OT records...');
for (const o of toDeleteOts) {
  const r = await deleteRecord(OT_TYPE, o.ot_id);
  console.log(`  OT ${o.ot_id}: HTTP ${r.status}${r.status >= 400 ? '  ' + r.body.slice(0, 200) : ''}`);
  if (r.status >= 400) process.exit(1);
}

// ── Step 3: verify ──
const after = await suiteql(`
  SELECT ot.id AS ot_id, s.scriptid AS status_scriptid, ot.custrecord_ord_tran_orderful_id AS orderful_id
  FROM ${OT_TYPE} ot
  JOIN customlist_orderful_transaction_status s ON s.id = ot.custrecord_ord_tran_status
  WHERE ot.custrecord_orderful_consolidation_key IN (${[...groups.keys()].map((k) => `'${k.replace(/'/g, "''")}'`).join(',')})
  ORDER BY ot.id
`);
const deletedIds = new Set(toDeleteOts.map((o) => o.ot_id));
const stillThere = after.filter((r) => deletedIds.has(String(r.ot_id)));
console.log('\nRemaining OTs in the affected group(s):');
for (const r of after) console.log(`  OT ${r.ot_id}  [${String(r.status_scriptid).toLowerCase()}]  orderfulId=${r.orderful_id || '-'}`);
console.log(stillThere.length === 0
  ? '✓ NetSuite: targeted Error duplicates removed; keeper(s) intact.'
  : `✗ ${stillThere.length} targeted OT(s) still present — review above.`);

// ── Step 4: Orderful-side deletion (unsent strays only) ──
if (orderfulEnabled) {
  const live = orderfulTargets.filter((t) => !t.skip);
  if (live.length > 0) {
    console.log('\nDeleting unsent Orderful transactions...');
    for (const t of live) {
      const recheck = await getOrderfulTx(t.orderfulId); // re-confirm still unsent right before deleting
      if (recheck.status !== 200) { console.log(`  Orderful ${t.orderfulId}: HTTP ${recheck.status} — already gone, skipping`); continue; }
      if (recheck.body.deliveryStatus !== 'PENDING') { console.log(`  Orderful ${t.orderfulId}: now ${recheck.body.deliveryStatus} — not unsent, skipping`); continue; }
      const d = await deleteOrderfulTx(t.orderfulId);
      console.log(`  Orderful ${t.orderfulId}: DELETE HTTP ${d.status}${d.status >= 400 ? '  ' + d.body.slice(0, 160) : ''}`);
    }
  }
}

console.log('\n✓ Cleanup complete.');

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }
