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
await testOrderful().catch((e) => console.log(`  Orderful  ERROR  ${e.message}`));

console.log('');
if (nsPass && ofPass) {
  console.log('Both systems are reachable. You\'re good to go.');
  process.exit(0);
}
console.log('One or more connections failed. See SKILL.md Step 5 for troubleshooting.');
process.exit(1);
