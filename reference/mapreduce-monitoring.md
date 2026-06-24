# Map/Reduce monitoring — official status, execution logs, and outputs

How to watch an Orderful SuiteApp Map/Reduce run from the outside (REST/SuiteQL only, no NetSuite UI), and how to answer "did it actually work?" for the four flows we trigger most: inbound polling, inbound processing, reprocess, and the outbound consolidation/sending MRs.

Everything here was validated 2026-06-10 against a live production account via SuiteQL over REST. Column sets and gotchas are empirical, not guessed from the Records Catalog.

## TL;DR — the three layers

An MR run leaves evidence in three places. Check them in this order:

1. **Official task status** — `scheduledscriptinstance` table, keyed by `taskid`. Tells you queued / which stage / complete / failed. Cannot tell you *what* the script did.
2. **Execution log** — `scriptnote` table, keyed by script. Tells you what the script logged, including the auto-emitted end-of-run SUMMARY row (`mapErrors` / `reduceErrors` counts). This is the canonical "the run finished, and here's whether stages threw" signal.
3. **Business outputs** — `customrecord_orderful_transaction` (OT) statuses, `customrecord_orderful_edi_trx_join` links, created NS records, `customrecord_orderful_transaction_error` rows. The only layer that answers "did the work I care about happen?"

A run can be COMPLETE at layer 1 with 100% errors at layer 2 and zero output at layer 3. Never report success from layer 1 alone.

The `monitor-mr` skill wraps all three layers: `runs`, `status`, `logs`, `ot`, and `watch` modes.

## Layer 1: `scheduledscriptinstance` (official MR status)

### Column contract (empirical)

Exactly these columns are exposed in SuiteQL — nothing else:

