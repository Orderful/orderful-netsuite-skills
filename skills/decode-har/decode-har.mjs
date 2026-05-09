#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.

// Decode a HAR (HTTP Archive) export into a clean catalog of API endpoints called.
// Filters out static assets and tracking; groups by URL pattern; saves successful
// JSON response bodies for the largest interesting endpoint per group.
//
// Usage:
//   node decode-har.mjs [<har-path>] [--filter=<regex>]
//
// If no path is given, scans ~/Desktop for the most-recently-modified .har file.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const filterArg = args.find((a) => a.startsWith('--filter='));
const filterRe = filterArg ? new RegExp(filterArg.split('=')[1], 'i') : null;
const explicitPath = args.find((a) => !a.startsWith('--'));

const harPath = explicitPath || resolveLatestHar(resolve(process.env.HOME, 'Desktop'));
if (!harPath) {
  console.error('Usage: node decode-har.mjs [<har-path>] [--filter=<regex>]\nNo HAR found at ~/Desktop. Pass an explicit path.');
  process.exit(1);
}
if (!existsSync(harPath)) {
  console.error(`HAR not found: ${harPath}`);
  process.exit(1);
}

const har = JSON.parse(readFileSync(harPath, 'utf-8'));
const allEntries = har.log?.entries || [];
console.log(`HAR: ${harPath}`);
console.log(`Total entries: ${allEntries.length}\n`);

// 1. Filter to API-shaped requests (drop static assets + tracking).
const apiCalls = allEntries.filter(isApiCall);
if (filterRe) {
  const filtered = apiCalls.filter((e) => filterRe.test(e.request.url));
  console.log(`After filter /${filterRe.source}/: ${filtered.length} of ${apiCalls.length} API calls\n`);
  apiCalls.length = 0;
  apiCalls.push(...filtered);
} else {
  console.log(`API-ish calls (after dropping static + tracking): ${apiCalls.length}\n`);
}

// 2. Group by URL pattern (numeric + UUID ID segments collapsed to {id}).
const grouped = {};
for (const e of apiCalls) {
  const u = new URL(e.request.url);
  const path = u.pathname
    .replace(/\/[0-9a-f]{8,}-[0-9a-f-]+/gi, '/{id}') // UUID
    .replace(/\/[0-9]+/g, '/{id}'); // numeric
  const key = `${e.request.method} ${u.host}${path}`;
  (grouped[key] ||= []).push(e);
}
console.log(`Unique endpoints: ${Object.keys(grouped).length}\n`);

// 3. Surface validation/rule/schema/error patterns first.
const interesting = Object.keys(grouped).filter((k) =>
  /error|valid|rule|issue|diagnost|schema|guideline|element-codes/i.test(k)
);
if (interesting.length) {
  console.log('Endpoints likely relevant for validation/spec/rules work:');
  for (const k of interesting) console.log(`  [${grouped[k].length}x]  ${k}`);
  console.log();
}

// 4. Print the full catalog, ordered by call count desc, with response preview.
const sorted = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length);
console.log('All endpoints (sorted by call count):');
for (const [key, entries] of sorted) {
  const e = entries[0];
  const status = e.response.status;
  const ct = e.response.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  const body = e.response.content?.text || '';
  console.log(`  [${entries.length}x] ${key}  → ${status} (${shortContentType(ct)}, ${body.length}b)`);
  if (status >= 200 && status < 300 && body && ct.includes('json') && body.length > 50) {
    const preview = body.slice(0, 100).replace(/\s+/g, ' ');
    console.log(`         preview: ${preview}${body.length > 100 ? '…' : ''}`);
  }
}

// 5. For interesting endpoints, save the largest successful JSON body to disk.
console.log();
let saved = 0;
for (const k of interesting) {
  const entries = grouped[k];
  const candidate = entries
    .filter((e) => e.response.status >= 200 && e.response.status < 300 && (e.response.content?.text || '').length > 100)
    .sort((a, b) => (b.response.content?.text?.length || 0) - (a.response.content?.text?.length || 0))[0];
  if (!candidate) continue;
  const u = new URL(candidate.request.url);
  const slug = u.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80);
  const search = u.search ? '_' + u.search.replace(/[^a-z0-9]+/gi, '-').slice(0, 30) : '';
  const fname = `har-${slug}${search}.json`;
  writeFileSync(fname, candidate.response.content.text);
  saved++;
  console.log(`Saved: ${fname} (${candidate.response.content.text.length}b)`);
}
if (saved > 0) console.log(`\n${saved} response body(ies) saved to current directory.`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isApiCall(entry) {
  const url = entry.request.url;
  if (/\.(js|css|png|jpg|jpeg|svg|webp|gif|woff2?|ttf|eot|ico|map)(\?|$)/i.test(url)) return false;
  if (url.includes('/_next/') || url.includes('/static/') || url.includes('/assets/')) return false;
  if (/(google-analytics|googletagmanager|segment\.io|datadog|hcaptcha|launchdarkly|intercom)/i.test(url)) return false;
  return true;
}

function shortContentType(ct) {
  if (!ct) return 'unknown';
  if (ct.includes('json')) return 'JSON';
  if (ct.includes('html')) return 'HTML';
  if (ct.includes('text/plain')) return 'text';
  if (ct.includes('xml')) return 'XML';
  return ct.split(';')[0];
}

function resolveLatestHar(dir) {
  if (!existsSync(dir)) return null;
  const hars = readdirSync(dir)
    .filter((f) => f.endsWith('.har'))
    .map((f) => ({ path: resolve(dir, f), mtime: statSync(resolve(dir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  return hars[0]?.path || null;
}
