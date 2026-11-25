// Copyright (c) 2026 Orderful, Inc.

// Tests for the pure classification logic. Run with:
//   node --test skills/whose-turn/whose-turn.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyPartnership,
  disambiguate,
  isTestPartner,
  renderMarkdown,
  sortRows,
  summarize,
  summarizeTraffic,
} from './whose-turn.mjs';

const ORG = 100;
const NOW = '2026-11-25T12:00:00Z';

const partnership = (over = {}) => ({
  id: 1,
  createdAt: '2026-09-01T00:00:00Z',
  isLive: false,
  goLiveTargetDate: null,
  leaderEdiAccount: { id: 900, name: 'Big Retailer', organizationId: 9, organizationType: 'tradingPartner' },
  followerEdiAccount: { id: 500, name: 'Customer', organizationId: ORG, organizationType: 'customer' },
  ...over,
});

const rel = (doc, direction, status, over = {}) => ({
  transactionTypeName: `${doc}_SOMETHING`,
  direction,
  status,
  createdAt: '2026-09-02T00:00:00Z',
  setupCompletedAt: '2026-09-10T00:00:00Z',
  testCompletedAt: status === 'READY' || status === 'LIVE' ? '2026-10-20T00:00:00Z' : null,
  requesterNextTask: null,
  ...over,
});

let txId = 1000;
const tx = (doc, direction, createdAt, over = {}) => ({
  id: txId++,
  type: { name: `${doc}_SOMETHING` },
  from: { idType: 'orgId', id: direction === 'in' ? 9 : ORG },
  to: { idType: 'orgId', id: direction === 'in' ? ORG : 9 },
  createdAt,
  businessNumber: 'PO1',
  validationStatus: 'VALID',
  deliveryStatus: 'DELIVERED',
  acknowledgmentStatus: 'ACCEPTED',
  status: 'ACCEPTED',
  ...over,
});

const classify = (rels, transactions = [], over = {}) =>
  classifyPartnership({
    partnership: partnership(over.partnership),
    relationships: rels,
    traffic: summarizeTraffic(transactions, ORG),
    orgId: ORG,
    now: NOW,
    requestTasks: over.requestTasks,
    supersededBy: over.supersededBy,
    options: over.options,
  });

const order = [rel('850', 'in', 'TEST'), rel('855', 'out', 'TEST'), rel('856', 'out', 'TEST'), rel('810', 'out', 'TEST')];

test('summarizeTraffic splits inbound and outbound by the receiving org', () => {
  const t = summarizeTraffic([tx('850', 'in', '2026-11-01T00:00:00Z'), tx('855', 'out', '2026-11-02T00:00:00Z')], ORG);
  assert.equal(t.inboundCount, 1);
  assert.equal(t.outboundCount, 1);
  assert.equal(t.lastIn.type.name, '850_SOMETHING');
  assert.ok(t.latestOutByDoc.has('855'));
});

test('a test order with nothing sent back is ours', () => {
  const row = classify(order, [tx('850', 'in', '2026-11-10T00:00:00Z')]);
  assert.equal(row.holder, 'OURS');
  assert.equal(row.stage, 'TEST');
  assert.match(row.nextStep, /Send the test 855, 856, 810 for the 850 received 11-10/);
  assert.equal(row.waitingDays, 15);
  assert.equal(row.flag, 'OURS-STALE');
});

test('only the documents not yet sent after the latest order are owed', () => {
  const row = classify(order, [tx('850', 'in', '2026-11-10T00:00:00Z'), tx('855', 'out', '2026-11-24T00:00:00Z')]);
  assert.equal(row.holder, 'OURS');
  assert.match(row.nextStep, /Send the test 856, 810 /);
  assert.equal(row.waitingDays, 1, 'quiet time counts from the latest activity');
  assert.equal(row.flag, null);
});

test('a newer test order makes earlier responses owed again', () => {
  const row = classify(order, [
    tx('850', 'in', '2026-10-01T00:00:00Z'),
    tx('855', 'out', '2026-10-02T00:00:00Z'),
    tx('856', 'out', '2026-10-03T00:00:00Z'),
    tx('810', 'out', '2026-10-04T00:00:00Z'),
    tx('850', 'in', '2026-11-20T00:00:00Z'),
  ]);
  assert.equal(row.holder, 'OURS');
  assert.match(row.nextStep, /855, 856, 810/);
});

test('once every outbound document answered the order, the partner holds it', () => {
  const row = classify(order, [
    tx('850', 'in', '2026-11-01T00:00:00Z'),
    tx('855', 'out', '2026-11-02T00:00:00Z'),
    tx('856', 'out', '2026-11-03T00:00:00Z'),
    tx('810', 'out', '2026-11-10T00:00:00Z'),
  ]);
  assert.equal(row.holder, 'PARTNER');
  assert.match(row.nextStep, /Review the test 855, 856, 810 sent by 11-10/);
  assert.equal(row.waitingDays, 15);
  assert.equal(row.flag, 'CHASE');
});

