#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// monitor-mr.mjs — read-only monitor for Orderful SuiteApp Map/Reduce runs.
// Reads the three evidence layers: official task status (scheduledscriptinstance),
// execution logs (scriptnote), and business outputs (customrecord_orderful_transaction).
// See reference/mapreduce-monitoring.md for the underlying contracts and gotchas.
//
// Usage:
//   node monitor-mr.mjs <customer-dir> <mode> [flags]
//
// Modes:
//   runs    [--since 60m]                          list MR tasks in a window (all scripts)
//   status  --task <taskId>                        official stage status for one task
//   logs    --script <id> | --flow <flow>          tail the execution log
//           [--tail 20] [--after-id N] [--errors-only]
//   ot      --ot <id,id,...>                       spot-check Orderful Transaction records
//   watch   --flow <flow> | --script <id>          block until the run finishes, then report
//           [--task <taskId>] [--ot <ids>] [--after-id N] [--timeout 600] [--interval 12]
//
// Global flags:
//   --env sandbox|production    override .env ENVIRONMENT (every query here is a SELECT)

import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import OAuth from 'oauth-1.0a';
import crypto from 'node:crypto';

const FLOWS = {
  'inbound-polling': {
    script: 'customscript_orderful_inbound_mr',
    chains: 'customscript_orderful_transaction_mr',
    note: 'Chains the inbound processing MR on completion. Fresh OTs are subject to its 10-minute freshness filter.',
  },
  'inbound-processing': { script: 'customscript_orderful_transaction_mr' },
  reprocess: { script: 'customscript_orderful_transaction_mr' },
  'outbound-consolidation': {
    script: 'customscript_orderful_outbound_cons',
    chains: 'customscript_orderful_outboundrunctrl_mr',
  },
  'outbound-sending': { script: 'customscript_orderful_outbound_sending' },
  'outbound-status': { script: 'customscript_orderful_outbound_status_mr' },
};

// ---------- arg parsing ----------

const [, , customerDir, mode, ...rest] = process.argv;
const MODES = new Set(['runs', 'status', 'logs', 'ot', 'watch']);

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    'Usage: node monitor-mr.mjs <customer-dir> <runs|status|logs|ot|watch> [flags]',
  );
  console.error('Run with a mode and no flags to see what that mode needs.');
  process.exit(2);
}

if (!customerDir || !mode || !MODES.has(mode)) usage('missing or unknown mode');

