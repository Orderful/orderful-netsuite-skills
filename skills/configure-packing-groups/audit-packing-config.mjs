// Copyright (c) 2026 Orderful, Inc.
// Audit a customer's 856 packing configuration before changing it.
//
// Usage:
//   node audit-packing-config.mjs <customer-dir>                (account-wide audit)
//   node audit-packing-config.mjs <customer-dir> --item <id>    (resolve one item)
//   node audit-packing-config.mjs <customer-dir> --item <id> --customer <id>
//
// Reports which of the three packing paths the account is actually on, flags the
// silent-null traps (zero units-per-carton, orphaned groups, duplicate general
// assignments, inactive assignments), and resolves a single item the way
// PackingGroupService does.
//
// Read-only. Makes no writes.
//
// NOTE: custrecord_ofipg_customers cannot be read through SuiteQL — the REST
// SuiteQL endpoint returns the literal string "RELATIONSHIP FIELD" for every
// row. This script reads it per-record via REST GET ?expandSubResources=true,
// which is the only trustworthy source.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const dir = process.argv[2];
const itemIdx = process.argv.indexOf('--item');
const custIdx = process.argv.indexOf('--customer');
const itemId = itemIdx > -1 ? process.argv[itemIdx + 1] : null;
const customerId = custIdx > -1 ? process.argv[custIdx + 1] : null;

if (!dir) {
  console.error("Usage: node audit-packing-config.mjs <customer-dir> [--item <id>] [--customer <id>]");
  process.exit(1);
}

