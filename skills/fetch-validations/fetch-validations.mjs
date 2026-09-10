#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.

// Fetch structured per-transaction validation errors from Orderful.
// See SKILL.md for end-to-end usage.
//
// Usage:
//   node fetch-validations.mjs <txId> [<txId>...]
//
// Auth, in order of preference:
//   1. Plain API key (sent as `orderful-api-key`; works despite the /v2 UI namespace):
//      process.env.ORDERFUL_API_KEY, or ORDERFUL_API_KEY from the most recent
//      customer .env under ~/orderful-onboarding/*/.env
//   2. UI session JWT (sent as `Authorization: Bearer`):
//      process.env.ORDERFUL_UI_JWT, or extracted from a HAR file
//      (default path: ~/Desktop/ui.orderful.com.har; override with $ORDERFUL_HAR_PATH)
//   On a 401/403 with the API key, retries with the JWT when one is available.
//
// Org ID: resolved in this order:
//   1. --org=<id> flag
//   2. process.env.ORDERFUL_ORG_ID
//   3. Read from the most recent customer .env under ~/orderful-onboarding/*/.env

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const orgFlag = args.find((a) => a.startsWith('--org='));
const orgIdFromFlag = orgFlag ? orgFlag.split('=')[1] : null;
const txIds = args.filter((a) => !a.startsWith('--'));

if (!txIds.length) {
  console.error('Usage: node fetch-validations.mjs <txId> [<txId>...] [--org=<id>]');
  process.exit(1);
}

const ORG_ID = orgIdFromFlag || process.env.ORDERFUL_ORG_ID || resolveFromOnboardingEnvs('ORDERFUL_ORG_ID');
if (!ORG_ID) {
  console.error('No org ID resolved. Pass --org=<id>, set $ORDERFUL_ORG_ID, or configure a customer .env at ~/orderful-onboarding/<slug>/.env with ORDERFUL_ORG_ID.');
  process.exit(1);
}

const API_KEY = process.env.ORDERFUL_API_KEY || resolveFromOnboardingEnvs('ORDERFUL_API_KEY');
const JWT = process.env.ORDERFUL_UI_JWT || resolveJwtFromHar();
if (!API_KEY && !JWT) {
  console.error('No auth found. Set ORDERFUL_API_KEY (preferred; also picked up from ~/orderful-onboarding/<slug>/.env), or set ORDERFUL_UI_JWT / capture a HAR at ~/Desktop/ui.orderful.com.har (see SKILL.md Step 1).');
  process.exit(1);
}

if (JWT) inspectJwtExpiry(JWT);

for (const txId of txIds) {
  const url = `https://api.orderful.com/v2/organizations/${ORG_ID}/transactions/${txId}/validations`;
  let r = null;
  if (API_KEY) {
    r = await fetch(url, {
      headers: { 'orderful-api-key': API_KEY, Accept: 'application/json' },
    });
  }
  if ((!r || r.status === 401 || r.status === 403) && JWT) {
    r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${JWT}`,
        'X-Orderful-Client': 'ui',
        'X-ActingOrgId': String(ORG_ID),
        Accept: 'application/json',
      },
    });
  }
  console.log(`\n=== Tx ${txId} (HTTP ${r.status}) ===`);
  if (r.status === 401 || r.status === 403) {
    console.log('  Auth failed. The API key may belong to a different org than the transaction, or the JWT expired — see SKILL.md Step 1.');
    continue;
  }
  if (r.status >= 400) {
    console.log(`  Error: ${await r.text()}`);
    continue;
  }
  const errs = await r.json();
  if (!Array.isArray(errs) || errs.length === 0) {
    console.log('  (no validation errors — transaction is VALID)');
    continue;
  }

  // Dedupe by (path-shape, message). Path-shape collapses numeric indices to '.*.'.
  const dedup = new Map();
  for (const err of errs) {
    const shape = err.dataPath.replace(/\.\d+\./g, '.*.').replace(/\.\d+$/, '.*');
    const key = `${shape}::${err.message}`;
    if (!dedup.has(key)) dedup.set(key, { ...err, count: 0, samplePath: err.dataPath });
    dedup.get(key).count++;
  }

  console.log(`  ${errs.length} errors total, ${dedup.size} unique patterns:`);
  let i = 1;
  for (const e of dedup.values()) {
    console.log(`  [${i++}] ${e.samplePath}${e.count > 1 ? ` (${e.count}x)` : ''}`);
    console.log(`      ${e.message}`);
    if (e.dataPathDescription && e.dataPathDescription.length < 250) {
      console.log(`      desc: ${e.dataPathDescription}`);
    }
    if (e.allowedValues?.length) {
      const codes = e.allowedValues.map((v) => v.value + (v.description ? '=' + v.description : '')).join(' | ');
      console.log(`      allowed: ${codes}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveJwtFromHar() {
  const path = process.env.ORDERFUL_HAR_PATH || resolve(process.env.HOME, 'Desktop', 'ui.orderful.com.har');
  if (!existsSync(path)) return null;
  try {
    const har = JSON.parse(readFileSync(path, 'utf-8'));
    const entry = (har.log?.entries || []).find((e) => {
      const auth = e.request?.headers?.find((h) => h.name.toLowerCase() === 'authorization');
      return auth?.value?.startsWith('Bearer ');
    });
    if (!entry) return null;
    const auth = entry.request.headers.find((h) => h.name.toLowerCase() === 'authorization');
    return auth.value.replace(/^Bearer\s+/, '');
  } catch {
    return null;
  }
}

function inspectJwtExpiry(jwt) {
  try {
    const parts = jwt.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    if (payload.exp) {
      const remaining = payload.exp - Math.floor(Date.now() / 1000);
      const status = remaining > 0 ? `${remaining}s remaining` : `EXPIRED ${-remaining}s ago`;
      console.log(`JWT exp: ${new Date(payload.exp * 1000).toISOString()} (${status})`);
    }
  } catch {
    // not a JWT or unreadable; skip
  }
}

function resolveFromOnboardingEnvs(name) {
  const dir = resolve(process.env.HOME, 'orderful-onboarding');
  if (!existsSync(dir)) return null;
  // Pick the most recently modified .env across customer dirs.
  const candidates = [];
  for (const slug of readdirSync(dir)) {
    const envPath = resolve(dir, slug, '.env');
    if (!existsSync(envPath)) continue;
    candidates.push({ path: envPath, mtime: statSync(envPath).mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    const text = readFileSync(c.path, 'utf-8');
    const m = text.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, 'm'));
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}