const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`);
  const key = arg.slice(2);
  if (key === 'errors-only') {
    flags.errorsOnly = true;
  } else {
    flags[key] = rest[i + 1];
    i += 1;
  }
}

if (flags.flow && !FLOWS[flags.flow]) {
  usage(`unknown flow "${flags.flow}" (${Object.keys(FLOWS).join(', ')})`);
}
const scriptId = flags.script || (flags.flow ? FLOWS[flags.flow].script : null);
if (scriptId && !/^[a-z0-9_]+$/i.test(scriptId)) usage('bad --script');
if (flags.task && !/^[A-Z0-9_]+$/i.test(flags.task)) usage('bad --task');
if (flags.ot && !/^\d+(,\d+)*$/.test(flags.ot)) usage('bad --ot (want id,id,...)');
if (flags['after-id'] && !/^\d+$/.test(flags['after-id'])) usage('bad --after-id');

// ---------- env + auth (same pattern as run-poller.mjs) ----------

const envPath = resolve(customerDir, '.env');
if (!existsSync(envPath)) {
  console.error(`No .env found at ${envPath}`);
  process.exit(2);
}
loadEnv({ path: envPath });

const envMode = (flags.env || process.env.ENVIRONMENT || 'sandbox').toLowerCase();
if (envMode !== 'sandbox' && envMode !== 'production') {
  console.error(`--env/ENVIRONMENT must be "sandbox" or "production" (got "${envMode}")`);
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
const urlHost = accountId.replace(/_/g, '-').toLowerCase();
const suiteqlUrl = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

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

async function suiteql(q) {
  const authHeader = oauth.toHeader(
    oauth.authorize({ url: suiteqlUrl, method: 'POST' }, token),
  );
  authHeader.Authorization += `, realm="${accountId}"`;
  const res = await fetch(suiteqlUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SuiteQL HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text).items || [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- layer helpers ----------

const TS_FMT = 'YYYY-MM-DD HH24:MI:SS';

// Window boundaries are computed from the ACCOUNT clock (account-local tz),
// never the local machine clock.
async function accountNow() {
  try {
    const rows = await suiteql(`SELECT TO_CHAR(SYSDATE,'${TS_FMT}') AS now FROM DUAL`);
    if (rows[0]?.now) return rows[0].now;
  } catch {
    // fall through to the instance-table anchor
  }
  const rows = await suiteql(
    `SELECT MAX(TO_CHAR(timestampcreated,'${TS_FMT}')) AS now FROM scheduledscriptinstance`,
  );
  return rows[0]?.now;
}

function minusMinutes(ts, minutes) {
  const d = new Date(`${ts.replace(' ', 'T')}Z`); // naive math; tz cancels out
  d.setUTCMinutes(d.getUTCMinutes() - minutes);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSince(s) {
  const m = /^(\d+)([mh])$/.exec(s || '60m');
  if (!m) usage('bad --since (want e.g. 45m or 2h)');
  return m[2] === 'h' ? Number(m[1]) * 60 : Number(m[1]);
}

async function instanceRows(where) {
  return suiteql(
    `SELECT taskid, status, mapreducestage, percentcomplete,
            TO_CHAR(timestampcreated,'${TS_FMT}') AS ts
     FROM scheduledscriptinstance
     WHERE ${where}
     ORDER BY timestampcreated DESC`,
  );
}

function verdict(rows) {
  if (rows.length === 0) return 'NOT_VISIBLE';
  const statuses = rows.map((r) => r.status);
  // A yielding MR re-queues MAP and CANCELs the rest of the pipeline rows each
  // yield, so CANCELED (NetSuite's spelling) rows are normal mid-run noise.
  const active = rows.find((r) => r.status === 'PROCESSING' || r.status === 'RETRY');
  if (active) return `RUNNING (${active.mapreducestage})`;
  if (statuses.includes('FAILED')) return 'FAILED';
  if (statuses.every((s) => s === 'PENDING')) return 'QUEUED';
  if (statuses.includes('PENDING')) return 'RUNNING (between stages)';
  // Terminal: only COMPLETE / CANCELED rows remain. A COMPLETE SUMMARIZE row
  // means the run finished; cancel-noise without one means it was killed.
  if (rows.some((r) => r.mapreducestage === 'SUMMARIZE' && r.status === 'COMPLETE')) return 'COMPLETE';
  if (statuses.some((s) => s.startsWith('CANCEL'))) return 'CANCELLED';
  return 'COMPLETE';
}

function groupByTask(rows) {
  const tasks = new Map();
  for (const r of rows) {
    if (!tasks.has(r.taskid)) tasks.set(r.taskid, []);
    tasks.get(r.taskid).push(r);
  }
  return tasks;
}

function printTask(taskid, rows) {
  const stages = rows
    .slice()
    .reverse()
    // mapreducestage is null for plain scheduled scripts (SCHEDSCRIPT_* taskids)
    .map((r) => `${r.mapreducestage ?? '-'}:${r.status}${r.status === 'PROCESSING' ? ` ${r.percentcomplete}%` : ''}`)
    .join('  ');
  console.log(`  ${taskid}`);
  console.log(`    seen ${rows[rows.length - 1].ts} -> ${rows[0].ts}  verdict: ${verdict(rows)}`);
  console.log(`    ${stages}`);
}

async function maxLogId(script) {
  const rows = await suiteql(
    `SELECT MAX(internalid) AS marker FROM scriptnote
     WHERE scripttype IN (SELECT id FROM script WHERE scriptid = '${script}')`,
  );
  return Number(rows[0]?.marker || 0);
}

async function logRows(script, { afterId, tail, errorsOnly }) {
  const filters = [
    `scripttype IN (SELECT id FROM script WHERE scriptid = '${script}')`,
  ];
  if (afterId) filters.push(`internalid > ${afterId}`);
  if (errorsOnly) filters.push(`type = 'ERROR'`);
  // After a marker we read forward (oldest first); a plain tail reads backward.
  const order = afterId ? 'ASC' : 'DESC';
  const top = afterId ? 500 : Number(tail || 20);
  const rows = await suiteql(
    `SELECT TOP ${top} internalid, type, title, TO_CHAR(date,'YYYY-MM-DD') AS d,
            SUBSTR(detail, 1, 1500) AS detail
     FROM scriptnote
     WHERE ${filters.join(' AND ')}
     ORDER BY internalid ${order}`,
  );
  return afterId ? rows : rows.reverse();
}

function parseSummary(row) {
  if (row.type !== 'AUDIT') return null;
  try {
    const j = JSON.parse(row.detail);
    if ('mapErrors' in j && 'reduceErrors' in j) return j;
  } catch {
    /* not a summary row */
  }
  return null;
}

function printLogRow(row) {
  const summary = parseSummary(row);
  if (summary) {
    const mapped = Object.keys(summary.mapKeys || {}).length;
    const reduced = Object.keys(summary.reduceKeys || {}).length;
    console.log(
      `  [${row.internalid}] == MR SUMMARY == mapErrors=${summary.mapErrors} reduceErrors=${summary.reduceErrors} ` +
        `mapKeys=${mapped} reduceKeys=${reduced} usage=${summary.usageConsumed} seconds=${summary.seconds} yields=${summary.yields}`,
    );
    return;
  }
  let detail = row.detail || '';
  if (row.type === 'ERROR') {
    try {
      const e = JSON.parse(detail);
      detail = `${e.name}: ${e.message}`;
    } catch {
      /* detail may embed the error JSON mid-string; print as-is */
    }
  }
  console.log(`  [${row.internalid}] ${row.type} ${row.title ?? ''} | ${detail.replace(/\s+/g, ' ').slice(0, 220)}`);
}

async function otStatuses(ids) {
  return suiteql(
    `SELECT ot.id, st.name AS status, st.scriptid AS status_sid,
            BUILTIN.DF(ot.custrecord_ord_tran_document) AS doc,
            BUILTIN.DF(ot.custrecord_ord_tran_direction) AS direction,
            ot.custrecord_ord_tran_retry_count AS retries,
            ot.custrecord_ord_tran_orderful_id AS orderful_id,
            LENGTH(ot.custrecord_ord_tran_message) AS msg_len,
            TO_CHAR(ot.lastmodified,'${TS_FMT}') AS lm,
            SUBSTR(ot.custrecord_ord_tran_error, 1, 300) AS error
     FROM customrecord_orderful_transaction ot
     LEFT JOIN customlist_orderful_transaction_status st ON st.id = ot.custrecord_ord_tran_status
     WHERE ot.id IN (${ids})`,
  );
}

function printOts(rows, ids) {
  const found = new Set(rows.map((r) => String(r.id)));
  for (const r of rows) {
    console.log(
      `  OT ${r.id}: ${r.status} [${r.status_sid}] doc=${r.doc ?? '-'} dir=${r.direction ?? '-'} ` +
        `retries=${r.retries ?? 0} orderful_id=${r.orderful_id ?? '-'} msg_len=${r.msg_len ?? 0} lastmod=${r.lm}`,
    );
    if (r.error) console.log(`    error: ${r.error.replace(/\s+/g, ' ')}`);
  }
  for (const id of ids.split(',')) {
    if (!found.has(id)) console.log(`  OT ${id}: NOT FOUND`);
  }
}

// ---------- modes ----------

console.log(`monitor-mr ${mode} | ${customerDir} | ENVIRONMENT=${envMode} (read-only queries)`);
if (envMode === 'production') console.log('NOTE: pointed at PRODUCTION. This script only SELECTs.');
console.log('');

if (mode === 'runs') {
  const minutes = parseSince(flags.since);
  const now = await accountNow();
  const since = minusMinutes(now, minutes);
  console.log(`MR task instances since ${since} (account-local; account now: ${now})`);
  const rows = await instanceRows(`timestampcreated >= TO_DATE('${since}','${TS_FMT}')`);
  const tasks = groupByTask(rows);
  if (tasks.size === 0) console.log('  (none)');
  for (const [taskid, taskRows] of tasks) printTask(taskid, taskRows);
  console.log(
    '\nscheduledscriptinstance has no script column — identify a task by triggering with a captured taskId,',
  );
  console.log('or corroborate against "logs --script <id>" for the same window.');
  process.exit(0);
}

if (mode === 'status') {
  if (!flags.task) usage('status needs --task <taskId>');
  const rows = await instanceRows(`taskid = '${flags.task}'`);
  if (rows.length === 0) {
    console.log('Task not visible in scheduledscriptinstance (yet). Instance rows can lag the');
    console.log('RESTlet response by a few seconds — poll again before concluding anything.');
    process.exit(1);
  }
  printTask(flags.task, rows);
  process.exit(verdict(rows) === 'FAILED' ? 1 : 0);
}

if (mode === 'logs') {
  if (!scriptId) usage('logs needs --script <scriptid> or --flow <flow>');
  const rows = await logRows(scriptId, {
    afterId: flags['after-id'],
    tail: flags.tail,
    errorsOnly: flags.errorsOnly,
  });
  console.log(`Execution log for ${scriptId}${flags['after-id'] ? ` after id ${flags['after-id']}` : ''}:`);
  if (rows.length === 0) console.log('  (no rows)');
  rows.forEach(printLogRow);
  const marker = rows.length ? Math.max(...rows.map((r) => Number(r.internalid))) : await maxLogId(scriptId);
  console.log(`\nmarker: ${marker}   (pass as --after-id to see only newer rows next time)`);
  process.exit(0);
}

if (mode === 'ot') {
  if (!flags.ot) usage('ot needs --ot <id,id,...>');
  printOts(await otStatuses(flags.ot), flags.ot);
  process.exit(0);
}

// ---------- watch ----------

if (!scriptId && !flags.task) usage('watch needs --flow/--script (and ideally --task)');
const intervalS = Number(flags.interval || 12);
const timeoutS = Number(flags.timeout || 600);
const flow = flags.flow ? FLOWS[flags.flow] : null;

const t0 = await accountNow();
let logMarker = flags['after-id'] ? Number(flags['after-id']) : scriptId ? await maxLogId(scriptId) : 0;
const baselineTasks = new Set(
  (await instanceRows(`timestampcreated >= TO_DATE('${minusMinutes(t0, 30)}','${TS_FMT}')`)).map((r) => r.taskid),
);
// OT lastmodified baseline: any save (even Error -> Error again) advances it,
// so "every watched OT moved past its baseline" is a trustworthy completion
// signal even when the deployment's log level suppresses the SUMMARY row.
const otBaseline = new Map();
if (flags.ot) {
  for (const r of await otStatuses(flags.ot)) otBaseline.set(String(r.id), r.lm);
}

console.log(`Watching${flags.task ? ` task ${flags.task}` : ''}${scriptId ? ` script ${scriptId}` : ''}`);
console.log(`t0=${t0} (account clock)  log marker=${logMarker}  interval=${intervalS}s  timeout=${timeoutS}s`);
if (flow?.note) console.log(`note: ${flow.note}`);
console.log('');

const startedAt = Date.now();
let lastVerdict = '';
let sawSummary = null;
let stageErrors = 0;
let sawLogRows = false;
let otsUpdated = false;
let finalVerdict = 'TIMEOUT';

while (Date.now() - startedAt < timeoutS * 1000) {
  // Layer 1: official status (when we have a taskid)
  let taskRows = [];
  if (flags.task) {
    taskRows = await instanceRows(`taskid = '${flags.task}'`);
    const v = verdict(taskRows);
    if (v !== lastVerdict) {
      console.log(`[${new Date().toISOString().slice(11, 19)}Z] status: ${v}`);
      lastVerdict = v;
    }
  }

  // Layer 2: new log rows past the marker (SUMMARY row = completion beacon,
  // but note it is type AUDIT and suppressed when the deployment log level is ERROR)
  if (scriptId) {
    const fresh = await logRows(scriptId, { afterId: logMarker });
    for (const row of fresh) {
      printLogRow(row);
      sawLogRows = true;
      logMarker = Math.max(logMarker, Number(row.internalid));
      if (row.type === 'ERROR') stageErrors += 1;
      const summary = parseSummary(row);
      if (summary) sawSummary = summary;
    }
  }

  // Layer 3: every watched OT saved past its baseline = the work happened
  if (otBaseline.size > 0 && !otsUpdated) {
    const current = await otStatuses(flags.ot);
    otsUpdated =
      current.length > 0 &&
      current.every((r) => (r.lm ?? '') > (otBaseline.get(String(r.id)) ?? ''));
  }

  const taskTerminal =
    flags.task && ['COMPLETE', 'FAILED', 'CANCELLED'].includes(verdict(taskRows));
  const beaconSeen = !flags.task && (sawSummary !== null || otsUpdated);
  if (taskTerminal || beaconSeen) {
    finalVerdict = flags.task ? verdict(taskRows) : otsUpdated && !sawSummary ? 'OTS_UPDATED' : 'COMPLETE';
    // One last log sweep — summarize-stage rows can land just after the status flips.
    if (scriptId) {
      await sleep(3000);
      const fresh = await logRows(scriptId, { afterId: logMarker });
      for (const row of fresh) {
        printLogRow(row);
        logMarker = Math.max(logMarker, Number(row.internalid));
        if (row.type === 'ERROR') stageErrors += 1;
        const summary = parseSummary(row);
        if (summary) sawSummary = summary;
      }
    }
    break;
  }
  await sleep(intervalS * 1000);
}

console.log('');
console.log(`== RESULT: ${finalVerdict} ==`);
if (sawSummary) {
  console.log(
    `MR summary: mapErrors=${sawSummary.mapErrors} reduceErrors=${sawSummary.reduceErrors} ` +
      `usage=${sawSummary.usageConsumed} seconds=${sawSummary.seconds} yields=${sawSummary.yields}`,
  );
  if (Object.keys(sawSummary.mapKeys || {}).length === 0 && sawSummary.mapErrors === 0) {
    console.log('mapKeys is EMPTY: getInputData selected zero rows. For inbound processing this');
    console.log('usually means the 10-minute freshness filter excluded fresh OTs — not success.');
  }
}
if (stageErrors > 0) console.log(`WARN: ${stageErrors} ERROR log row(s) during this run — read them above.`);
if (scriptId && !sawLogRows && finalVerdict !== 'TIMEOUT') {
  console.log('No log rows were captured. The deployment log level is likely ERROR, which');
  console.log('suppresses AUDIT/DEBUG rows including the auto SUMMARY — judge by OT state instead.');
}
if (finalVerdict === 'TIMEOUT') {
  console.log('Timed out. Either the task is QUEUED behind another instance (concurrency is 1 per');
  console.log('deployment) or the run is long and still going (yielding MRs can run for an hour).');
  console.log('Check "runs --since 30m" before re-triggering ANYTHING.');
}
if (scriptId) console.log(`log marker now: ${logMarker}   (resume with watch --after-id ${logMarker})`);

// Layer 3: business outputs
if (flags.ot) {
  console.log('\nOrderful Transaction state:');
  printOts(await otStatuses(flags.ot), flags.ot);
}

// Chained-task hint
const after = groupByTask(
  await instanceRows(`timestampcreated >= TO_DATE('${t0}','${TS_FMT}')`),
);
const newTasks = [...after.keys()].filter((t) => !baselineTasks.has(t) && t !== flags.task);
if (newTasks.length > 0) {
  console.log('\nNew task(s) appeared during the watch (candidate chained runs):');
  newTasks.forEach((t) => console.log(`  ${t}`));
  if (flow?.chains) {
    console.log(`This flow chains ${flow.chains}. Follow it with:`);
    console.log(
      `  node monitor-mr.mjs ${customerDir} watch --script ${flow.chains} --task <taskid-from-above>${flags.ot ? ` --ot ${flags.ot}` : ''}`,
    );
  }
}

process.exit(finalVerdict === 'FAILED' || finalVerdict === 'TIMEOUT' ? 1 : 0);
