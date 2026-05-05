#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Reprocess a single inbound Orderful Transaction by POSTing
// { action: 'reprocessTransaction', recordId: <id> } to the SuiteApp's
// agent-write RESTlet. Pre-checks the transaction's current status via
// SuiteQL and refuses if reprocessing would be a no-op or harmful.
//
// Usage:
//   node reprocess-transaction.mjs <customer-dir> <transaction-id>

import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const SCRIPT_ID = 'customscript_orderful_agent_write_rl';
const DEPLOY_ID = 'customdeploy_orderful_agent_write_rl';

// Status scriptids from OrderfulTransactionStatus (Models/orderful_transaction.ts)
// SuiteQL returns these uppercase, hence the .toUpperCase() comparisons below.
const STATUS = {
  SUCCESS: 'TRANSACTION_STATUS_SUCCESS',
  PENDING: 'TRANSACTION_STATUS_PENDING',
  PENDING_CUSTOM_PROCESS: 'TRANSACTION_STATUS_PENDING_CUST_PROCESS',
  ERROR: 'TRANSACTION_STATUS_ERROR',
  AWAITING_SIBLINGS: 'TRANSACTION_STATUS_AWAITING_SIBLINGS',
  IGNORE: 'TRANSACTION_STATUS_DO_NOT_PROCESS',
  READY_TO_SEND: 'TRANSACTION_STATUS_READY_TO_SEND',
  STALE: 'TRANSACTION_STATUS_STALE',
};

// Status guard — see SKILL.md "Status guard" section for the rationale.
const REFUSE = new Set([
  STATUS.SUCCESS,
  STATUS.IGNORE,
  STATUS.PENDING_CUSTOM_PROCESS,
  STATUS.READY_TO_SEND,
]);
const WARN = new Set([STATUS.PENDING, STATUS.AWAITING_SIBLINGS]);

const customerDir = process.argv[2];
const transactionId = process.argv[3];

if (!customerDir || !transactionId) {
  console.error('Usage: node reprocess-transaction.mjs <customer-dir> <transaction-id>');
  process.exit(2);
}

