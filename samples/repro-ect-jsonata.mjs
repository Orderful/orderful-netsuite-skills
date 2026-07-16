#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Sample: reproduce a customer's ECT (EDI Enabled Customer Transaction) JSONata
// OFFLINE, so you can prove whether a wrong outbound payload came from the
// connector/JSONata or from Orderful's post-send rule engine.
//
// This is the harness behind the "Attribute the defect: connector vs. rules"
// recipe in skills/audit-outbound-rules. The idea: reconstruct the connector's
// TRUE output locally (real stored inputs + the customer's ECT JSONata, on the
// SuiteApp's own engine version) and diff it against the payload Orderful
// actually received. If the offline output is correct but the received payload
// is wrong, the delta is the rules — not the connector.
//
// ---------------------------------------------------------------------------
// DEPENDENCY NOTE — jsonata is NOT a dependency of this repo.
//
// This repo's package.json only ships `dotenv` + `oauth-1.0a`. The SuiteApp
// evaluates outbound mappings with jsonata@2.0.6, and you MUST match that
// version so engine-version differences don't muddy the diff. Two options:
//
//   (a) Add it here:   pnpm add jsonata@2.0.6      (then `import jsonata`)
//   (b) Reuse the copy the connector repo already vendors at 2.0.6 — no install.
//
// This script tries (a) first and falls back to (b), resolving jsonata from the
// connector's node_modules. Override the connector path with CONNECTOR_REPO if
// your checkout lives elsewhere.
// ---------------------------------------------------------------------------
//
// Usage:
//   node samples/repro-ect-jsonata.mjs <env-dir> <inbound-txn-id> \
//     (--jsonata <file> | --ect <ect-id>) \
//     [--default-values <file>] [--bindings <file>]
//
//   # inbound message + JSONata from a file, minimal default-values skeleton:
//   node samples/repro-ect-jsonata.mjs ~/orderful-onboarding/acme <inbound-txn-id> \
//     --jsonata ./ect.jsonata
//
//   # pull the JSONata straight off the ECT record, supply the real outbound
//   # default envelope + input bindings captured from a reprocess:
//   node samples/repro-ect-jsonata.mjs ~/orderful-onboarding/acme <inbound-txn-id> \
//     --ect <ect-id> --default-values ./defaults.json --bindings ./input.json
//
// <inbound-txn-id> is the internal id of the originating inbound
// customrecord_orderful_transaction (e.g. the 850). Its stored message is bound
// as `inboundOrderfulTransaction.message`, which most outbound ECT JSONata reads.
//
// --default-values : JSON file holding the outbound default envelope
//                    {sender, receiver, type, stream, message}. This is what the
//                    SuiteApp's native builder would emit before JSONata runs
//                    (the `$defaultValues` variable). If omitted, a minimal
//                    skeleton is used — fine for JSONata that builds the message
//                    from the inbound side, insufficient for JSONata that
//                    transforms an existing default message.
// --bindings       : JSON file merged into the root input (itemFulfillments,
//                    salesOrders, invoices, customer, ...). Capture these from a
//                    real reprocess for a faithful repro.
//
import { config as loadEnv } from 'dotenv';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// ---- arg parsing ----------------------------------------------------------
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--jsonata') flags.jsonataFile = args[++i];
  else if (args[i] === '--ect') flags.ectId = args[++i];
  else if (args[i] === '--default-values') flags.defaultValuesFile = args[++i];
  else if (args[i] === '--bindings') flags.bindingsFile = args[++i];
  else positional.push(args[i]);
}
const [envDir, inboundTxnId] = positional;

if (!envDir || !inboundTxnId || (!flags.jsonataFile && !flags.ectId)) {
  console.error(
    'Usage: node samples/repro-ect-jsonata.mjs <env-dir> <inbound-txn-id> ' +
      '(--jsonata <file> | --ect <ect-id>) [--default-values <file>] [--bindings <file>]',
  );
  process.exit(1);
}

// ---- resolve jsonata@2.0.6 (see DEPENDENCY NOTE) --------------------------
async function loadJsonata() {
  try {
    return (await import('jsonata')).default; // option (a): installed here
  } catch {
    // option (b): reuse the connector's vendored copy — matches the SuiteApp engine.
    const connectorRepo = process.env.CONNECTOR_REPO || resolve(process.env.HOME, 'Code/netsuite-connector');
    const require = createRequire(resolve(connectorRepo, 'package.json'));
    return require('jsonata');
  }
}

