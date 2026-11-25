#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.

// Whose turn is it? Builds a board of a customer's open trading partners:
// stage, who holds the next step, how long it has waited, and the evidence.
// Read-only: it only sends GET requests. See SKILL.md for how to read it.
//
// Usage:
//   node whose-turn.mjs <customer-slug> [options]
//   node whose-turn.mjs --all [options]
//
// Options:
//   --format=table|md|json|csv   output format (default: table)
//   --out=<file>                 also write the output to a file
//   --days=<n>                   how far back to read test traffic (default: 120)
//   --ours-days=<n>              flag our side after this many quiet days (default: 3)
//   --partner-days=<n>           flag the partner after this many quiet days (default: 5)
//   --cutover-days=<n>           flag Go-Live Ready partners waiting this long (default: 14)
//
// Auth: ORDERFUL_API_KEY from ~/orderful-onboarding/<slug>/.env. The org is
// read from the key itself, so ORDERFUL_ORG_ID is not needed.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.orderful.com';
const DAY_MS = 86_400_000;
const STATUS_ORDER = ['BLOCKED', 'PENDING', 'SETUP', 'TEST', 'READY', 'LIVE'];
const HOLDER_ORDER = ['OURS', 'PARTNER', 'CUTOVER', 'UNKNOWN'];

export const DEFAULTS = Object.freeze({
  lookbackDays: 120,
  oursStaleDays: 3,
  partnerChaseDays: 5,
  cutoverDays: 14,
});

// ---------------------------------------------------------------------------
// Pure logic (exported for tests)
// ---------------------------------------------------------------------------

export function daysSince(date, now) {
  if (!date) return null;
  const ms = new Date(now).getTime() - new Date(date).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / DAY_MS)) : null;
}

export function docCode(typeName) {
  return String(typeName || '?').split('_')[0];
}

export function shortDate(date) {
  if (!date) return '';
  return new Date(date).toISOString().slice(5, 10);
}

/** Which side of the partnership is the customer org on? */
export function ourRole(partnership, orgId) {
  return Number(partnership.leaderEdiAccount?.organizationId) === Number(orgId) ? 'LEADER' : 'FOLLOWER';
}

/** The EDI account on the other side of the partnership (null for an unclaimed partner). */
export function partnerOf(partnership, orgId) {
  return ourRole(partnership, orgId) === 'FOLLOWER' ? partnership.leaderEdiAccount : partnership.followerEdiAccount;
}

function partnerName(partnership, orgId) {
  const account = partnerOf(partnership, orgId);
  const envelope = ourRole(partnership, orgId) === 'FOLLOWER' ? partnership.partnerEdiEnvelope : partnership.requesterEdiEnvelope;
  return account?.name || envelope?.name || account?.organizationName || `partnership ${partnership.id}`;
}

/** Sandbox and demo partners are not real onboarding work. */
export function isTestPartner(partnership, orgId) {
  return ['test', 'demo'].includes(partnerOf(partnership, orgId)?.organizationType);
}

function isBad(tx) {
  return (
    tx.validationStatus === 'INVALID' ||
    tx.acknowledgmentStatus === 'REJECTED' ||
    tx.deliveryStatus === 'FAILED' ||
    tx.status === 'FAILED'
  );
}

function badReason(tx) {
  if (tx.validationStatus === 'INVALID') return 'invalid';
  if (tx.acknowledgmentStatus === 'REJECTED') return 'rejected by the partner';
  return 'failed delivery';
}