if (!/^\d+$/.test(transactionId)) {
  console.error(`Transaction ID must be a positive integer (got "${transactionId}")`);
  console.error('Hint: this is the NetSuite internal ID, not the Orderful UUID.');
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
// Sandbox/RP account IDs use underscores in the ID (1234567_SB1) but hyphens in URL hosts.
const urlHost = accountId.replace(/_/g, '-').toLowerCase();

const customerLabel = process.env.CUSTOMER_NAME || process.env.CUSTOMER_SLUG || customerDir;
console.log(`Reprocess transaction ${transactionId} for: ${customerLabel} (ENVIRONMENT=${envMode})\n`);

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

// ────────────────────────────────────────────────────────────────────────────
// Step 1: SuiteQL status lookup
// ────────────────────────────────────────────────────────────────────────────

const suiteqlUrl = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

const statusQuery = `
  SELECT
    s.scriptid AS status_scriptid,
    BUILTIN.DF(t.custrecord_ord_tran_status) AS status_label,
    BUILTIN.DF(t.custrecord_ord_tran_direction) AS direction_label
  FROM customrecord_orderful_transaction t
  JOIN customlist_orderful_transaction_status s
    ON s.id = t.custrecord_ord_tran_status
  WHERE t.id = ${Number(transactionId)}
`;

let statusRes;
try {
  statusRes = await fetch(suiteqlUrl, {
    method: 'POST',
    headers: signedHeaders(suiteqlUrl, 'POST', {
      'Content-Type': 'application/json',
      Prefer: 'transient',
    }),
    body: JSON.stringify({ q: statusQuery }),
  });
} catch (error) {
  console.error('FAIL: Could not query NetSuite for the transaction status.');
  console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const statusText = await statusRes.text();
if (!statusRes.ok) {
  console.error(`FAIL: SuiteQL status lookup returned HTTP ${statusRes.status}`);
  console.error(statusText.slice(0, 500));
  process.exit(1);
}

let statusBody;
try { statusBody = JSON.parse(statusText); } catch { statusBody = null; }

const row = statusBody?.items?.[0];
if (!row) {
  console.error(`FAIL: No customrecord_orderful_transaction row found with id=${transactionId}.`);
  console.error('Hint: this is the NetSuite internal ID, not the Orderful UUID.');
  process.exit(1);
}

const statusScriptId = String(row.status_scriptid || '').toUpperCase();
const statusLabel = row.status_label || statusScriptId;
const directionLabel = row.direction_label || '(unknown)';

console.log(`Current status: ${statusLabel} (${statusScriptId.toLowerCase()})`);
console.log(`Direction:      ${directionLabel}\n`);

if (REFUSE.has(statusScriptId)) {
  console.error(`REFUSED: Status is "${statusLabel}" — refusing to reprocess.`);
  console.error('See SKILL.md "Status guard" for why each status is refused.');
  console.error('If you genuinely need to reprocess, change the status in NS first.');
  process.exit(3);
}

if (WARN.has(statusScriptId)) {
  console.log(`WARNING: Status is "${statusLabel}" — reprocess will run, but may be redundant or unhelpful.`);
  console.log('Proceeding anyway. See SKILL.md "Status guard" for details.\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2: Call agent-write RESTlet → reprocessTransaction
// ────────────────────────────────────────────────────────────────────────────

const restletUrl = `https://${urlHost}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${SCRIPT_ID}&deploy=${DEPLOY_ID}`;
const requestBody = JSON.stringify({
  action: 'reprocessTransaction',
  recordId: Number(transactionId),
});

let res;
let text;
try {
  res = await fetch(restletUrl, {
    method: 'POST',
    headers: signedHeaders(restletUrl, 'POST', { 'Content-Type': 'application/json' }),
    body: requestBody,
  });
  text = await res.text();
} catch (error) {
  console.error('FAIL: Unable to call the agent-write RESTlet.');
  console.error(`URL: ${restletUrl}`);
  console.error(`Request error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let body;
try { body = JSON.parse(text); } catch { body = text; }
const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

const isSuccess = res.ok && body && typeof body === 'object' && body.status === 'success';
const isEndpointError = res.ok && body && typeof body === 'object' && body.status === 'error';
const isMissingEndpoint =
  res.status === 404 ||
  bodyStr.includes('SSS_INVALID_SCRIPTLET_ID') ||
  bodyStr.includes('INVALID_LOGIN_INVALID_SCRIPT_ID');

if (isSuccess) {
  console.log('SUCCESS');
  console.log(JSON.stringify(body, null, 2));
  console.log('');
  console.log(`Transaction ${transactionId} is queued for reprocessing.`);
  console.log('Check NetSuite: Customization > Scripting > Map/Reduce Script Status');
  console.log('  → look for the most recent run of customscript_orderful_transaction_mr');
  process.exit(0);
}

if (isMissingEndpoint) {
  console.error('FAIL: agent-write RESTlet not found in this NetSuite account.');
  console.error("The customer's SuiteApp version may not include this endpoint yet (NS-926).");
  console.error('Fall back: click "Reprocess" on the transaction record in the NS UI.');
  console.error('');
  console.error(`Response (${res.status}): ${bodyStr.slice(0, 400)}`);
  process.exit(1);
}

if (isEndpointError) {
  console.error('ENDPOINT REPORTED ERROR');
  console.error(JSON.stringify(body, null, 2));
  console.error('');
  if (bodyStr.includes('INSUFFICIENT_PERMISSION') && bodyStr.includes('Orderful Transaction')) {
    console.error('Hint: role likely missing "Custom Record Entries" = Edit on the Lists subtab.');
    console.error('See SKILL.md "Required role permissions".');
  } else if (bodyStr.includes('INSUFFICIENT_PERMISSION')) {
    console.error('Hint: role likely missing "SuiteScript Scheduling" on the Setup subtab.');
    console.error('See SKILL.md "Required role permissions".');
  }
  process.exit(1);
}

console.error(`FAIL (HTTP ${res.status})`);
console.error(typeof body === 'string' ? body.slice(0, 1000) : JSON.stringify(body, null, 2));
process.exit(1);
