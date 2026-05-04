#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Validate NetSuite TBA + Orderful API credentials for an onboarding customer.
//
// Usage:
//   node test-connections.mjs <customer-dir>
//
// Where <customer-dir> contains a .env populated from env-template.env.
// Reads ENVIRONMENT (sandbox|production) and uses the matching
// NS_SB_* or NS_PROD_* credential block.

import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const customerDir = process.argv[2];
if (!customerDir) {
  console.error('Usage: node test-connections.mjs <customer-dir>');
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
  'ORDERFUL_API_KEY',
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

const customerLabel = process.env.CUSTOMER_NAME || process.env.CUSTOMER_SLUG || customerDir;
console.log(`Testing credentials for: ${customerLabel} (ENVIRONMENT=${envMode})\n`);

let nsPass = false;
let ofPass = false;
let rlPass = false;

// ---------- NetSuite ----------

async function testNetSuite() {
  const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
  // Sandbox/RP account IDs use underscores in the ID (1234567_SB1) but hyphens in the URL host (1234567-sb1).
  const urlHost = accountId.replace(/_/g, '-').toLowerCase();
  const baseUrl = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

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
  const requestData = { url: baseUrl, method: 'POST' };
  const authHeader = oauth.toHeader(oauth.authorize(requestData, token));
  authHeader.Authorization += `, realm="${accountId}"`;

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q: 'SELECT TOP 1 id FROM transaction' }),
  });

  if (res.ok) {
    nsPass = true;
    console.log(`  NetSuite  PASS  (${res.status}, account ${accountId})`);
    return;
  }

  const text = await res.text();
  console.log(`  NetSuite  FAIL  (${res.status})`);
  console.log(`            URL: ${baseUrl}`);
  console.log(`            Response: ${text.slice(0, 400)}`);
}

// ---------- SuiteApp agent-write RESTlet ----------
//
// Probes the SuiteApp's agent-write RESTlet with an unknown action to validate:
//   1. The RESTlet is deployed (SuiteApp version is current — i.e. NS-926)
//   2. The token's role has SuiteScript=Full (the script can execute)
//
// Sending a known action like `triggerInboundPolling` has side effects (it
// kicks off the polling MapReduce), so we use a sentinel action the RESTlet
// rejects with `{ status: 'error', message: 'Unknown action' }`. Reaching that
// branch means the script ran to completion under this token's role.
//
// This does NOT validate the `SuiteScript Scheduling` permission — that's only
// exercised when the RESTlet calls `task.create()`. Skills that trigger
// MapReduce jobs (e.g. `/run-poller`) will surface that perm gap on first use
// with a clear `INSUFFICIENT_PERMISSION` response.

async function testRestlet() {
  const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
  const urlHost = accountId.replace(/_/g, '-').toLowerCase();
  const url = `https://${urlHost}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_orderful_agent_write_rl&deploy=customdeploy_orderful_agent_write_rl`;

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
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  authHeader.Authorization += `, realm="${accountId}"`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: '__connection_probe__' }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

  // Endpoint missing — old SuiteApp version
  if (res.status === 404 || bodyStr.includes('SSS_INVALID_SCRIPTLET_ID')) {
    console.log(`  RESTlet   FAIL  (404 — endpoint not found)`);
    console.log(`            The SuiteApp on this account predates NS-926. Upgrade via My SuiteApps`);
    console.log(`            to the version that includes the agent-write RESTlet.`);
    return;
  }

  // Permission missing — role lacks SuiteScript=Full
  if (bodyStr.includes('INSUFFICIENT_PERMISSION') && bodyStr.includes("'SuiteScript'")) {
    console.log(`  RESTlet   FAIL  (INSUFFICIENT_PERMISSION — missing SuiteScript permission)`);
    console.log(`            Add SuiteScript = Full on the role's Setup tab. See`);
    console.log(`            INTEGRATION-RECORD-SETUP.md "Required role permissions".`);
    return;
  }

  // Expected success path: RESTlet handled the request and rejected the unknown action
  if (
    res.ok &&
    body &&
    typeof body === 'object' &&
    body.status === 'error' &&
    typeof body.message === 'string' &&
    body.message.toLowerCase().includes('unknown action')
  ) {
    rlPass = true;
    console.log(`  RESTlet   PASS  (agent-write reachable, role has SuiteScript permission)`);
    return;
  }

  // Something else happened — show enough to diagnose
  console.log(`  RESTlet   FAIL  (HTTP ${res.status})`);
  console.log(`            URL: ${url}`);
  console.log(`            Response: ${bodyStr.slice(0, 400)}`);
}

// ---------- Orderful ----------

async function testOrderful() {
  // Orderful only has one API endpoint — api.orderful.com — regardless of
  // which NetSuite environment we're onboarding against. There is no
  // api-sandbox.orderful.com in the production sense; keys are global.
  const base = 'https://api.orderful.com';
  // Use a limit=1 list call as an auth proof. 2xx/4xx (not 401) both prove the key is recognized.
  const url = `${base}/v3/transactions?limit=1`;

  const res = await fetch(url, {
    headers: { 'orderful-api-key': process.env.ORDERFUL_API_KEY },
  });

  if (res.status === 401 || res.status === 403) {
    console.log(`  Orderful  FAIL  (${res.status})`);
    const text = await res.text();
    console.log(`            URL: ${url}`);
    console.log(`            Response: ${text.slice(0, 400)}`);
    return;
  }

  if (res.ok) {
    ofPass = true;
    console.log(`  Orderful  PASS  (${res.status})`);
    return;
  }

  // Non-auth error (e.g., 400 for missing params) — treat as auth-works-but-endpoint-quirky.
  ofPass = true;
  console.log(`  Orderful  PASS  (${res.status} — non-auth error; key accepted)`);
}

// ---------- Run ----------

console.log('Results:');
await testNetSuite().catch((e) => console.log(`  NetSuite  ERROR  ${e.message}`));
await testRestlet().catch((e) => console.log(`  RESTlet   ERROR  ${e.message}`));
await testOrderful().catch((e) => console.log(`  Orderful  ERROR  ${e.message}`));

console.log('');
if (nsPass && ofPass && rlPass) {
  console.log('All checks passed. You\'re good to go.');
  process.exit(0);
}
if (nsPass && ofPass && !rlPass) {
  console.log('TBA + Orderful credentials work, but the SuiteApp RESTlet check failed.');
  console.log('Skills like /run-poller that hit the agent-write RESTlet will not work');
  console.log('until that\'s fixed. See the failure detail above.');
  process.exit(1);
}
console.log('One or more connections failed. See SKILL.md Step 5 for troubleshooting.');
process.exit(1);