test('an invalid or rejected latest outbound document is ours to fix', () => {
  const invalid = classify(order, [
    tx('850', 'in', '2026-11-01T00:00:00Z'),
    tx('856', 'out', '2026-11-20T00:00:00Z', { validationStatus: 'INVALID' }),
  ]);
  assert.equal(invalid.holder, 'OURS');
  assert.match(invalid.nextStep, /Fix the test 856: invalid/);

  const fixed = classify(order, [
    tx('850', 'in', '2026-11-01T00:00:00Z'),
    tx('855', 'out', '2026-11-02T00:00:00Z'),
    tx('810', 'out', '2026-11-02T00:00:00Z'),
    tx('856', 'out', '2026-11-20T00:00:00Z', { validationStatus: 'INVALID' }),
    tx('856', 'out', '2026-11-21T00:00:00Z'),
  ]);
  assert.equal(fixed.holder, 'PARTNER', 'a later valid copy clears the failure');

  const rejected = classify(order, [
    tx('850', 'in', '2026-11-01T00:00:00Z'),
    tx('810', 'out', '2026-11-20T00:00:00Z', { acknowledgmentStatus: 'REJECTED' }),
  ]);
  assert.match(rejected.nextStep, /Fix the test 810: rejected by the partner/);
});

test('no test order yet means the partner holds it, whatever the platform task says', () => {
  const rels = order.map((r) => ({ ...r, requesterNextTask: { status: 'pending', role: 'FOLLOWER', shortName: 'Create test transaction' } }));
  const row = classify(rels, []);
  assert.equal(row.holder, 'PARTNER');
  assert.match(row.nextStep, /Send a test 850 \(or inject one ourselves\)/);
  assert.equal(row.waitingDays, 76, 'counts from when testing opened');
});

test('an outbound-only partnership with nothing sent is ours', () => {
  const row = classify([rel('856', 'out', 'TEST')], []);
  assert.equal(row.holder, 'OURS');
  assert.match(row.nextStep, /Send the first test 856/);
});

test('an inbound-only test with a document received is ours to confirm', () => {
  const row = classify([rel('812', 'in', 'TEST'), rel('850', 'in', 'LIVE')], [tx('812', 'in', '2026-11-24T00:00:00Z')]);
  assert.equal(row.holder, 'OURS');
  assert.match(row.nextStep, /Confirm the test 812 processed/);
  assert.equal(row.statuses, '1 TEST, 1 LIVE');
});

test('Go-Live Ready partnerships wait for cutover and are flagged after two weeks', () => {
  const task = { status: 'pending', role: 'FOLLOWER', shortName: 'Send first live transaction' };
  const row = classify([rel('850', 'in', 'READY', { requesterNextTask: task }), rel('810', 'out', 'READY', { requesterNextTask: task })]);
  assert.equal(row.stage, 'READY');
  assert.equal(row.holder, 'CUTOVER');
  assert.equal(row.waitingDays, 36);
  assert.equal(row.flag, 'CUTOVER?');
  assert.match(row.evidence, /waiting on the customer/);
});

test('setup stages follow the platform task, using the blocking side when blocked', () => {
  const blocked = {
    status: 'blocked',
    role: 'FOLLOWER',
    shortName: 'Configure relationship',
    blockedRole: 'LEADER',
    blockedByShortName: 'Configure relationship',
  };
  const row = classify([rel('810', 'out', 'BLOCKED', { requesterNextTask: blocked })]);
  assert.equal(row.stage, 'BLOCKED');
  assert.equal(row.holder, 'PARTNER');
  assert.equal(row.nextStep, 'Configure relationship');

  const pending = classify([rel('810', 'out', 'SETUP', { requesterNextTask: { status: 'pending', role: 'FOLLOWER', shortName: 'Configure relationship' } })]);
  assert.equal(pending.holder, 'OURS');
});

test('a lagging relationship is noted beside the testing headline', () => {
  const blocked = { status: 'blocked', role: 'FOLLOWER', blockedRole: 'LEADER', blockedByShortName: 'Configure relationship' };
  const row = classify([...order, rel('824', 'in', 'BLOCKED', { requesterNextTask: blocked })], [tx('850', 'in', '2026-11-24T00:00:00Z')]);
  assert.equal(row.stage, 'TEST');
  assert.deepEqual(row.notes, ['824 still BLOCKED: Configure relationship (partner side)']);
});

