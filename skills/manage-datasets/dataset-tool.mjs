#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Drive the SuiteApp's dataset actions on the agent RESTlets (NS-1142).
// NetSuite exposes no REST API for SuiteAnalytics Datasets, so the SuiteApp
// wraps N/dataset in TransactionHandling/common/dataset.handlers.ts and exposes
// it through the existing agent surfaces:
//
//   agent-READ  (pure reads)  listDatasets, describeDataset, runDataset, dryRunDataset
//   agent-WRITE (persists)    saveDataset
//
// describe -> edit spec -> dry-run -> save is the intended loop. dryRun builds
// and executes an in-memory dataset via dataset.create() and never persists.
//
// The column contracts this reports against are NOT mirrored here — the SuiteApp
// validates with the same `columnConfigs` (Models/carton.ts) and `LabelFieldMap`
// its 856 and label paths match against, so the validation cannot drift from
// what the runtime actually accepts.
//
// Usage:
//   node dataset-tool.mjs <customer-dir> list
//   node dataset-tool.mjs <customer-dir> describe custdataset284
//   node dataset-tool.mjs <customer-dir> run custdataset284 --limit 20 --fulfillment 4567890
//   node dataset-tool.mjs <customer-dir> run custdataset284 --sales-order 491894
//   node dataset-tool.mjs <customer-dir> dry-run specs/my-dataset.json --limit 20
//   node dataset-tool.mjs <customer-dir> save specs/my-dataset.json --yes
//   node dataset-tool.mjs <customer-dir> raw request-body.json
//
// ENVIRONMENT=sandbox|production in the customer .env (default: sandbox).

import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const READ_SCRIPT_ID = 'customscript_orderful_agent_read_rl';
const READ_DEPLOY_ID = 'customdeploy_orderful_agent_read_rl';
const WRITE_SCRIPT_ID = 'customscript_orderful_agent_write_rl';
const WRITE_DEPLOY_ID = 'customdeploy_orderful_agent_write_rl';

const USAGE =
  'Usage: node dataset-tool.mjs <customer-dir> <list|describe|run|dry-run|save|raw> [id|spec.json]\n' +
  '       [--limit N] [--fulfillment <ifId>] [--sales-order <soId>] [--yes]';

// ────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ────────────────────────────────────────────────────────────────────────────

// Parse flags out of argv first, so they can appear anywhere and the remaining
// positionals are unambiguous. A flag whose value is absent or is itself a
// --flag is an error rather than a silent NaN/undefined.
const argv = process.argv.slice(2);
const flags = {};
const positionals = [];
const VALUE_FLAGS = new Set(['limit', 'fulfillment', 'sales-order']);
const BOOL_FLAGS = new Set(['yes']);

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith('--')) {
    positionals.push(arg);
    continue;
  }
  const name = arg.slice(2);
  if (BOOL_FLAGS.has(name)) {
    flags[name] = true;
  } else if (VALUE_FLAGS.has(name)) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`--${name} needs a value (got ${value === undefined ? 'nothing' : `"${value}"`}).`);
      process.exit(2);
    }
    flags[name] = value;
    i += 1;
  } else {
    console.error(`Unknown flag --${name}.\n${USAGE}`);
    process.exit(2);
  }
}

const [customerDir, command, arg] = positionals;
if (!customerDir || !command) {
  console.error(USAGE);
  process.exit(2);
}

