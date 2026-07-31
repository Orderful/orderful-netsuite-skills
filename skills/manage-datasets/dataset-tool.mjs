#!/usr/bin/env node
// Driver for the Orderful Dataset Lab RESTlet (customscript_orderful_dataset_lab_rl).
//
// Customer selection: --customer <slug> or CUSTOMER=<slug>; reads TBA creds from
// ~/orderful-onboarding/<slug>/.env (the netsuite-setup convention).
//
// NetSuite has no REST endpoint for datasets, so this talks to a RESTlet that wraps
// N/dataset. describe -> edit -> dryRun -> save is the intended loop; dryRun never
// persists anything.
//
//   node dataset-tool.mjs --customer acme-foods list
//   node dataset-tool.mjs --customer acme-foods describe custdataset_some_existing_dataset
//   node dataset-tool.mjs --customer acme-foods run custdataset123 --limit 20 --fulfillment 4567890
//   node dataset-tool.mjs --customer acme-foods dry-run specs/my-dataset.json --limit 20
//   node dataset-tool.mjs --customer acme-foods save specs/my-dataset.json --yes
//   node dataset-tool.mjs --customer acme-foods raw request-body.json
//
// NS_ENV=sandbox|production (default: sandbox)
import { config as loadEnv } from 'dotenv';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const customerFlagIndex = process.argv.indexOf('--customer');
const customer =
  (customerFlagIndex !== -1 ? process.argv.splice(customerFlagIndex, 2)[1] : undefined) ||
  process.env.CUSTOMER;
if (!customer) {
  console.error('Missing customer slug: pass --customer <slug> or set CUSTOMER=<slug>');
  process.exit(2);
}
loadEnv({ path: resolve(process.env.HOME, `orderful-onboarding/${customer}/.env`) });

const SCRIPT_ID = process.env.DATASET_LAB_SCRIPT_ID || 'customscript_orderful_dataset_lab_rl';
const DEPLOY_ID = process.env.DATASET_LAB_DEPLOY_ID || 'customdeploy_orderful_dataset_lab_rl';

const envChoice = (process.env.NS_ENV || 'sandbox').toLowerCase();
const nsPrefix = envChoice === 'production' ? 'NS_PROD' : 'NS_SB';
const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
if (!accountId) {
  console.error(`Missing ${nsPrefix}_ACCOUNT_ID in the customer .env`);
  process.exit(2);
}
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const url = `https://${urlHost}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${SCRIPT_ID}&deploy=${DEPLOY_ID}`;

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

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const readSpec = (path) => {
  if (!path) {
    console.error('Expected a path to a JSON spec file.');
    process.exit(2);
  }
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
};

const [command, arg] = process.argv.slice(2);
const limit = flag('limit') ? Number(flag('limit')) : undefined;

let body;
switch (command) {
  case 'list':
    body = { action: 'list' };
    break;
  case 'describe':
    body = { action: 'describe', id: arg };
    break;
  case 'run':
    body = { action: 'run', id: arg, limit };
    // Simulates what the SuiteApp does at runtime: AND its own Fulfillment filter onto
    // whatever condition the dataset already carries. Use this to check a dataset behaves
    // for a real fulfillment, not just when run bare.
    if (flag('fulfillment')) {
      body.condition = {
        columnLabel: 'Fulfillment',
        operator: 'ANY_OF',
        values: [Number(flag('fulfillment'))],
      };
    }
    break;
  case 'dry-run':
  case 'dryRun':
    body = { action: 'dryRun', spec: readSpec(arg), limit };
    break;
  case 'validate':
    body = arg && arg.endsWith('.json')
      ? { action: 'validate', spec: readSpec(arg) }
      : { action: 'validate', id: arg };
    break;
  case 'raw':
    // Post an arbitrary request body from a JSON file — escape hatch for actions the
    // named commands don't wrap (e.g. probeJoins).
    body = readSpec(arg);
    break;
  case 'patch': {
    // dataset-tool.mjs patch <datasetScriptId> <patch.json> [--dry-run] [--yes]
    const patch = readSpec(process.argv[4]);
    body = { action: 'patch', id: arg, ...patch, limit };
    if (hasFlag('dry-run')) {
      body.dryRun = true;
    } else if (!hasFlag('yes')) {
      console.error(
        `Refusing to patch without --yes.\n` +
        `  target  : ${nsPrefix} ${accountId}\n` +
        `  dataset : ${arg}\n` +
        `  patch   : ${process.argv[4]}\n` +
        `Run with --dry-run first, then re-run with --yes.`,
      );
      process.exit(2);
    }
    break;
  }
  case 'save': {
    const spec = readSpec(arg);
    if (!hasFlag('yes')) {
      console.error(
        `Refusing to save without --yes.\n` +
        `  target : ${nsPrefix} ${accountId}\n` +
        `  spec   : ${arg}\n` +
        `  id     : ${spec.id || '(none — NetSuite will assign one)'}\n` +
        `  name   : ${spec.name || '(none)'}\n` +
        `Run 'dry-run' first, then re-run with --yes.`,
      );
      process.exit(2);
    }
    body = { action: 'save', spec };
    break;
  }
  default:
    console.error(
      'Usage: dataset-tool.mjs <list|describe|run|dry-run|validate|save> [id|spec.json] [--limit N] [--yes]',
    );
    process.exit(2);
}

const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
authHeader.Authorization += `, realm="${accountId}"`;

const res = await fetch(url, {
  method: 'POST',
  headers: { ...authHeader, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const text = await res.text();
console.error(`# ${nsPrefix} ${accountId} — ${command} — HTTP ${res.status}`);

if (!res.ok) {
  console.error(text);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  console.log(text);
  process.exit(0);
}

console.log(JSON.stringify(parsed, null, 2));
// ok:false is an application-level failure the RESTlet reports with HTTP 200.
if (parsed && parsed.ok === false) process.exit(1);
