#!/usr/bin/env node
// Trigger Orderful inbound polling MR via the SuiteApp's run-poller RESTlet.
//
// Usage:
//   node run-poller.mjs <customer-dir>
//
// Where <customer-dir> contains a .env populated by the netsuite-setup skill.

import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const SCRIPT_ID = 'customscript_orderful_run_poller_rl';
const DEPLOY_ID = 'customdeploy_orderful_run_poller_rl';

const customerDir = process.argv[2];
if (!customerDir) {
  console.error('Usage: node run-poller.mjs <customer-dir>');
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
const url = `https://${urlHost}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${SCRIPT_ID}&deploy=${DEPLOY_ID}`;

const customerLabel = process.env.CUSTOMER_NAME || process.env.CUSTOMER_SLUG || customerDir;
console.log(`Triggering inbound poller for: ${customerLabel} (ENVIRONMENT=${envMode})`);
console.log(`URL: ${url}\n`);

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
const requestData = { url, method: 'GET' };
const authHeader = oauth.toHeader(oauth.authorize(requestData, token));
authHeader.Authorization += `, realm="${accountId}"`;

let res;
let text;
try {
  res = await fetch(url, { method: 'GET', headers: { ...authHeader } });
  text = await res.text();
} catch (error) {
  console.error('FAIL: Unable to call the run-poller RESTlet.');
  console.error(`URL: ${url}`);
  console.error(
    `Request error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}

const isSuccess =
  res.ok && body && typeof body === 'object' && body.status === 'success';
const isEndpointReportedError =
  res.ok && body && typeof body === 'object' && body.status === 'error';
const isMissingEndpoint =
  res.status === 404 ||
  (typeof body === 'string' && body.includes('INVALID_LOGIN_INVALID_SCRIPT_ID')) ||
  (body && typeof body === 'object' && JSON.stringify(body).includes('INVALID_LOGIN_INVALID_SCRIPT_ID'));

if (isSuccess) {
  console.log('SUCCESS');
  console.log(JSON.stringify(body, null, 2));
  console.log('');
  console.log(`Task ${body.taskId} is ${body.mrStatus}.`);
  console.log(
    'Check NetSuite: Customization > Scripting > Script Deployments > "Orderful | Polling Inbound Transactions" > Execution Log',
  );
  process.exit(0);
}

if (isEndpointReportedError) {
  console.error('ENDPOINT REPORTED ERROR');
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

if (isMissingEndpoint) {
  console.error('FAIL: run-poller RESTlet not found in this NetSuite account.');
  console.error("The customer's SuiteApp version may not include this endpoint yet (NS-926).");
  console.error('See SKILL.md Step 4 for the version-mismatch fallback.');
  console.error('');
  console.error(
    `Response (${res.status}): ${typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)}`,
  );
  process.exit(1);
}

console.error(`FAIL (HTTP ${res.status})`);
console.error(typeof body === 'string' ? body.slice(0, 1000) : JSON.stringify(body, null, 2));
process.exit(1);