const numericFlag = (name) => {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number (got "${flags[name]}").`);
    process.exit(2);
  }
  return value;
};

const limit = numericFlag('limit');
const fulfillmentId = numericFlag('fulfillment');
const salesOrderId = numericFlag('sales-order');

if (fulfillmentId && salesOrderId) {
  console.error(
    'Pass --fulfillment or --sales-order, not both. The SuiteApp filters on one\n' +
    'source column per run: SalesOrder when the caller asked for SO cartons,\n' +
    'otherwise Fulfillment (see carton.repository.ts, NS-689).',
  );
  process.exit(2);
}

const readSpec = (path) => {
  if (!path) {
    console.error(`Expected a path to a JSON spec file.\n${USAGE}`);
    process.exit(2);
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    console.error(`No such spec file: ${resolved}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    console.error(`${resolved} is not valid JSON: ${error.message}`);
    process.exit(2);
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Credentials
// ────────────────────────────────────────────────────────────────────────────

const envPath = resolve(customerDir, '.env');
if (!existsSync(envPath)) {
  console.error(`No .env found at ${envPath}`);
  console.error('Run the netsuite-setup skill for this customer first.');
  process.exit(2);
}
loadEnv({ path: envPath });

const envMode = (process.env.ENVIRONMENT || 'sandbox').toLowerCase();
if (envMode !== 'sandbox' && envMode !== 'production') {
  console.error(`ENVIRONMENT must be "sandbox" or "production" (got "${envMode}")`);
  process.exit(2);
}
const nsPrefix = envMode === 'production' ? 'NS_PROD' : 'NS_SB';

const PLACEHOLDER = /^<\s*paste\s*here\s*>$/i;
const missing = [
  `${nsPrefix}_ACCOUNT_ID`,
  `${nsPrefix}_CONSUMER_KEY`,
  `${nsPrefix}_CONSUMER_SECRET`,
  `${nsPrefix}_TOKEN_ID`,
  `${nsPrefix}_TOKEN_SECRET`,
].filter((key) => {
  const value = process.env[key];
  return !value || value.trim() === '' || PLACEHOLDER.test(value.trim());
});
if (missing.length > 0) {
  console.error(`Missing or unfilled env vars for ENVIRONMENT=${envMode}:`);
  missing.forEach((key) => console.error(`  - ${key}`));
  process.exit(2);
}

const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
// Sandbox/RP account IDs use underscores in the ID (1234567_SB1) but hyphens in URL hosts.
const urlHost = accountId.replace(/_/g, '-').toLowerCase();

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

// ────────────────────────────────────────────────────────────────────────────
// Build the request
// ────────────────────────────────────────────────────────────────────────────

/**
 * A source-transaction filter, ANDed onto whatever condition the dataset already
 * carries. This is close to but NOT identical to what the runtime does — the
 * label path ANDs any stored condition, while the 856 packaging path REPLACES a
 * single-leaf one (carton.repository.ts, NS-1188). See SKILL.md "Fidelity of
 * `run`" before trusting a zero-row result on a packaging dataset.
 */
const sourceCondition = () => {
  if (fulfillmentId) {
    return { columnLabel: 'Fulfillment', operator: 'ANY_OF', values: [fulfillmentId] };
  }
  if (salesOrderId) {
    return { columnLabel: 'SalesOrder', operator: 'ANY_OF', values: [salesOrderId] };
  }
  return undefined;
};

let body;
let isWrite = false;

switch (command) {
  case 'list':
    body = { action: 'listDatasets' };
    break;

  case 'describe':
    if (!arg) {
      console.error(`describe needs a dataset scriptid.\n${USAGE}`);
      process.exit(2);
    }
    body = { action: 'describeDataset', datasetId: arg };
    break;

  case 'run': {
    if (!arg) {
      console.error(`run needs a dataset scriptid.\n${USAGE}`);
      process.exit(2);
    }
    body = { action: 'runDataset', datasetId: arg, limit };
    const condition = sourceCondition();
    if (condition) body.condition = condition;
    break;
  }

  case 'dry-run':
  case 'dryRun': {
    const spec = readSpec(arg);
    // dryRunDataset takes no separate condition — the only filter it applies is
    // spec.condition. Rather than telling the user to bake a source filter into
    // the spec they are about to save (the exact mistake that silently zeroes a
    // live dataset), refuse and point at the probe-spec procedure.
    if (fulfillmentId || salesOrderId) {
      console.error(
        'dry-run cannot apply --fulfillment/--sales-order: the shipped dryRunDataset\n' +
        'action filters only on spec.condition (NS-1189 tracks adding one).\n\n' +
        'Do NOT add the filter to the spec you intend to save. Instead keep a\n' +
        'separate probe spec:\n' +
        `  cp ${arg || 'specs/my-dataset.json'} ${(arg || 'specs/my-dataset.json').replace(/\.json$/, '')}.probe.json\n` +
        '  # add the source condition to the .probe.json only, then:\n' +
        `  node dataset-tool.mjs ${customerDir} dry-run <spec>.probe.json --limit 10\n\n` +
        'Save the unfiltered spec; never the probe. See SKILL.md Step 3.',
      );
      process.exit(2);
    }
    body = { action: 'dryRunDataset', spec, limit };
    break;
  }

  case 'save': {
    const spec = readSpec(arg);
    // A saved dataset must not filter on its own source column. The consumer ANDs
    // its own Fulfillment/SalesOrder filter on at runtime, so a baked-in one is
    // contradictory for every real record and the dataset silently returns zero
    // rows — no error, no log, labels just stop generating. Found live at a customer.
    if (spec.condition && /"(fulfillment|salesorder)"/i.test(JSON.stringify(spec.condition))) {
      console.error(
        'REFUSED: this spec conditions on a source column (Fulfillment/SalesOrder).\n' +
        'Saving it silently zeroes the dataset at runtime — the consumer ANDs its own\n' +
        'source filter on top and the two contradict for every real record.\n\n' +
        'Keep source filters in a separate <spec>.probe.json and save the unfiltered\n' +
        'spec. See SKILL.md Step 3.',
      );
      process.exit(2);
    }
    if (!flags.yes) {
      console.error(
        `Refusing to save without --yes.\n` +
        `  target : ${envMode} ${accountId}\n` +
        `  spec   : ${arg}\n` +
        `  id     : ${spec.id || '(none — NetSuite will assign custdataset<N>)'}\n` +
        `  name   : ${spec.name || '(none)'}\n` +
        `Run dry-run first, then re-run with --yes.`,
      );
      process.exit(2);
    }
    body = { action: 'saveDataset', spec };
    isWrite = true;
    break;
  }

  case 'raw': {
    // Escape hatch: post an arbitrary request body from a JSON file. Routed to
    // the write RESTlet only when the action is a known write.
    body = readSpec(arg);
    isWrite = body.action === 'saveDataset';
    break;
  }

  default:
    console.error(`Unknown command "${command}".\n${USAGE}`);
    process.exit(2);
}

// ────────────────────────────────────────────────────────────────────────────
// Call the RESTlet
// ────────────────────────────────────────────────────────────────────────────

const scriptId = isWrite ? WRITE_SCRIPT_ID : READ_SCRIPT_ID;
const deployId = isWrite ? WRITE_DEPLOY_ID : READ_DEPLOY_ID;
const url = `https://${urlHost}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;

const customerLabel = process.env.CUSTOMER_NAME || process.env.CUSTOMER_SLUG || customerDir;
console.error(
  `${command} on ${customerLabel} (ENVIRONMENT=${envMode}, agent-${isWrite ? 'write' : 'read'})`,
);

const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
authHeader.Authorization += `, realm="${accountId}"`;

let res;
let text;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  text = await res.text();
} catch (error) {
  console.error(`FAIL: could not reach the agent RESTlet.\nURL: ${url}\n${error.message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = text;
}
const bodyStr = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);

