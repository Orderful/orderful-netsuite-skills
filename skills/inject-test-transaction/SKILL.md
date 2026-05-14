---
name: inject-test-transaction
description: Safely inject a test inbound EDI transaction (e.g., 850, 855, 856) to Orderful and verify it routes to a sandbox SuiteApp instance — never to production. Looks up the right test ISAs from the Orderful relationship, confirms NS sandbox customer wiring matches, posts the transaction, then watches the polling buckets and immediately calls confirm-retrieval if the transaction lands in a prod bucket. After a clean sandbox landing, monitors the target NS for ingest and reports the resulting record state. Use when the user says "inject a test 850", "send a test transaction to sandbox", "test the inbound JSONata change", "let's mock a 945 from the 3PL", or any other "send a synthetic EDI transaction into our system without it touching prod" scenario.
---

# Inject Test Transaction

Send a synthetic inbound EDI transaction through Orderful to a customer's sandbox NetSuite, with hard guardrails preventing accidental production processing.

This skill exists because **TEST-stream transactions can silently land in production polling buckets** when relationship routing in Orderful is misconfigured. We learned this the hard way — a sandbox-targeted test 850 was processed by production NS, creating a real Sales Order with inventory commitment. A synchronous routing-verification step would have caught it in seconds. This skill makes that step the default.

## When to use this skill

Triggers from the user:

- "Inject a test 850 to sandbox for customer X"
- "Send a synthetic 856 to validate our outbound mapping"
- "Mock a 945 coming back from the 3PL"
- "I want to test the new JSONata in sandbox — can you send a transaction?"
- "Reproduce the customer's failing 850 against our sandbox"

Do **not** use this skill for:

- Sending LIVE-stream transactions to a real trading partner (that's a different operation, no guardrails apply).
- Running a load test or batch injection (the per-transaction routing-verification step is too slow for thousands).
- Testing outbound EDI generation (those don't go through polling buckets — different flow).

## Inputs the skill needs up-front

Ask the user for:

1. **Customer slug** — directory under `~/orderful-onboarding/`. The skill uses this to load NS sandbox creds and the Orderful API key.
2. **Target Orderful relationship** — usually identified by sender ediAccountName ("Costco Dropship via Commerce Hub"), or by sender liveIsaId. The skill calls `/v3/relationships?limit=100` (paged) and matches.
3. **Doc type** — `850_PURCHASE_ORDER`, `856_SHIP_NOTICE_MANIFEST`, etc. Used both to filter the relationship and to validate the transaction type.
4. **Message body source** — either a path to a saved JSON message body (recommended), or a fixture name from `samples/` / `__e2e__/data/` in the netsuite-connector repo. The skill will rewrite the PO number / control number to a unique value but leave the rest of the message intact, since reusable bodies are the cleanest way to ensure realistic items, ship-tos, and structures.
5. **Sandbox polling bucket id** — the bucket the customer's sandbox SuiteApp polls. Required. The skill will not proceed without this — there is no way to verify routing without it.
6. **Production polling bucket id** — the bucket the customer's prod SuiteApp polls. Required. Used as a tripwire: if the test transaction shows up here instead of the sandbox bucket, the skill aborts and confirms-retrieval immediately.

If any of those are unknown, **stop and ask** — guessing here is exactly what causes the prod-write incident this skill prevents.

## The recipe

### Step 1 — Pre-flight checks (read-only)

Before posting anything, run these. All must pass.

#### 1a. Confirm the customer's NS sandbox is reachable

Use the `netsuite-setup` skill's `test-connections.mjs` against the customer's onboarding dir. If sandbox creds don't validate, stop and fix the onboarding before injecting.

#### 1b. Look up the target relationship in Orderful

Page through `/v3/relationships` and find the match. Capture:
- `id` (relationship id, for reference)
- `sender.liveIsaId`, `sender.testIsaId`, `sender.ediAccountName`
- `receiver.liveIsaId`, `receiver.testIsaId`, `receiver.organizationName`, `receiver.ediAccountId`
- `transactionType.name` — confirm it matches the user's requested doc type
- `status` (LIVE / READY / TEST / BLOCKED)

Surface the relationship to the user and confirm it's the right one before continuing. **Bail out if `senderTestIsaId === senderLiveIsaId`** — that's an "ISA collision" (we've seen this on Artika II / III / 4166-II accounts) and means TEST stream isn't distinguishable from LIVE on this relationship. Recommend the user fix the test ISA in Orderful first.

#### 1c. Confirm the customer record in NS sandbox is wired for the test ISA

Query the customer record in NS sandbox by `custentity_orderful_isa_id_test`. The expected value is the relationship's `sender.testIsaId`. If it doesn't match, the SuiteApp will fail customer matching when it polls the test transaction — and the test will fail for the wrong reason, which is hard to diagnose.

If the field is wrong, propose updating it via PATCH (single field on a single customer). Get explicit user approval before writing.

#### 1d. Confirm the relationship is configured to route TEST stream to the sandbox bucket

This is the part Orderful won't tell you directly — relationships don't expose poller-bucket assignments via the API. The closest signal is the **prior traffic pattern in each bucket**: GET `/v3/polling-buckets/<sandbox-bucket>?limit=100` and see whether prior transactions for this sender+receiver pair show up there. If they do, the relationship is presumed wired. If the bucket is empty or all traffic is for unrelated senders/receivers, **flag the uncertainty to the user** and recommend they either verify in the Orderful admin UI or accept the abort-tripwire (Step 3) as the fallback safety.

### Step 2 — Build the payload

Take the message body source. Modify only the PO number / control number to a distinctive value: `TEST-<docTypeShort>-<YYYYMMDDHHMMSS>` is the convention. This makes the injected transaction grep-able later in NS and Orderful logs.

Construct the POST body:

```jsonc
{
  "type":     { "name": "<doc-type>" },        // e.g., "850_PURCHASE_ORDER"
  "stream":   "TEST",                           // ALWAYS TEST. Refuse if user says LIVE.
  "sender":   { "isaId": "<sender.testIsaId>" },
  "receiver": { "isaId": "<receiver.testIsaId>" },
  "message":  { /* the EDI JSON body */ }
}
```

Show the user the payload (or a summary: doc type, stream, sender/receiver ISAs, modified PO number, message body length) before sending.

### Step 3 — Post + verify routing (the critical step)

POST to `https://api.orderful.com/v3/transactions`. Capture the returned `id` (Orderful transaction id).

Immediately enter a polling loop, every 3-5 seconds for up to 60 seconds:

- GET `/v3/polling-buckets/<sandbox-bucket>?limit=100` — does our `id` appear?
- GET `/v3/polling-buckets/<prod-bucket>?limit=100` — does our `id` appear?

Outcomes:

- **Found in sandbox bucket only**: continue to Step 4.
- **Found in prod bucket** (any hit, ever): **abort immediately**. POST to `/v3/polling-buckets/<prod-bucket>/confirm-retrieval` with `{ "resourceIds": ["<id>"] }` to remove it from the prod bucket. Verify removal. Then check production NS via SuiteQL for any record of the transaction (it may have been polled in the seconds before our confirm-retrieval). If it landed in prod NS, escalate to the user with the prod NS record IDs and recommended cleanup. Do not continue.
- **Found in neither after 60s**: report the unexpected state. The transaction may have been polled+confirmed by a SuiteApp before we observed it (sandbox polls every 1-5 min). Check sandbox NS for ingest in Step 4 anyway. If it shows up there, count as a sandbox landing. If it doesn't, the routing is uncertain and the user should investigate the relationship config in Orderful.

Never trust just one verification path — both buckets get checked on every poll cycle.

### Step 4 — Watch sandbox NS for ingest

After confirmed sandbox routing, switch to monitoring the customer's sandbox NS:

```sql
SELECT id, BUILTIN.DF(custrecord_ord_tran_status) AS status,
       custrecord_ord_tran_inbound_transaction AS so_id,
       custrecord_orderful_po_number AS po,
       custrecord_ord_tran_validation_results AS errors
FROM customrecord_orderful_transaction
WHERE custrecord_ord_tran_orderful_id = '<orderful-txn-id>'
```

Poll every 20-30 seconds for up to 10 minutes (sandbox SuiteApp polling cadence is typically 5-15 min). Report status transitions:

- `(not found)` → SuiteApp hasn't polled yet
- `Pending` → polled, awaiting processing
- `Success` + `so_id` populated → SO created, fetch and report its key fields (id, externalid, tranid, otherrefnum)
- `Success` + `so_id` empty → unusual; investigate
- `Failed` → report `validation_results` errors

While watching sandbox NS, also keep periodically checking that **production NS has zero record** of the transaction (defense in depth). If it ever shows up there, escalate immediately.

### Step 5 — Cleanup

After the test:
- If the SO was created in sandbox, leave it (sandbox is OK to leave artifacts in).
- If the user explicitly wants cleanup: `DELETE /record/v1/salesorder/<id>` (releases inventory commit) and `PATCH /record/v1/customrecord_orderful_transaction/<id>` with `isInactive: true` for the Orderful Transaction record (delete is usually blocked by hidden dependent records in NS).
- If anything landed in prod NS, do the cleanup there immediately and escalate to the team.

## Behaviour rules

1. **Stream is always TEST.** Refuse to construct a LIVE-stream payload from this skill, even if the user says so. LIVE-stream injection has no place in a test workflow.
2. **Both buckets are checked on every poll.** Never just check the sandbox bucket and assume.
3. **Confirm-retrieval is the abort lever.** If the transaction lands in the prod bucket, fire it within seconds — do not wait, do not ask, do not retry. The race is against the prod SuiteApp's poll cycle, which is often <60s.
4. **Test ISA must match.** Refuse to inject if the customer's NS sandbox `custentity_orderful_isa_id_test` doesn't match the relationship's `sender.testIsaId` — propose the fix first.
5. **No ISA collisions.** If the relationship has identical live and test ISAs, refuse and recommend the user fix the relationship in Orderful.
6. **Distinctive PO numbers.** Always rewrite to `TEST-<doc>-<timestamp>` so the injection is grep-able and never collides with real customer PO numbers.
7. **Per-transaction.** Don't loop this skill for batch testing. The verification step is intentionally serial; throughput is not the goal.
8. **Defense in depth on prod NS.** Even after a clean sandbox-bucket landing, periodically query prod NS during the watch window to confirm zero leakage.
9. **Never assume the relationship is wired right.** Even if the user says "I just fixed it" — verify with bucket inspection before posting. Configuration changes in Orderful sometimes lag.
10. **Surface every hop in the report.** The user should be able to read the run output and reconstruct the exact relationship match, the exact ISAs sent, the bucket-poll observations, and the NS-side state transitions.

## Outputs the skill produces

- Console-streamed step-by-step state during the run.
- `<customer-dir>/test-injections/<orderful-txn-id>.json` — full record of the run: relationship match, payload sent, bucket observations, sandbox NS state at each poll, final outcome, any cleanup performed. Useful for postmortem if anything goes wrong.

## Reference material

- See the `bulk-jsonata-update` skill for sandbox-validation flows where this skill is the validation step.
- See the `netsuite-setup` skill for the customer-creds wiring (`custentity_orderful_isa_id_test` is set there).
- Orderful API: [POST /v3/transactions](https://docs.orderful.com/), [GET /v3/polling-buckets/{id}](https://docs.orderful.com/), [POST /v3/polling-buckets/{id}/confirm-retrieval](https://docs.orderful.com/).