// ---- TBA-signed SuiteQL (same pattern as samples/suiteql.mjs) -------------
loadEnv({ path: resolve(envDir, '.env'), quiet: true });
const nsPrefix = (process.env.ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'NS_PROD' : 'NS_SB';
const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
if (!accountId) {
  console.error(`Missing ${nsPrefix}_ACCOUNT_ID in ${resolve(envDir, '.env')} — run /netsuite-setup first.`);
  process.exit(1);
}
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const oauth = new OAuth({
  consumer: { key: process.env[`${nsPrefix}_CONSUMER_KEY`], secret: process.env[`${nsPrefix}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (s, k) => crypto.createHmac('sha256', k).update(s).digest('base64'),
});
const token = { key: process.env[`${nsPrefix}_TOKEN_ID`], secret: process.env[`${nsPrefix}_TOKEN_SECRET`] };

async function suiteql(sql) {
  const url = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000`;
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  authHeader.Authorization += `, realm="${accountId}"`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`SuiteQL failed (${res.status}): ${text.slice(0, 500)}`);
    process.exit(1);
  }
  return (JSON.parse(text).items || []).map(({ links: _links, ...rest }) => rest);
}

// ---- pull the inputs ------------------------------------------------------
const [inboundRow] = await suiteql(
  `SELECT custrecord_ord_tran_message AS msg FROM customrecord_orderful_transaction WHERE id = ${Number(inboundTxnId)}`,
);
if (!inboundRow?.msg) {
  console.error(`No stored message on inbound transaction ${inboundTxnId} (or it holds the "too large to log" placeholder).`);
  process.exit(1);
}
const inboundMessage = JSON.parse(inboundRow.msg);

let jsonataExpr;
if (flags.jsonataFile) {
  jsonataExpr = readFileSync(resolve(flags.jsonataFile), 'utf8');
} else {
  const [ectRow] = await suiteql(
    `SELECT custrecord_edi_enab_jsonata AS jsonata FROM customrecord_orderful_edi_customer_trans WHERE id = ${Number(flags.ectId)}`,
  );
  if (!ectRow?.jsonata) {
    console.error(`ECT ${flags.ectId} has no JSONata in custrecord_edi_enab_jsonata.`);
    process.exit(1);
  }
  jsonataExpr = ectRow.jsonata;
}

// ---- reconstruct $defaultValues + the root input --------------------------
// $defaultValues is the WRAPPED envelope the SuiteApp hands JSONata — see
// reference/outbound-jsonata.md "Local testing harness". Supply the real
// outbound default message via --default-values for JSONata that transforms an
// existing default; the skeleton below only covers JSONata that builds from the
// inbound side.
const defaultValues = flags.defaultValuesFile
  ? JSON.parse(readFileSync(resolve(flags.defaultValuesFile), 'utf8'))
  : {
      sender: { isaId: '<sender-isa-id>' },
      receiver: { isaId: '<receiver-isa-id>' },
      type: { name: '856_SHIP_NOTICE_MANIFEST' },
      stream: 'TEST',
      message: { transactionSets: [{ HL_loop: [] }] },
    };

const input = {
  inboundOrderfulTransaction: { message: inboundMessage },
  itemFulfillments: [],
  salesOrders: [],
  invoices: [],
  customer: {},
  ...(flags.bindingsFile ? JSON.parse(readFileSync(resolve(flags.bindingsFile), 'utf8')) : {}),
};

// ---- evaluate -------------------------------------------------------------
const jsonata = await loadJsonata();
const expression = jsonata(jsonataExpr);

// Runtime-only helpers are NOT available offline. Stub them so the expression
// parses and runs; they return undefined (a warning fires if actually called).
// For a faithful repro of lookup-dependent JSONata, replace these with hardcoded
// returns matching the real rows (see the recipe in audit-outbound-rules).
for (const fn of ['lookupSingleSuiteQL', 'lookupMultiSuiteQL', 'lookupContact', 'lookupItems', 'lookupRecords']) {
  expression.registerFunction(fn, (...a) => {
    console.error(`  [stub] $${fn}(${a.map((x) => JSON.stringify(x)).join(', ')}) -> undefined — hardcode a real row for a faithful repro`);
    return undefined;
  });
}

const result = await expression.evaluate(input, { defaultValues });

// Print the full result for diffing against the Orderful-received payload
// (GET /v3/transactions/{id}). Narrow with `| jq` as needed.
console.log(JSON.stringify(result, null, 2));
console.error(`-- evaluated ECT JSONata offline against inbound txn ${inboundTxnId} (${accountId}, ${nsPrefix})`);
