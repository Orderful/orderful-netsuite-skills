---
name: which-script-ran
description: Given a broken/suspect Orderful transaction in a customer's NetSuite, determine WHICH SuiteApp script did (or should have done) the work and read its execution logs programmatically via SuiteQL — no NetSuite UI log-scrolling. Reconstructs a transaction's full lifecycle across every script with one query. Use when the user says "which script ran", "where are the logs for this", "check the execution log", "why did this 846/856/810 fail", "trace this transaction", "/which-script-ran", or any transaction diagnosis where you'd otherwise open Script Execution Logs in the UI.
---

# Which script ran? (and read its logs without the UI)

The SuiteApp has ~30 entry points (UEs, MRs, Suitelets, RESTlets, WAs) and the same symptom can come from different scripts depending on doc type, consolidation config, and how the run was triggered. This skill routes from symptom → script → logs, and reads the logs over SuiteQL so nobody scrolls the Execution Log UI.

The routing knowledge lives in [reference/script-execution-map.md](../../reference/script-execution-map.md) — read it alongside this. For *watching a live MR run* (marker pattern, SUMMARY beacon, task status) use [monitor-mr](../monitor-mr/SKILL.md); this skill is for **after-the-fact diagnosis**.

## When to use

- "Transaction X failed / came out wrong — which script produced it and what did it log?"
- "Why didn't an outbound 856/810/855 get created for this record?"
- "The 846 feed is wrong" (dedicated MR — see map §1)
- "Read me the script logs for <script>" / "any errors in the logs today?"
- NOT for: watching a run you just triggered (monitor-mr), inbound BDO content questions (inspect-inbound-diagnostics), Orderful-side INVALID detail (fetch-validations).

## Inputs

1. Customer `.env` dir (`~/orderful-onboarding/<slug>`) with working SuiteQL creds (netsuite-setup).
2. Any correlation handle: the Orderful Transaction (OT) internal id, the Orderful transaction id (9xxxxxxxxx), the NS record internal id or tranid (e.g. `IF303149`).

Queries run via the standard runner:

```sh
node samples/suiteql.mjs ~/orderful-onboarding/<slug> "<SQL>"
```

## Step 0 — HURRY: logs evaporate

`scriptnote` retention is **volume-purged** and can be as short as ~2 days on a busy production account (observed windows: [mapreduce-monitoring.md](../../reference/mapreduce-monitoring.md) Layer 2). If the incident is being reported live, capture logs **now**, before finishing the record-level analysis. Check the window first:

```sql
SELECT TO_CHAR(MIN(date),'YYYY-MM-DD') AS oldest, TO_CHAR(MAX(date),'YYYY-MM-DD') AS newest, COUNT(*) AS total FROM scriptnote
```

If the incident predates `oldest`, the logs are gone — fall back to record surfaces (step 1) and Orderful-side evidence.

## Step 1 — read the record before any log

The OT record answers most questions without logs. This is a diagnosis-tailored variant of mapreduce-monitoring Layer 3's spot-check query (that doc owns the field/status semantics):

```sql
SELECT ot.id, st.scriptid AS status, BUILTIN.DF(ot.custrecord_ord_tran_document) AS doc,
       BUILTIN.DF(ot.custrecord_ord_tran_direction) AS direction,
       ot.custrecord_ord_tran_retry_count AS retries,
       ot.custrecord_ord_tran_orderful_id AS orderful_id,
       ot.custrecord_ord_tran_pending_transactions AS pending_count,
       SUBSTR(ot.custrecord_ord_tran_error,1,300) AS error
FROM customrecord_orderful_transaction ot
LEFT JOIN customlist_orderful_transaction_status st ON st.id = ot.custrecord_ord_tran_status
WHERE ot.id = <otId>  -- or: ot.custrecord_ord_tran_orderful_id = '<orderfulId>'
```

Interpret what comes back against the map's §5 symptom table (e.g. **ReadyToSend** = generation crashed mid-flight) — the map owns those conclusions and the mechanisms behind them.

## Step 2 — the lifecycle query (the main move)

One query reconstructs everything every script logged about a transaction, in order, across all deployments:

```sql
SELECT TO_CHAR(n.date,'YYYY-MM-DD HH24:MI:SS') AS ts,
       s.scriptid, n.type, n.title, SUBSTR(n.detail,1,300) AS detail_head
FROM scriptnote n
JOIN script s ON s.id = n.scripttype
WHERE n.detail LIKE '%<id>%'
  AND n.date >= SYSDATE - 2
ORDER BY n.internalid
```