function latest(dates) {
  const times = dates.filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * Summarise the test-stream traffic exchanged with one partner.
 * Transactions must be fetched with withOrgId=true so `to.id` is an org id.
 */
export function summarizeTraffic(transactions, orgId) {
  const sorted = [...transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const inbound = sorted.filter((t) => Number(t.to?.id) === Number(orgId));
  const outbound = sorted.filter((t) => Number(t.to?.id) !== Number(orgId));
  const latestOutByDoc = new Map();
  for (const t of outbound) {
    const code = docCode(t.type?.name);
    if (!latestOutByDoc.has(code)) latestOutByDoc.set(code, t);
  }
  return {
    inboundCount: inbound.length,
    outboundCount: outbound.length,
    lastIn: inbound[0] || null,
    lastOut: outbound[0] || null,
    latestOutByDoc,
  };
}

function nextTaskOf(rel) {
  const task = rel.requesterNextTask;
  if (!task) return null;
  const blocked = task.status === 'blocked';
  return {
    side: (blocked ? task.blockedRole : task.role) || null,
    label: (blocked ? task.blockedByShortName : task.shortName) || task.shortName || 'Next task',
  };
}

function stageEntered(rel) {
  if (rel.status === 'READY') return rel.testCompletedAt || rel.updatedAt || rel.createdAt;
  if (rel.status === 'TEST') return rel.setupCompletedAt || rel.createdAt;
  return rel.createdAt;
}

function stageSummary(rels) {
  const counts = new Map();
  for (const r of rels) counts.set(r.status, (counts.get(r.status) || 0) + 1);
  return STATUS_ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(', ');
}

function docList(rels, direction) {
  return [...new Set(rels.filter((r) => r.direction === direction).map((r) => docCode(r.transactionTypeName)))];
}

/**
 * Decide who holds the next step for one partnership.
 *
 * @param {object} input
 * @param {object} input.partnership  row from GET /v2/trading-partnerships
 * @param {object[]} input.relationships  the customer's own relationships in it
 * @param {object} input.traffic  result of summarizeTraffic() for the test stream
 * @param {number|string} input.orgId  the customer org id
 * @param {Date|string} input.now
 * @param {object[]} [input.requestTasks]  tasks from GET /v2/trading-partnerships/{id}/tasks,
 *   only needed while the partnership has no relationships yet
 * @param {number} [input.supersededBy]  id of another partnership with the same partner that
 *   already has relationships
 * @param {object} [input.options]  thresholds, see DEFAULTS
 */
export function classifyPartnership({
  partnership,
  relationships,
  traffic,
  orgId,
  now,
  requestTasks = null,
  supersededBy = null,
  options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  const role = ourRole(partnership, orgId);
  const partner = partnerOf(partnership, orgId);
  const rels = relationships;
  const open = rels.filter((r) => r.status !== 'LIVE');
  const row = {
    partnershipId: partnership.id,
    partner: partnerName(partnership, orgId),
    partnerOrg: partner?.organizationName || null,
    docsIn: docList(rels, 'in'),
    docsOut: docList(rels, 'out'),
    statuses: stageSummary(rels),
    targetDate: partnership.goLiveTargetDate ? String(partnership.goLiveTargetDate).slice(0, 10) : null,
    openDays: daysSince(partnership.createdAt, now),
    stage: null,
    holder: null,
    nextStep: null,
    since: null,
    waitingDays: null,
    evidence: null,
    flag: null,
    notes: [],
  };

  const set = (stage, holder, nextStep, since, evidence) =>
    Object.assign(row, { stage, holder, nextStep, since, evidence, waitingDays: daysSince(since, now) });

  if (!rels.length) {
    if (partnership.isLive) {
      set('LIVE', 'DONE', '', null, 'Live, with no relationship owned by this org');
    } else {
      classifyRequest(row, set, { partnership, role, requestTasks, supersededBy });
    }
  } else if (!open.length) {
    set('LIVE', 'DONE', '', null, 'All relationships are live');
  } else if (open.some((r) => r.status === 'TEST')) {
    classifyTesting(row, set, open, traffic, opts);
  } else if (open.every((r) => r.status === 'READY')) {
    const task = open.map(nextTaskOf).find(Boolean);
    const since = latest(open.map(stageEntered));
    const who = task?.side && task.side !== role ? 'the partner' : 'the customer';
    set('READY', 'CUTOVER', task?.label || 'Send the first live document', since, `Go-Live Ready; waiting on ${who}`);
  } else {
    // Still being set up: trust the platform's own next task.
    const least = [...open].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))[0];
    const task = nextTaskOf(least);
    const holder = !task?.side ? 'UNKNOWN' : task.side === role ? 'OURS' : 'PARTNER';
    set(
      least.status,
      holder,
      task?.label || 'No next task recorded',
      least.createdAt,
      `${docCode(least.transactionTypeName)} is ${least.status}`,
    );
  }

  // Relationships that lag behind the headline stage are worth a note.
  if (row.stage === 'TEST' || row.stage === 'READY') {
    for (const r of open.filter((x) => STATUS_ORDER.indexOf(x.status) < STATUS_ORDER.indexOf('TEST'))) {
      const task = nextTaskOf(r);
      const side = !task?.side ? 'unknown side' : task.side === role ? 'our side' : 'partner side';
      row.notes.push(`${docCode(r.transactionTypeName)} still ${r.status}: ${task?.label || 'no next task'} (${side})`);
    }
  }

  if (row.holder === 'OURS' && row.waitingDays >= opts.oursStaleDays) row.flag = 'OURS-STALE';
  else if (row.holder === 'PARTNER' && row.waitingDays >= opts.partnerChaseDays) row.flag = 'CHASE';
  else if (row.holder === 'CUTOVER' && row.waitingDays >= opts.cutoverDays) row.flag = 'CUTOVER?';
  return row;
}

/**
 * No relationships yet: the trade request has not been accepted. The partnership
 * tasks say whether it is waiting on the partner or was cancelled or sent back.
 */
function classifyRequest(row, set, { partnership, role, requestTasks, supersededBy }) {
  const review = (requestTasks || []).find((t) => t.templateKey === 'reviewRequest' && !t.completedAt);
  if (review?.status === 'blocked') {
    const side = review.blockedRole || review.role;
    const reason = review.blockedOtherReason || review.blockedByShortName || 'Unblock the trade request';
    if (side === role && supersededBy) {
      return set('CANCELLED', 'DONE', '', null, `Request cancelled; partnership ${supersededBy} replaced it`);
    }
    return set(
      'REQUEST',
      side === role ? 'OURS' : 'PARTNER',
      reason,
      review.blockedAt || partnership.createdAt,
      'Trade request is blocked',
    );
  }
  const side = review?.role || 'LEADER';
  return set(
    'REQUEST',
    side === role ? 'OURS' : 'PARTNER',
    'Accept the trade request',
    review?.createdAt || partnership.createdAt,
    'Trade request not accepted yet',
  );
}

/**
 * Testing is where the platform's task roles mislead: an outbound "Create test
 * transaction" is always shown as ours, even when no test order has arrived to
 * answer. So testing is decided from the test traffic itself.
 */
function classifyTesting(row, set, open, traffic, opts) {
  const testing = open.filter((r) => r.status === 'TEST');
  const outDocs = [...new Set(testing.filter((r) => r.direction === 'out').map((r) => docCode(r.transactionTypeName)))];
  const inDocs = [...new Set(testing.filter((r) => r.direction === 'in').map((r) => docCode(r.transactionTypeName)))];
  const entered = latest(testing.map(stageEntered));
  const { lastIn, lastOut, latestOutByDoc, inboundCount, outboundCount } = traffic;
  const counts = `${inboundCount} test in, ${outboundCount} test out in ${opts.lookbackDays} d`;

  const bad = outDocs.map((d) => latestOutByDoc.get(d)).filter((t) => t && isBad(t));
  if (bad.length) {
    const t = bad[0];
    return set(
      'TEST',
      'OURS',
      `Fix the test ${docCode(t.type?.name)}: ${badReason(t)}`,
      t.createdAt,
      `tx ${t.id} sent ${shortDate(t.createdAt)}; ${counts}`,
    );
  }

  if (lastIn) {
    const inAt = new Date(lastIn.createdAt);
    const owed = outDocs.filter((d) => {
      const sent = latestOutByDoc.get(d);
      return !sent || new Date(sent.createdAt) < inAt;
    });
    const inDoc = docCode(lastIn.type?.name);
    if (owed.length) {
      return set(
        'TEST',
        'OURS',
        `Send the test ${owed.join(', ')} for the ${inDoc} received ${shortDate(lastIn.createdAt)}`,
        latest([lastIn.createdAt, lastOut?.createdAt]),
        `${inDoc} ${lastIn.businessNumber || lastIn.id} in; ${counts}`,
      );
    }
    if (outDocs.length) {
      return set(
        'TEST',
        'PARTNER',
        `Review the test ${outDocs.join(', ')} sent by ${shortDate(lastOut.createdAt)}`,
        lastOut.createdAt,
        `every outbound document answered the ${inDoc} of ${shortDate(lastIn.createdAt)}; ${counts}`,
      );
    }
    return set(
      'TEST',
      'OURS',
      `Confirm the test ${inDoc} processed, then mark it tested`,
      lastIn.createdAt,
      `${inDoc} ${lastIn.businessNumber || lastIn.id} in; ${counts}`,
    );
  }

  if (inDocs.length) {
    return set(
      'TEST',
      'PARTNER',
      `Send a test ${inDocs.join(', ')} (or inject one ourselves)`,
      entered,
      `no test document received; ${counts}`,
    );
  }

  const unsent = outDocs.filter((d) => !latestOutByDoc.has(d));
  if (unsent.length || !lastOut) {
    return set('TEST', 'OURS', `Send the first test ${(unsent.length ? unsent : outDocs).join(', ')}`, entered, counts);
  }
  return set(
    'TEST',
    'PARTNER',
    `Review the test ${outDocs.join(', ')} sent by ${shortDate(lastOut.createdAt)}`,
    lastOut.createdAt,
    counts,
  );
}

/** Sort: our stale items first, then the partner's, then cutover, oldest first. */
export function sortRows(rows) {
  const rank = (r) => {
    const i = HOLDER_ORDER.indexOf(r.holder);
    return i === -1 ? HOLDER_ORDER.length : i;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.waitingDays ?? -1) - (a.waitingDays ?? -1));
}

