---
name: monitor-mr
description: Watch an Orderful SuiteApp Map/Reduce run end-to-end via REST — official task status (scheduledscriptinstance), execution logs (scriptnote), and business outputs (Orderful Transaction records) — instead of guessing or telling the user to check the NetSuite UI. Use after triggering the inbound poller, a reprocess, or any MR; or when the user asks "did the poller run", "is the MR done", "why is my transaction still Pending", "watch the MapReduce", "check the script logs", or "/monitor-mr".
---

# Monitor a Map/Reduce run

Companion to [run-poller](../run-poller/SKILL.md) and [reprocess-transaction](../reprocess-transaction/SKILL.md). Those skills trigger; this one answers "did it work?" without anyone opening NetSuite.

The underlying tables, column contracts, log-title catalog per flow, and gotchas live in [reference/mapreduce-monitoring.md](../../reference/mapreduce-monitoring.md). Read it before improvising queries.

## When to use

- Right after `run-poller` or `reprocess-transaction` — these return fast while the MR runs async; this skill is the follow-through.
- The user asks whether a poll/reprocess/outbound run worked, why an Orderful Transaction is still `Pending`/`Error`, or what an MR script logged.
- Before re-triggering anything: confirm nothing is already QUEUED/PROCESSING.

## Inputs needed

1. **Customer directory** with a `.env` (same convention as every other skill). All queries are read-only SELECTs; `--env production` is acceptable for *monitoring* a prod account.
2. **The flow** being watched — one of `inbound-polling`, `inbound-processing`, `reprocess`, `outbound-consolidation`, `outbound-sending`, `outbound-status` (maps to the script id; see reference doc).
3. Whatever correlation handles exist: the `taskId` from run-poller's response, and/or the OT record id(s) in play.

## The recipe

The cardinal rule: **capture markers before triggering, then watch, then verify outputs.** Status alone never proves success.

### A. Watching an inbound poll (you have a taskId)

1. Trigger via run-poller; keep `taskId` from its response.
2. **Immediately** (the chained-task diff only sees tasks born during the watch):
   `node monitor-mr.mjs <dir> watch --flow inbound-polling --task <taskId>`
   - Blocks until the task is COMPLETE/FAILED (default timeout 600s), streaming new log rows.
   - Reports the MR SUMMARY (`mapErrors`/`reduceErrors`) and any new taskids — polling chains the processing + simplified MRs unconditionally within seconds of completing, even when it polled nothing.
3. Verify output: new OTs created since the poll —
   `SELECT COUNT(*) FROM customrecord_orderful_transaction WHERE created >= <t0>` or `ot` mode on specific ids.
4. **Set expectations on the chained processing run:** it fires seconds after polling but its batch query skips OTs modified <10 minutes ago, so freshly-polled OTs usually wait for a scheduled cycle. If the user needs one OT processed *now*, hand off to [reprocess-transaction](../reprocess-transaction/SKILL.md) (the single-id path bypasses the filter).

### B. Watching a reprocess (no taskId is returned)

1. **Before** triggering: `node monitor-mr.mjs <dir> logs --flow reprocess --tail 1` → note the printed `marker`.
2. Trigger via reprocess-transaction.
3. `node monitor-mr.mjs <dir> watch --flow reprocess --after-id <marker> --ot <otId>`
   - With no `--task`, completion is detected by the next MR SUMMARY row past the marker **or** by every watched OT's `lastmodified` advancing (`OTS_UPDATED`) — the latter is what saves you on deployments whose log level (ERROR) suppresses the SUMMARY entirely.
   - Look for the log line `Beginning to process NetSuite Orderful Transaction internalid: <otId>` to confirm the run picked up *your* record.
4. The OT status printed at the end is the authoritative outcome (`Success` / `Error` + error text / `Stale`).

**Many transactions:** trigger each reprocess (they serialize — concurrency is 1), then run a single watch with `--ot id1,id2,...` and a longer `--timeout`. Judge by OT statuses, not by counting tasks.

### C. Inbound processing on its own schedule

`node monitor-mr.mjs <dir> watch --flow inbound-processing --ot <ids> --timeout 1200` — no trigger, just wait for the next scheduled cycle's SUMMARY beacon and check the OTs. Remember the 10-minute freshness filter when judging "why wasn't it picked up".

### D. Outbound consolidation / sending

There is **no sanctioned remote trigger** for these MRs (the agent-write RESTlet only exposes inbound polling and reprocess — and don't reach for the testHook RESTlet). Nudge outbound via product paths (flip `custbody_orderful_ready_to_process_*` to re-fire the UE — see [outbound-dispatch.md](../../reference/outbound-dispatch.md)) or run the deployment from the NS UI. Then monitor exactly as above: `watch --flow outbound-consolidation` (or `outbound-sending`) `--ot <ids>`. Outbound success = OT flips toward `Success` with `orderful_id` populated; follow up in Orderful with [fetch-validations](../fetch-validations/SKILL.md) if it lands `Error`/INVALID.

### Ad-hoc forensics (no live run)

- `runs --since 2h` — what queued/ran recently (all scripts; identify by corroborating with logs).
- `logs --flow inbound-processing --tail 30 [--errors-only]` — recent history, parsed SUMMARY rows included.
- `ot --ot 123,456` — current state of specific Orderful Transactions.

## Behaviour rules

- **Never report success from task status alone.** COMPLETE + `mapErrors=3` is a failed run; COMPLETE + empty `mapKeys` processed nothing. Always read the SUMMARY and, when record ids are known, the OT statuses.
- **Never re-trigger while a task is QUEUED or PROCESSING.** Check `runs --since 30m` first; concurrency is 1 per deployment, so re-triggering only deepens the queue.
- A `QUEUED` verdict that persists for minutes usually means a scheduled instance is in flight — wait, don't escalate.
- "Task not visible yet" immediately after triggering is normal lag — poll again before concluding.
- **A silent execution log is not a silent failure.** Deployments at log level ERROR persist nothing for a clean run (not even the SUMMARY). Judge by task verdict + OT state, and say so explicitly when reporting.
- **A stale `lastmodified` is not proof the MR skipped the record.** If a record's map stage throws, the MR runs and errors without ever saving it — `retry_count` and `lastmodified` don't move (confirmed on a record that re-errors every cycle yet shows `retries=0`). For a known-broken OT, trust the taskid verdict and the AUDIT SUMMARY beacon, not OT movement. A run that keeps `OTS_UPDATED` from firing on such a record is expected, not a tool bug.
- This skill is read-only by design. It never PATCHes records, never submits tasks, and is safe against production. Anything mutating (reprocess, flag flips) belongs to the trigger skills.
- Quote exact ERROR log rows (name + message) when reporting failures — don't paraphrase stack traces into vagueness.
- Timestamps from NetSuite are account-local; Orderful API timestamps are UTC. Reconcile before claiming latency numbers.

## Reference material

- [reference/mapreduce-monitoring.md](../../reference/mapreduce-monitoring.md) — table contracts, per-flow script ids + log titles, verdict semantics, the 10-minute filter, all validated against a live account.
- [reference/outbound-dispatch.md](../../reference/outbound-dispatch.md) — why outbound rarely involves an MR at all.
- [reference/record-types.md](../../reference/record-types.md) — OT record + join-table schema.
