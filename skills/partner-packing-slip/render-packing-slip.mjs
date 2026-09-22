#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.

// Render a packing slip PDF for an Item Fulfillment using a specific Advanced
// PDF/HTML template, and save it locally.
//
//   node render-packing-slip.mjs <customer-slug> <fulfillmentId> <templateId> <out.pdf>
//
// Requires assets/orderful_renderPackingSlip_RL.js to be deployed in the
// customer's account (see the skill's "Known gap" section).

import { config as loadEnv } from 'dotenv';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const SCRIPT_ID = 'customscript_orderful_render_packslip_rl';
const DEPLOY_ID = 'customdeploy_orderful_render_packslip_rl';

const [slug, fulfillmentId, templateId, out] = process.argv.slice(2);
if (!slug || !fulfillmentId || !templateId || !out) {
  console.error(
    'usage: render-packing-slip.mjs <customer-slug> <fulfillmentId> <templateId> <out.pdf>',
  );
  process.exit(2);
}

const envPath = resolve(process.env.HOME, 'orderful-onboarding', slug, '.env');
if (!existsSync(envPath)) {
  console.error(`No .env for "${slug}" at ${envPath} — run /netsuite-setup first.`);
  process.exit(2);
}
loadEnv({ path: envPath, quiet: true });

const prefix = (process.env.ENVIRONMENT || 'sandbox').toLowerCase() === 'production'
  ? 'NS_PROD'
  : 'NS_SB';
const account = process.env[`${prefix}_ACCOUNT_ID`];
if (!account) {
  console.error(`${prefix}_ACCOUNT_ID is not set in ${envPath}.`);
  process.exit(2);
}

const host = account.replace(/_/g, '-').toLowerCase();
const url =
  `https://${host}.restlets.api.netsuite.com/app/site/hosting/restlet.nl` +
  `?script=${SCRIPT_ID}&deploy=${DEPLOY_ID}`;

const oauth = new OAuth({
  consumer: {
    key: process.env[`${prefix}_CONSUMER_KEY`],
    secret: process.env[`${prefix}_CONSUMER_SECRET`],
  },
  signature_method: 'HMAC-SHA256',
  hash_function(base, key) {
    return crypto.createHmac('sha256', key).update(base).digest('base64');
  },
});

const token = {
  key: process.env[`${prefix}_TOKEN_ID`],
  secret: process.env[`${prefix}_TOKEN_SECRET`],
};

const headers = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
headers.Authorization += `, realm="${account}"`;
headers['Content-Type'] = 'application/json';

const response = await fetch(url, {
  method: 'POST',
  headers,
  body: JSON.stringify({ fulfillmentId, templateId }),
});

const body = await response.json();

if (body.status !== 'success') {
  console.error('Render failed:', JSON.stringify(body, null, 2));
  process.exit(1);
}

writeFileSync(out, Buffer.from(body.pdfBase64, 'base64'));
console.log(`Rendered fulfillment ${fulfillmentId} with template ${templateId} -> ${out}`);