test('a trade request not yet accepted is with the partner', () => {
  const review = { templateKey: 'reviewRequest', status: 'pending', role: 'LEADER', createdAt: '2026-07-21T00:00:00Z' };
  const row = classify([], [], { requestTasks: [review] });
  assert.equal(row.stage, 'REQUEST');
  assert.equal(row.holder, 'PARTNER');
  assert.equal(row.waitingDays, 127);
  assert.equal(row.flag, 'CHASE');
});

test('a request sent back to us is ours, unless another partnership replaced it', () => {
  const review = {
    templateKey: 'reviewRequest',
    status: 'blocked',
    role: 'LEADER',
    blockedRole: 'FOLLOWER',
    blockedOtherReason: 'Resend trade request',
    blockedAt: '2026-11-14T00:00:00Z',
  };
  const ours = classify([], [], { requestTasks: [review] });
  assert.equal(ours.holder, 'OURS');
  assert.equal(ours.nextStep, 'Resend trade request');

  const replaced = classify([], [], { requestTasks: [review], supersededBy: 77 });
  assert.equal(replaced.stage, 'CANCELLED');
  assert.equal(replaced.holder, 'DONE');
});

test('an unnamed partner falls back to the envelope name, and test partners are detected', () => {
  const unnamed = classify([], [], { partnership: { leaderEdiAccount: null, partnerEdiEnvelope: { name: 'Unclaimed Partner' } } });
  assert.equal(unnamed.partner, 'Unclaimed Partner');
  assert.equal(isTestPartner(partnership({ leaderEdiAccount: { organizationId: 3, organizationType: 'test' } }), ORG), true);
  assert.equal(isTestPartner(partnership(), ORG), false);
});

test('when the customer leads the partnership, roles flip', () => {
  const asLeader = {
    leaderEdiAccount: { id: 500, name: 'Customer', organizationId: ORG, organizationType: 'customer' },
    followerEdiAccount: { id: 900, name: 'Supplier', organizationId: 9, organizationType: 'tradingPartner' },
  };
  const review = { templateKey: 'reviewRequest', status: 'pending', role: 'LEADER', createdAt: '2026-11-20T00:00:00Z' };
  const row = classify([], [], { partnership: asLeader, requestTasks: [review] });
  assert.equal(row.partner, 'Supplier');
  assert.equal(row.holder, 'OURS');
});

test('thresholds are configurable', () => {
  const row = classify(order, [tx('850', 'in', '2026-11-23T12:00:00Z')], { options: { oursStaleDays: 1 } });
  assert.equal(row.waitingDays, 2);
  assert.equal(row.flag, 'OURS-STALE');
});

test('rows sort ours first then oldest first, and the summary counts each holder', () => {
  const rows = sortRows([
    { holder: 'CUTOVER', waitingDays: 90, stage: 'READY', flag: 'CUTOVER?' },
    { holder: 'PARTNER', waitingDays: 10, stage: 'TEST', flag: 'CHASE' },
    { holder: 'OURS', waitingDays: 2, stage: 'TEST', flag: null },
    { holder: 'OURS', waitingDays: 9, stage: 'TEST', flag: 'OURS-STALE' },
    { holder: 'DONE', waitingDays: null, stage: 'LIVE', flag: null },
    { holder: 'DONE', waitingDays: null, stage: 'CANCELLED', flag: null },
  ]);
  assert.deepEqual(rows.map((r) => `${r.holder}:${r.waitingDays}`), ['OURS:9', 'OURS:2', 'PARTNER:10', 'CUTOVER:90', 'DONE:null', 'DONE:null']);
  assert.deepEqual(summarize(rows), {
    partners: 6,
    live: 1,
    cancelled: 1,
    open: 4,
    ours: 2,
    oursStale: 1,
    partner: 1,
    partnerToChase: 1,
    cutover: 1,
    unknown: 0,
  });
});

test('duplicate partner names get the partnership id, and markdown escapes pipes', () => {
  const rows = disambiguate([
    { partner: 'Northwind Supply', partnershipId: 1 },
    { partner: 'Northwind Supply', partnershipId: 2 },
    { partner: 'Contoso Retail', partnershipId: 3 },
  ]);
  assert.deepEqual(rows.map((r) => r.partner), ['Northwind Supply #1', 'Northwind Supply #2', 'Contoso Retail']);

  const row = classify([...order, rel('824', 'in', 'SETUP')], [tx('850', 'in', '2026-11-24T00:00:00Z')]);
  const md = renderMarkdown({
    org: { id: ORG, name: 'Customer' },
    generatedAt: '2026-11-25T12:00:00.000Z',
    summary: summarize([row]),
    rows: [row],
  });
  const dataLine = md.split('\n').find((l) => l.includes('Big Retailer'));
  assert.equal(dataLine.split('|').length, 9, 'seven cells, no stray pipes from the notes');
});