- Run it once per handle you have: OT internal id, Orderful id, NS record id, tranid. Different scripts log different handles.
- Fast even at scale (verified 0.8 s over 2M rows) — but keep the date window.
- `ORDER BY internalid` is the reliable sequence; `date` carries full time (via `TO_CHAR`) but internalid is the tiebreaker.
- Widen `SUBSTR` (or drop it) once you've found the interesting rows — `detail` holds the full body, including complete JSON `SuiteScriptError` with stack traces for `type='ERROR'`.

If the lifecycle query comes back empty: the id never appeared in any log detail (common for "record never created" cases) → route by scenario using the map §1/§5 and go to step 3.

## Step 3 — targeted per-script reads

Identify the script from the map (doc type + direction + trigger), then:

```sql
-- errors only, last 24h, one script
SELECT TO_CHAR(n.date,'YYYY-MM-DD HH24:MI:SS') AS ts, n.title, SUBSTR(n.detail,1,1500) AS detail
FROM scriptnote n
WHERE n.scripttype IN (SELECT id FROM script WHERE scriptid = '<scriptid>')
  AND n.type IN ('ERROR','EMERGENCY')
  AND n.date >= SYSDATE - 1
ORDER BY n.internalid DESC

-- grep by exact log title (titles catalog: the map §3-5 + mapreduce-monitoring per-flow tables)
... WHERE n.title = 'processOutboundTransaction: done' AND n.date >= SYSDATE - 1 ...

-- what's been erroring account-wide today (orientation sweep)
SELECT s.scriptid, n.type, COUNT(*) AS cnt
FROM scriptnote n JOIN script s ON s.id = n.scripttype
WHERE n.date >= SYSDATE - 1 AND s.scriptid LIKE 'customscript_orderful%'
GROUP BY s.scriptid, n.type ORDER BY s.scriptid
```

Key facts (full `scriptnote` column contract, marker pattern, and SUMMARY-beacon semantics live in [mapreduce-monitoring.md](../../reference/mapreduce-monitoring.md) Layer 2):
- **No deployment column** — logs are per *script*, which is a feature: multi-deployment scripts (see map §2 for the counts) need no deployment guessing.
- Timezone is account-local — anchor windows to the account's `SYSDATE`, not your laptop clock (the anchor idiom: mapreduce-monitoring Layer 1).

## Step 4 — interpret absence correctly

A missing log line is only evidence if it *would have* persisted:

1. **Deployment log level** gates persistence (the rule + live observation: map §6 and mapreduce-monitoring's SUMMARY-row caveat). Check this account's levels with:
   ```sql
   SELECT sd.scriptid, sd.status, sd.isdeployed, sd.loglevel
   FROM scriptdeployment sd JOIN script s ON s.id = sd.script
   WHERE s.scriptid = '<scriptid>'
   ```
   (Also shows which deployment is actually SCHEDULED in *this* account — shipping defaults: map §2.)
2. **Client-context scripts never persist logs** — browser console only (map §6).
3. **Retention** (step 0) — absence of *old* logs proves nothing.
4. The scenario may live in a **different host** than assumed — e.g. "Generate 856" button work logs in the **UE**, not the Suitelet; reprocess work logs in the **processing MR**, not the RESTlet. Route via the map §4.

## Step 5 — hand off

- Live-watch a rerun (marker → SUMMARY beacon → outputs): **monitor-mr**.
- Inbound parsed-BDO content questions: **inspect-inbound-diagnostics**.
- Outbound INVALID at Orderful: **fetch-validations** (the NS error field only says "Review transaction in Orderful").
- Outbound payload looks wrong but the connector's stored message is right: **audit-outbound-rules** (platform rules post-process after send).

## Gotchas

- The UI "Execution Log" tab is per-deployment; `scriptnote` is per-script. If someone insists "the log is empty" in the UI, they may be on the wrong deployment — the SuiteQL read is authoritative.
- Identifier collisions exist — duplicate `customdeploy1` deployment ids, duplicate "Orderful Settings Migration" UI names. Route by scriptId, always (the specific collisions: map §6).
- MR **task/stage status** is a different table (`scheduledscriptinstance`, no script column, correlate by taskid/time) — that's monitor-mr territory.