| Column | Notes |
|---|---|
| `internalid` | Opaque string key (e.g. `AAHuAeAACAAJAh0AAF`). **NOT time-ordered** — do not `ORDER BY internalid`. |
| `datecreated`, `timestampcreated` | Render date-only by default; wrap in `TO_CHAR(timestampcreated,'YYYY-MM-DD HH24:MI:SS')` to get the time. Account-local timezone. |
| `status` | `PENDING`, `PROCESSING`, `COMPLETE`, `FAILED`, `RETRY`, `CANCELED` (NetSuite's one-L spelling) |
| `mapreducestage` | `GET_INPUT`, `MAP`, `SHUFFLE`, `REDUCE`, `SUMMARIZE`; **null** for plain scheduled scripts (`SCHEDSCRIPT_*` taskids share this table) |
| `percentcomplete` | A liveness signal, not a progress bar: observed at `440.34` mid-run on a yielding MAP and stuck at `1` on COMPLETE rows. |
| `taskid` | `MAPREDUCETASK_<hash>_<hash>` — the same string the agent-write RESTlet returns from `triggerInboundPolling`. **The only correlation key.** |

These do **not** exist and will 400 the query: `script`, `scriptdeployment`, `queue`, `queueposition`, `startdate`, `enddate`. **You cannot filter this table by script.** Correlate by `taskid` when you have one; otherwise by time window + layer 2.

### Row semantics

One **row per stage** per task — a freshly queued MR shows 5 rows (all stages) with `status = PENDING` sharing one `taskid`. Stages appear **more than once** per task when the script yields (`yieldaftermins` = 60 on the Orderful MRs): each yield re-queues MAP and marks the not-yet-run downstream rows `CANCELED`, so a long run accumulates repeated `MAP:COMPLETE` groups plus CANCELED noise. Aggregate by `taskid`; don't expect exactly 5 rows.

Verdict logic for a task's row set:

- any `PROCESSING`/`RETRY` → **RUNNING** (report that row's stage — check this *before* FAILED/CANCELED, which can be stale yield noise)
- any `FAILED` → **FAILED**
- all `PENDING` → **QUEUED** (not started — possibly behind another instance; every Orderful MR deployment has `concurrencylimit = 1`)
- mix of `COMPLETE` + `PENDING` → **RUNNING** (between stages)
- only COMPLETE/CANCELED left: a `SUMMARIZE:COMPLETE` row → **COMPLETE** (at layer 1 only — now check layers 2 and 3); CANCELED rows with no completed SUMMARIZE → **CANCELLED** (killed)

### Canonical queries

Status of a known task:

```sql
SELECT mapreducestage, status, percentcomplete,
       TO_CHAR(timestampcreated,'YYYY-MM-DD HH24:MI:SS') AS ts
FROM scheduledscriptinstance
WHERE taskid = 'MAPREDUCETASK_..._...'
ORDER BY timestampcreated
```

Everything that ran/queued in a window (then aggregate by `taskid` client-side):

```sql
SELECT taskid, status, mapreducestage, percentcomplete,
       TO_CHAR(timestampcreated,'YYYY-MM-DD HH24:MI:SS') AS ts
FROM scheduledscriptinstance
WHERE timestampcreated >= TO_DATE('2026-06-10 14:00:00','YYYY-MM-DD HH24:MI:SS')
ORDER BY timestampcreated DESC
```

Timezone: `timestampcreated` is account-local. Don't compute the window boundary from your laptop's clock — anchor it to the account: `SELECT TO_CHAR(SYSDATE,'YYYY-MM-DD HH24:MI:SS') AS now FROM DUAL`, subtract your window in code, then use that string in `TO_DATE(...)`.

## Layer 2: `scriptnote` (execution log)

The per-deployment "Execution Log" UI tab is the `scriptnote` table. Restricted column set:

| Column | Notes |
|---|---|
| `internalid` | Numeric, monotonically increasing → **this is your sort key and your marker**. |
| `scripttype` | Internal id of the **script** (not the deployment). Join via `script.id` / filter via subselect on `script.scriptid`. |
| `type` | `AUDIT`, `DEBUG`, `ERROR`, `EMERGENCY`, `SYSTEM` |
| `title` | The `log.audit/error({title})` string — greppable, see the per-flow tables below. |
| `date` | Date only; no time column is exposed. Ordering comes from `internalid`. |
| `detail` | Full log body. For `type='ERROR'` it's a JSON `SuiteScriptError` (`name`, `message`, `stack`). |

`id`, `time`, `datecreated`, `created` do not exist.

### The marker pattern (do this BEFORE triggering anything)

`scriptnote` has no time column, so "what did *my* run log?" is answered with an internalid high-water mark:

```sql
-- 1. BEFORE triggering: capture the marker
SELECT MAX(internalid) AS marker FROM scriptnote
WHERE scripttype IN (SELECT id FROM script WHERE scriptid = 'customscript_orderful_transaction_mr')

-- 2. Trigger the run

-- 3. AFTER: everything new is yours
SELECT internalid, type, title, SUBSTR(detail,1,1500) AS detail
FROM scriptnote
WHERE scripttype IN (SELECT id FROM script WHERE scriptid = 'customscript_orderful_transaction_mr')
  AND internalid > <marker>
ORDER BY internalid
```

On a quiet sandbox the marker is a nicety; on production (scheduled runs every 15 minutes, possibly noisy) it is the only way to attribute log rows to your run.

### The SUMMARY row — the completion beacon

Every MR run auto-emits one `type='AUDIT'` row at the end of summarize with a JSON detail:

```json
{"mapKeys":{},"reduceKeys":{},"mapErrors":1,"reduceErrors":0,"usageConsumed":16,"seconds":0,"yields":0}
```

- A **new SUMMARY row appearing past your marker = the run finished**, even when you have no `taskid` (chained and WA-triggered runs).
- `mapErrors`/`reduceErrors` > 0 → go read the matching `summarize`-titled ERROR rows. Note these per-key ERROR rows are **also titled `summarize`** but are *not* the beacon — the beacon is the single `AUDIT` row whose detail is the `mapErrors`/`reduceErrors` JSON above. Don't mistake a stream of `summarize` ERROR rows for completion; wait for the AUDIT JSON.
- `mapKeys`/`reduceKeys` empty → getInputData selected **zero rows** — the run "succeeded" by doing nothing. For inbound processing this usually means the 10-minute freshness filter excluded your records (see below), not that they were processed.
- **Caveat: the SUMMARY row is `type=AUDIT` and obeys the deployment's log level.** A deployment set to log level ERROR persists *nothing* for a clean run — observed live: a polling MR completed end-to-end and left zero scriptnote rows. When the log is silent, fall back to layer 1 (taskid) and layer 3 (the watched records' `lastmodified` advancing — any save, even `Error` → `Error` again, bumps it).
- **Caveat: a map() that *throws* never advances its record.** The processing MR's per-record finalize (`finalizeTransactionAfterMR` — increments `retry_count`, writes the error record, trips Stale at max retries) runs in **summarize**, fed by `mapSummary.errors`. But an exception thrown inside map *before* that path still lands in `mapSummary.errors` as a generic `UNEXPECTED_ERROR` — and on a chronically-broken record the finalize itself can keep failing, so `retry_count` stays `0` and `lastmodified` stays stale **forever** while the record is re-selected every cycle. Observed live (Artika prod): OT `69823` logs `Map Error - key: 69823` every 15-minute cycle yet shows `retries=0` and a `lastmodified` months in the past. Two consequences: (a) the Stale/max-retries guard is **not** a reliable backstop against infinite loops — `queryPendingInboundOrderfulTransactions` keeps picking these up; (b) the layer-3 `lastmodified` completion heuristic **will not fire** for hard-throwing records, so for reprocess/processing watches on a known-broken OT, rely on the taskid (layer 1) and the AUDIT SUMMARY beacon, not OT movement. A perpetually-stale `lastmodified` here means "map keeps dying before write," not "the MR never ran."

## Layer 3: outputs

OT status list — **always join by `scriptid`, never hardcode internal ids.** Internal ids vary per account: one production account has `Stale - Max Retries Exceeded` at internal id **101**, not the 8 you'd guess from install order.

| scriptid | Name |
|---|---|
| `TRANSACTION_STATUS_SUCCESS` | Success |
| `TRANSACTION_STATUS_PENDING` | Pending |
| `TRANSACTION_STATUS_ERROR` | Error |
| `TRANSACTION_STATUS_AWAITING_SIBLINGS` | Pending Other Documents from PO |
| `TRANSACTION_STATUS_DO_NOT_PROCESS` | Ignore / Do Not Process |
| `TRANSACTION_STATUS_READY_TO_SEND` | Ready To Send |
| `TRANSACTION_STATUS_PENDING_CUST_PROCESS` | Pending - Custom Process |
| `TRANSACTION_STATUS_STALE` | Stale - Max Retries Exceeded |

Spot-check specific OTs (works for all four flows):

```sql
SELECT ot.id, st.name AS status, st.scriptid AS status_sid,
       BUILTIN.DF(ot.custrecord_ord_tran_document) AS doc,
       BUILTIN.DF(ot.custrecord_ord_tran_direction) AS direction,
       ot.custrecord_ord_tran_retry_count AS retries,
       ot.custrecord_ord_tran_orderful_id AS orderful_id,
       LENGTH(ot.custrecord_ord_tran_message) AS msg_len,
       SUBSTR(ot.custrecord_ord_tran_error,1,300) AS error
FROM customrecord_orderful_transaction ot
LEFT JOIN customlist_orderful_transaction_status st ON st.id = ot.custrecord_ord_tran_status
WHERE ot.id IN (<ids>)
```

Created NS records are linked via `customrecord_orderful_edi_trx_join` (see [record-types.md](record-types.md)). Per-line inbound failures land in `customrecord_orderful_transaction_error`.

## The four flows

### 1. Inbound polling MR

| | |
|---|---|
| Script / deploy | `customscript_orderful_inbound_mr` / `customdeploy_orderful_inbound_mr` |
| Trigger | agent-write RESTlet `triggerInboundPolling` ([run-poller](../skills/run-poller/SKILL.md)) — **returns `taskId`** — or the account's 15-min schedule |
| Input | Orderful polling buckets (`custscript_orderful_polling_bucket` deployment param) |
| Writes | New OT rows: status `Pending`, direction `In` (+ `Pending - Custom Process` for process-as-custom types) |
| Chains | summarize → `task.create` on `customscript_orderful_transaction_mr` (deploy `customdeploy_orderful_transaction_mr_ns`) and the simplified-PO MR — **unconditionally**, even on a zero-transaction poll; the chained taskids appear in `scheduledscriptinstance` within seconds of polling's completion |
| Key log titles | `getInput` ("Querying buckets: …"), `getInputData` ("Total transactions to be processed across buckets…"), `Error in map`, `Max Content Size Exceeded` (payload > ~1MB marked failed), `Failed to trigger processing script` |

Verify: count OTs with `created >= t0`; optionally confirm the Orderful bucket drained (polling confirm-retrieves). **Zero new OTs + a clean SUMMARY is a normal outcome** — it means the buckets were empty, not that polling failed. Check the `getInputData` log line for the fetched count.

### 2. Inbound processing MR

| | |
|---|---|
| Script | `customscript_orderful_transaction_mr` |
| Deploys | `customdeploy_orderful_transaction_mr` (scheduled, 15-min), `..._mr_ns` (target of the polling chain), `..._mr_nss` (spare) |
| Trigger | Chained from polling, scheduled, or `task.create` with param `custscript_orderful_single_inbound` (the reprocess path) |
| Input | OTs with direction `In`, status NOT IN (Success, Ignore, Pending-Custom-Process, Stale), `custrecord_ord_tran_pending_transactions` null — **note: `Error` OTs are re-picked every cycle** until max retries |
| Writes | OT → `Success` + NS record + `edi_trx_join` row; or `Error` + `customrecord_orderful_transaction_error` rows + `retry_count`++; `Stale` once retries ≥ `custscript_orderful_inbound_max_retries` (default 3) |
| Key log titles | `Inbound Processing - map` ("Beginning to process NetSuite Orderful Transaction internalid: {id}, Orderful ID: {oid}" — **your per-OT correlation hook**), `Entity lookup result`, `starting mapJsonata`/`finished mapJsonata`, `reduce: processBdo error`, `Failed to create SALES_ORDER`, `summarize` ("Map Error - key: {OT id}, error: {json}") |

**The 10-minute freshness trap.** The batch path filters to OTs whose `lastmodified` is **older than 10 minutes** (the in-code deployment check compares `deploymentId` to the *script* id, so in practice the filter applies on every deployment). Consequences:

- The chained run that fires seconds after polling usually processes **zero of the OTs that polling just created**. Expect `mapKeys: {}` in its SUMMARY. Fresh OTs get picked up by a scheduled cycle ≥10 minutes later.
- The `custscript_orderful_single_inbound` path (reprocess) loads the record directly and **bypasses the filter** — that's why reprocessing a specific id works instantly while "wait for the batch" doesn't.
- So: to push one fresh OT through *now*, reprocess it by id. To test the batch path, wait out the 10 minutes before concluding anything is broken.

### 3. Reprocess (single or many)

| | |
|---|---|
| Trigger | agent-write RESTlet `reprocessTransaction` `{recordId}` ([reprocess-transaction](../skills/reprocess-transaction/SKILL.md)); UI button uses workflow action `customscript_orderful_reprocess_wa` — same handler |
| What it does | Resets `retry_count` to 0, flips `Stale`→`Pending`, saves, then `task.create` on the processing MR with `custscript_orderful_single_inbound = <id>` |
| Returns | `{status:'success', recordId}` — **no taskId.** |
| Key log titles | `Reprocess Workflow Action`, `Reprocess Handler` ("Successfully triggered re-processing for id: {id}"), then the processing MR's titles above |

Correlate without a taskId:

1. Capture the `scriptnote` marker for `customscript_orderful_transaction_mr` **before** calling the RESTlet.
2. After: new log rows past the marker containing `internalid: <your OT id>` are your run.
3. The OT's status transition is the authoritative outcome; new `scheduledscriptinstance` taskids in the window are corroboration.

Reprocessing **many**: each RESTlet call submits its own MR task; `concurrencylimit = 1` serializes them. Don't watch N tasks — watch the OT statuses (`ot` mode with the full id list) plus one log sweep past the marker.

### 4. Outbound consolidation + sending MRs

Primary outbound dispatch is **synchronous in the User Event** — see [outbound-dispatch.md](outbound-dispatch.md) before assuming any MR is involved. The MRs in this family:

| Script | Role | Key log titles |
|---|---|---|
| `customscript_orderful_outbound_cons` (deploys `customdeploy_orderful_cons_1`…`11`) | Backstop/batch + consolidation: picks `custbody_orderful_to_be_processed` records in `custscript_orderful_backprocess_window` (default 30d, limit 500) or explicit `custscript_orderful_transaction_ids`; creates/links OTs; reduce runs readiness (`checkOutboundReadiness` / sibling completeness — `AWAITING_SIBLINGS` status lives here); sends ready ones | `OutboundProcessing: getInputData`, `created consolidated document ids`, `OutboundProcessing: Reduce Stage - readyToSend`, `summarize` |
| `customscript_orderful_outboundrunctrl_mr` | Chained from consolidation summarize; clears `to_be_processed` / `ready_to_process_*` flags on sources | `getInputData` ("Generated input data count…"), `map` ("Successfully cleared flags for {id}…") |
| `customscript_orderful_outbound_sending` (deploys `customdeploy2` = generate+send, `customdeploy_orderful_status_send_deploy` = send-only sweeper) | Picks OTs `Ready To Send` + direction `Out`, POSTs to Orderful | `getInputData` ("ready to send transactions: …"), `Outbound Transaction Sending: map` ("Orderful transaction {id} created in Orderful") |
| `customscript_orderful_outbound_status_mr` (scheduled 15-min) | Polls Orderful `validationStatus` for `Pending` outbound OTs → flips to `Success` / `Error` ("Review transaction in Orderful") | `status response` |

**There is no sanctioned remote trigger for these.** The agent-write RESTlet exposes only `triggerInboundPolling` and `reprocessTransaction`. To nudge outbound, use product paths (flip `custbody_orderful_ready_to_process_*` on the source record to re-fire the UE) or run the deployment from the NS UI. Monitoring works the same regardless of how a run started: scriptnote marker → SUMMARY beacon → OT/orderful-id verification.

Verify outbound output: the OT gains `custrecord_ord_tran_orderful_id` and flips `Ready To Send`→`Pending`→(status MR)→`Success`. A `Pending` OT with `msg_len` tiny/placeholder and no orderful id = generation short-circuited (see the oversized-message and auto-send gotchas in [outbound-dispatch.md](outbound-dispatch.md)).

## Operational gotchas

- **QUEUED ≠ broken.** `concurrencylimit = 1` per deployment: your triggered task waits behind any in-flight scheduled instance. Look for other recent taskids before re-triggering. **Never re-trigger a task that is PENDING/PROCESSING** — you'll just deepen the queue.
- **Instance rows can lag** a second or two behind the RESTlet's task submission; "taskid not found" right after triggering is normal — poll, don't conclude.
- **`Prefer: transient`** header on SuiteQL keeps these polling queries from being persisted as saved searches.
- **Polling cadence:** 10–15s intervals; inbound polling + chained processing typically lands within 1–3 minutes; budget ~10 minutes before timing out (governed accounts, yields).
- **Timezone:** scriptnote `date` and instance timestamps are account-local; reconcile before comparing to Orderful API UTC timestamps.
- The role behind the customer `.env` must be able to read `scriptnote` / `scheduledscriptinstance` (the standard Orderful integration role can).