loadEnv({ path: resolve(dir, '.env'), quiet: true });
const p = (process.env.ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'NS_PROD' : 'NS_SB';
const accountId = process.env[`${p}_ACCOUNT_ID`];
if (!accountId) { console.error(`No ${p}_ACCOUNT_ID in ${dir}/.env`); process.exit(1); }
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const base = `https://${urlHost}.suitetalk.api.netsuite.com`;
const sqlUrl = `${base}/services/rest/query/v1/suiteql`;

const oauth = new OAuth({
  consumer: { key: process.env[`${p}_CONSUMER_KEY`], secret: process.env[`${p}_CONSUMER_SECRET`] },
  signature_method: 'HMAC-SHA256',
  hash_function: (b, k) => crypto.createHmac('sha256', k).update(b).digest('base64'),
});
const token = { key: process.env[`${p}_TOKEN_ID`], secret: process.env[`${p}_TOKEN_SECRET`] };

function authHeader(url, method) {
  const a = oauth.toHeader(oauth.authorize({ url, method }, token));
  a.Authorization += `, realm="${accountId}"`;
  return a;
}

async function sql(q) {
  const r = await fetch(sqlUrl, {
    method: 'POST',
    headers: { ...authHeader(sqlUrl, 'POST'), 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = j['o:errorDetails']?.[0]?.detail || `HTTP ${r.status}`;
    throw new Error(detail);
  }
  return j.items ?? [];
}

async function restGet(path) {
  const url = `${base}/services/rest/record/v1/${path}`;
  const r = await fetch(url, { headers: authHeader(url, 'GET') });
  return r.ok ? r.json() : null;
}

// The only trustworthy read of the customers multiselect.
async function assignmentCustomers(assignmentId) {
  const rec = await restGet(`customrecord_orderful_item_pack_group/${assignmentId}?expandSubResources=true`);
  const items = rec?.custrecord_ofipg_customers?.items ?? [];
  return items.map((c) => String(c.id));
}

const n = (v) => Number(v ?? 0);

async function accountAudit() {
  console.log(`\n=== Packing configuration — ${accountId} (${p}) ===\n`);

  const [groups, assigns, itemField, cartons] = await Promise.all([
    sql('SELECT COUNT(*) AS c FROM customrecord_orderful_packing_group'),
    sql("SELECT COUNT(*) AS c FROM customrecord_orderful_item_pack_group WHERE custrecord_ofipg_is_active = 'T'"),
    sql('SELECT COUNT(*) AS c FROM item WHERE custitem_orderful_units_p_carton > 0'),
    sql('SELECT COUNT(*) AS c FROM customrecord_orderful_carton'),
  ]);

  const g = n(groups[0]?.c), a = n(assigns[0]?.c), f = n(itemField[0]?.c), c = n(cartons[0]?.c);
  console.log(`  packing groups .................. ${g}`);
  console.log(`  active assignments ............. ${a}`);
  console.log(`  items with Units per Carton .... ${f}`);
  console.log(`  carton records ................. ${c}`);

  console.log('\n--- Path in use ---');
  if (g === 0 && a === 0 && f === 0 && c > 0) {
    console.log('  Cartons exist with no packing config: dataset-driven or hand-built.');
    console.log('  Check custentity_orderful_pkg_data_src before assuming this skill applies.');
  } else if (g === 0 && f > 0) {
    console.log('  ITEM FIELD only. Simplest path; escalate only for pallets, dimensions,');
    console.log('  even distribution, or per-customer variation.');
  } else if (a > 0 && f > a * 10) {
    console.log(`  Primarily ITEM FIELD (${f} items), with only ${a} group assignment(s).`);
    console.log('  Most packing here resolves via the item field, not the groups.');
  } else if (a > 0) {
    console.log(`  PACKING GROUPS in use (${a} assignments).`);
    if (f > 0) console.log(`  ${f} item(s) also carry the field as a fallback.`);
  } else if (g > 0 && a === 0) {
    console.log('  Groups exist with no assignments — every group is inert.');
  } else {
    console.log('  No packing configuration found.');
  }

  console.log('\n--- Problems ---');
  let found = 0;

  const badUpc = await sql('SELECT id, name FROM customrecord_orderful_packing_group WHERE custrecord_orderful_units_per_carton IS NULL OR custrecord_orderful_units_per_carton <= 0');
  if (badUpc.length) {
    found++;
    console.log(`  [${badUpc.length}] group(s) with units-per-carton <= 0 — these resolve to null`);
    console.log('      and silently fall back to the item field:');
    badUpc.slice(0, 10).forEach((r) => console.log(`        #${r.id} ${r.name ?? ''}`));
  }

  if (g > 0) {
    const orphans = await sql(`
      SELECT COUNT(*) AS c FROM customrecord_orderful_packing_group pg
      WHERE NOT EXISTS (
        SELECT 1 FROM customrecord_orderful_item_pack_group a
        WHERE a.custrecord_ofipg_packing_group = pg.id
      )`);
    const oc = n(orphans[0]?.c);
    if (oc > 0) {
      found++;
      console.log(`  [${oc}] orphaned group(s) with no assignment — inert records.`);
      if (oc > g * 0.5) console.log('      Over half the groups are orphaned: likely a bulk import that was never linked.');
    }
  }

  const dangling = await sql(`
    SELECT a.id, a.custrecord_ofipg_item AS item
    FROM customrecord_orderful_item_pack_group a
    WHERE a.custrecord_ofipg_is_active = 'T'
      AND NOT EXISTS (
        SELECT 1 FROM customrecord_orderful_packing_group pg
        WHERE pg.id = a.custrecord_ofipg_packing_group
      )`);
  if (dangling.length) {
    found++;
    console.log(`  [${dangling.length}] assignment(s) pointing at a missing group — resolve to null:`);
    dangling.slice(0, 10).forEach((r) => console.log(`        assignment #${r.id} (item ${r.item})`));
  }

  const dupes = await sql(`
    SELECT custrecord_ofipg_item AS item, COUNT(*) AS c
    FROM customrecord_orderful_item_pack_group
    WHERE custrecord_ofipg_is_active = 'T'
    GROUP BY custrecord_ofipg_item HAVING COUNT(*) > 1`);
  if (dupes.length) {
    found++;
    console.log(`  [${dupes.length}] item(s) with multiple active assignments — nondeterministic;`);
    console.log('      the engine takes whichever SuiteQL returns first:');
    dupes.slice(0, 10).forEach((r) => console.log(`        item ${r.item}: ${r.c} assignments`));
  }

  const inactive = await sql("SELECT COUNT(*) AS c FROM customrecord_orderful_item_pack_group WHERE custrecord_ofipg_is_active = 'F'");
  if (n(inactive[0]?.c) > 0) {
    found++;
    console.log(`  [${n(inactive[0].c)}] inactive assignment(s) — visible in the UI, invisible to the engine.`);
  }

  const sku = await sql("SELECT COUNT(*) AS c FROM customrecord_orderful_packing_group WHERE custrecord_orderful_cartons_per_pallet = 0 AND custrecord_orderful_units_per_carton = 1");
  if (n(sku[0]?.c) > 0 && g > 50) {
    found++;
    console.log(`  [${n(sku[0].c)}] group(s) with units=1 and no pallet config — these carry no`);
    console.log('      information the item field could not. Candidate for cleanup.');
  }

  if (!found) console.log('  None found.');
  console.log('');
}

async function resolveItem(id, cust) {
  console.log(`\n=== Resolving item ${id}${cust ? ` for customer ${cust}` : ''} ===\n`);

  const itemRows = await sql(`SELECT id, itemid, custitem_orderful_units_p_carton AS upc FROM item WHERE id = ${Number(id)}`);
  if (!itemRows.length) { console.log('  Item not found.'); return; }
  const item = itemRows[0];
  console.log(`  Item: ${item.itemid}`);
  console.log(`  Item field (custitem_orderful_units_p_carton): ${item.upc ?? '(unset)'}`);

  const assigns = await sql(`
    SELECT a.id, a.custrecord_ofipg_packing_group AS pg, a.custrecord_ofipg_is_active AS active,
           pg.name AS pg_name, pg.custrecord_orderful_units_per_carton AS upc,
           pg.custrecord_orderful_cartons_per_pallet AS cpp,
           pg.custrecord_orderful_packing_strategy AS strategy
    FROM customrecord_orderful_item_pack_group a
    LEFT JOIN customrecord_orderful_packing_group pg ON pg.id = a.custrecord_ofipg_packing_group
    WHERE a.custrecord_ofipg_item = ${Number(id)}`);

  if (!assigns.length) {
    console.log('\n  No assignments. → falls back to the item field.');
    console.log(item.upc > 0
      ? `\n  RESOLVED: item field, ${item.upc} per carton.`
      : '\n  RESOLVED: nothing. Auto Pack will hard-error on this item.');
    return;
  }

  console.log(`\n  ${assigns.length} assignment(s):`);
  const enriched = [];
  for (const a of assigns) {
    const customers = a.active === 'T' ? await assignmentCustomers(a.id) : [];
    enriched.push({ ...a, customers });
    const scope = customers.length ? `customers [${customers.join(', ')}]` : 'GENERAL';
    const strat = String(a.strategy) === '2' ? 'Even' : 'Full';
    console.log(`    #${a.id} active=${a.active} ${scope}`);
    console.log(`        group ${a.pg} "${a.pg_name ?? '(MISSING)'}" upc=${a.upc ?? '-'} cpp=${a.cpp ?? '-'} strategy=${strat}`);
  }

  // Mirror PackingGroupService.getPackingConfigsForItems precedence.
  const active = enriched.filter((a) => a.active === 'T');
  const usable = (a) => a.pg_name != null && n(a.upc) > 0;
  let chosen = null, why = '';

  if (cust) {
    chosen = active.find((a) => a.customers.includes(String(cust)));
    if (chosen) why = 'customer-specific match';
  }
  if (!chosen) {
    chosen = active.find((a) => a.customers.length === 0);
    if (chosen) why = 'general assignment';
  }

  console.log('\n  --- Resolution ---');
  if (chosen && usable(chosen)) {
    console.log(`  RESOLVED: packing group ${chosen.pg} via ${why}.`);
    console.log(`  ${chosen.upc} per carton, ${n(chosen.cpp) > 0 ? `${chosen.cpp} cartons per pallet` : 'no pallet tier'}.`);
  } else if (chosen) {
    console.log(`  Matched ${why} (#${chosen.id}) but the group is UNUSABLE`);
    console.log(`  (${chosen.pg_name == null ? 'group missing' : `units-per-carton = ${chosen.upc}`}) → resolves to null.`);
    console.log(item.upc > 0
      ? `  RESOLVED: item field, ${item.upc} per carton (silent fallback).`
      : '  RESOLVED: nothing. Auto Pack will hard-error on this item.');
  } else {
    const allCustSpecific = active.length > 0 && active.every((a) => a.customers.length > 0);
    if (allCustSpecific) {
      console.log('  Every active assignment is customer-specific and none matches.');
      console.log('  There is no general fallback → resolves to null.');
    } else {
      console.log('  No active assignment applies → resolves to null.');
    }
    console.log(item.upc > 0
      ? `  RESOLVED: item field, ${item.upc} per carton (silent fallback).`
      : '  RESOLVED: nothing. Auto Pack will hard-error on this item.');
  }
  console.log('');
}

try {
  if (itemId) await resolveItem(itemId, customerId);
  else await accountAudit();
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
}