/** Two partnerships with the same partner name get their id appended. */
export function disambiguate(rows) {
  const seen = new Map();
  for (const r of rows) seen.set(r.partner, (seen.get(r.partner) || 0) + 1);
  for (const r of rows) if (seen.get(r.partner) > 1) r.partner = `${r.partner} #${r.partnershipId}`;
  return rows;
}

export function summarize(rows) {
  const open = rows.filter((r) => r.holder !== 'DONE');
  const count = (pred) => open.filter(pred).length;
  return {
    partners: rows.length,
    live: rows.filter((r) => r.stage === 'LIVE').length,
    cancelled: rows.filter((r) => r.stage === 'CANCELLED').length,
    open: open.length,
    ours: count((r) => r.holder === 'OURS'),
    oursStale: count((r) => r.flag === 'OURS-STALE'),
    partner: count((r) => r.holder === 'PARTNER'),
    partnerToChase: count((r) => r.flag === 'CHASE'),
    cutover: count((r) => r.holder === 'CUTOVER'),
    unknown: count((r) => r.holder === 'UNKNOWN'),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HOLDER_LABEL = { OURS: 'Ours', PARTNER: 'Partner', CUTOVER: 'Cutover', UNKNOWN: '?', DONE: 'Live' };

function headline(board) {
  const s = board.summary;
  const parts = [
    `${s.ours} ours (${s.oursStale} stale)`,
    `${s.partner} with the partner (${s.partnerToChase} to chase)`,
    `${s.cutover} Go-Live Ready awaiting cutover`,
  ];
  if (s.unknown) parts.push(`${s.unknown} unclear`);
  const tail = [`${s.live} fully live`];
  if (s.cancelled) tail.push(`${s.cancelled} cancelled request${s.cancelled === 1 ? '' : 's'} hidden`);
  if (board.excludedTestPartners) tail.push(`${board.excludedTestPartners} test partner${board.excludedTestPartners === 1 ? '' : 's'} left out`);
  return `${board.org.name} (org ${board.org.id}): ${s.open} open partner${s.open === 1 ? '' : 's'}: ${parts.join(', ')}. ${tail.join(', ')}.`;
}

function cells(row) {
  return [
    row.flag || '',
    row.partner,
    // A mixed partnership shows the mix, e.g. "4 TEST, 2 READY".
    row.statuses.includes(',') ? row.statuses : row.stage,
    HOLDER_LABEL[row.holder] || row.holder,
    row.waitingDays == null ? '' : `${row.waitingDays} d`,
    row.nextStep,
    [row.evidence, ...row.notes].filter(Boolean).join(' | '),
  ];
}

const COLUMNS = ['Flag', 'Partner', 'Stage', 'Held by', 'Waiting', 'Next step', 'Evidence'];

export function renderTable(board) {
  const rows = board.rows.filter((r) => r.holder !== 'DONE').map(cells);
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const limits = [10, 30, 22, 7, 7, 58, 70];
  const table = [COLUMNS, ...rows].map((r) => r.map((c, i) => clip(String(c ?? ''), limits[i])));
  const widths = COLUMNS.map((_, i) => Math.max(...table.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [headline(board), '', line(table[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...table.slice(1).map(line)].join('\n');
}

export function renderMarkdown(board) {
  const esc = (text) => String(text ?? '').replace(/\|/g, '/');
  const rows = board.rows.filter((r) => r.holder !== 'DONE').map(cells);
  return [
    `**${headline(board)}**`,
    '',
    `| ${COLUMNS.join(' | ')} |`,
    `| ${COLUMNS.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
    '',
    `_As of ${board.generatedAt.slice(0, 16).replace('T', ' ')} UTC. "Ours" means us or the customer._`,
  ].join('\n');
}

export function renderCsv(board) {
  const header = ['org', 'orgId', 'partnershipId', 'partner', 'stage', 'holder', 'waitingDays', 'since', 'nextStep', 'flag', 'statuses', 'docsIn', 'docsOut', 'targetDate', 'openDays', 'evidence', 'notes'];
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = board.rows.map((r) =>
    [
      board.org.name, board.org.id, r.partnershipId, r.partner, r.stage, r.holder, r.waitingDays, r.since, r.nextStep, r.flag, r.statuses,
      r.docsIn.join(' '), r.docsOut.join(' '), r.targetDate, r.openDays, r.evidence, r.notes.join(' | '),
    ].map(quote).join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Orderful API (read-only)
// ---------------------------------------------------------------------------

async function apiGet(key, path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { 'orderful-api-key': key, Accept: 'application/json' } });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      // Never echo the response body here: Orderful's error text repeats the API key.
      throw new Error(`Orderful rejected the API key (HTTP ${res.status}). It may be revoked or belong to another org.`);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200).replaceAll(key, '[api key]');
      throw new Error(`GET ${path.split('?')[0]} -> HTTP ${res.status} ${body}`);
    }
    return res.json();
  }
}

// Pages by offset. The API's own "next" link repeats default query properties
// (includeNextTask) that it then rejects, and `total` is only the page size.
async function apiGetPaged(key, path, maxPages = 20) {
  const limit = 100;
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await apiGet(key, `${path}${sep}limit=${limit}&offset=${page * limit}`);
    if (Array.isArray(body)) return body;
    const data = body.data || [];
    out.push(...data);
    if (data.length < limit) break;
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function buildBoard(key, { now = new Date(), options = {} } = {}) {
  const opts = { ...DEFAULTS, ...options };
  const me = await apiGet(key, '/v3/organizations/me');
  const orgId = Number(me.id);
  const [partnerships, relationships] = await Promise.all([
    apiGet(key, '/v2/trading-partnerships'),
    apiGetPaged(key, `/v2/document-relationships?ownerId=${orgId}`),
  ]);

  const relsByPartnership = new Map();
  for (const r of relationships) {
    if (!relsByPartnership.has(r.tradingPartnershipId)) relsByPartnership.set(r.tradingPartnershipId, []);
    relsByPartnership.get(r.tradingPartnershipId).push(r);
  }

  const real = partnerships.filter((p) => !isTestPartner(p, orgId));
  const since = new Date(new Date(now).getTime() - opts.lookbackDays * DAY_MS).toISOString();
  const rows = await mapLimit(real, 4, async (partnership) => {
    const rels = relsByPartnership.get(partnership.id) || [];
    let transactions = [];
    let requestTasks = null;
    let supersededBy = null;
    if (rels.some((r) => r.status === 'TEST')) {
      const role = ourRole(partnership, orgId);
      const partnerAccountId = role === 'FOLLOWER' ? partnership.leaderEdiAccountId : partnership.followerEdiAccountId;
      transactions = await apiGetPaged(
        key,
        `/v2/transactions?ownerId=${orgId}&partnerEdiAccountId=${partnerAccountId}&stream=test&withOrgId=true&createdAtStart=${encodeURIComponent(since)}`,
        3,
      );
    } else if (!rels.length && !partnership.isLive) {
      const body = await apiGet(key, `/v2/trading-partnerships/${partnership.id}/tasks`).catch(() => null);
      requestTasks = body?.tasks || null;
      const partnerOrgId = partnerOf(partnership, orgId)?.organizationId;
      const replacement = real.find(
        (other) =>
          other.id !== partnership.id &&
          partnerOrgId &&
          partnerOf(other, orgId)?.organizationId === partnerOrgId &&
          (relsByPartnership.get(other.id) || []).length,
      );
      supersededBy = replacement?.id ?? null;
    }
    return classifyPartnership({
      partnership,
      relationships: rels,
      traffic: summarizeTraffic(transactions, orgId),
      orgId,
      now,
      requestTasks,
      supersededBy,
      options: opts,
    });
  });

  const sorted = disambiguate(sortRows(rows));
  return {
    org: { id: orgId, name: me.name },
    generatedAt: new Date(now).toISOString(),
    options: opts,
    excludedTestPartners: partnerships.length - real.length,
    summary: summarize(sorted),
    rows: sorted,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ONBOARDING_DIR = resolve(homedir(), 'orderful-onboarding');

function readApiKey(slug) {
  const path = resolve(ONBOARDING_DIR, slug, '.env');
  if (!existsSync(path)) throw new Error(`No .env for "${slug}" at ${path}. Run the netsuite-setup skill first.`);
  const match = readFileSync(path, 'utf-8').match(/^ORDERFUL_API_KEY\s*=\s*(.+)$/m);
  const key = match?.[1].trim().replace(/^['"]|['"]$/g, '');
  if (!key) throw new Error(`ORDERFUL_API_KEY is empty in ${path}.`);
  return key;
}

function allSlugs() {
  if (!existsSync(ONBOARDING_DIR)) return [];
  return readdirSync(ONBOARDING_DIR).filter((slug) => existsSync(resolve(ONBOARDING_DIR, slug, '.env'))).sort();
}

function parseArgs(argv) {
  const flags = Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? true];
    }),
  );
  const num = (name, fallback) => (flags[name] === undefined ? fallback : Number(flags[name]));
  return {
    slugs: flags.all ? allSlugs() : argv.filter((a) => !a.startsWith('--')),
    format: flags.format || 'table',
    out: typeof flags.out === 'string' ? flags.out : null,
    options: {
      lookbackDays: num('days', DEFAULTS.lookbackDays),
      oursStaleDays: num('ours-days', DEFAULTS.oursStaleDays),
      partnerChaseDays: num('partner-days', DEFAULTS.partnerChaseDays),
      cutoverDays: num('cutover-days', DEFAULTS.cutoverDays),
    },
  };
}

function render(boards, format) {
  if (format === 'json') return JSON.stringify(boards, null, 2);
  if (format === 'csv') {
    return boards.map((b, i) => (i === 0 ? renderCsv(b) : renderCsv(b).split('\n').slice(1).join('\n'))).filter(Boolean).join('\n');
  }
  return boards.map(format === 'md' ? renderMarkdown : renderTable).join('\n\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slugs.length) {
    console.error('Usage: node whose-turn.mjs <customer-slug>|--all [--format=table|md|json|csv] [--out=<file>] [--days=120]');
    console.error(`Customers with a .env: ${allSlugs().join(', ') || '(none)'}`);
    process.exit(1);
  }
  if (!['table', 'md', 'json', 'csv'].includes(args.format)) {
    console.error(`Unknown format "${args.format}". Use table, md, json or csv.`);
    process.exit(1);
  }

  const boards = [];
  let failed = 0;
  for (const slug of args.slugs) {
    try {
      boards.push(await buildBoard(readApiKey(slug), { options: args.options }));
    } catch (err) {
      failed++;
      console.error(`[${slug}] skipped: ${err.message}`);
    }
  }
  if (!boards.length) process.exit(1);

  const output = render(boards, args.format);
  console.log(output);
  if (args.out) {
    writeFileSync(args.out, `${output}\n`);
    console.error(`Wrote ${args.out}`);
  }
  if (failed) process.exitCode = 2;
}

const invokedDirectly =
  process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