const isMissingEndpoint =
  res.status === 404 ||
  bodyStr.includes('SSS_INVALID_SCRIPTLET_ID') ||
  bodyStr.includes('INVALID_LOGIN_INVALID_SCRIPT_ID');

if (isMissingEndpoint) {
  console.error('FAIL: agent RESTlet not found in this NetSuite account.');
  console.error("The customer's SuiteApp version predates the dataset actions (NS-1142).");
  console.error('Fall back to building the dataset in the Analytics UI — see the');
  console.error('alternative-packing-source skill.');
  console.error(`\nResponse (${res.status}): ${bodyStr.slice(0, 400)}`);
  process.exit(1);
}

// An unknown-action error means the SuiteApp is new enough to have the agent
// RESTlets but not the dataset handlers — worth saying plainly.
if (/unknown|unsupported/i.test(bodyStr) && /action/i.test(bodyStr)) {
  console.error("FAIL: this SuiteApp's agent RESTlet does not implement the dataset actions.");
  console.error('Dataset actions ship from NS-1142 (netsuite-connector #880) onward.');
  console.error(`\nResponse: ${bodyStr.slice(0, 400)}`);
  process.exit(1);
}

console.log(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));

if (!res.ok || (parsed && typeof parsed === 'object' && parsed.status === 'error')) {
  process.exit(1);
}
