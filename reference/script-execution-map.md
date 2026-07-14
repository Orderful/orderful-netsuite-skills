# Script execution map — which script ran, and where its logs are

Every way NetSuite invokes the Orderful SuiteApp's scripts, mapped so that when a specific transaction breaks you know **exactly which script did the work and which execution log to read** — instead of scrolling every deployment's log in the UI.

Verified against SuiteApp source (~v1.22, July 2026) with every flow claim re-checked in code; file:line citations refer to `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/` in the netsuite-connector repo (lines drift across releases — treat them as starting points, not gospel).

Companions:
- [`skills/which-script-ran`](../skills/which-script-ran/SKILL.md) — the diagnosis recipe that drives this map, including **programmatic log reading via SuiteQL** (no NetSuite UI).
- [mapreduce-monitoring.md](mapreduce-monitoring.md) — watching a live MR run (task status + logs + outputs).
- [outbound-dispatch.md](outbound-dispatch.md) — deep detail on the UE dispatch gates.
- [`skills/inspect-inbound-diagnostics`](../skills/inspect-inbound-diagnostics/SKILL.md) — the inbound BDO trace record.

---

## 1. Quick router — doc type → scripts → log home

**Inbound** (Orderful → NetSuite). Two hops for everything: the **poller** creates the Orderful Transaction (OT) record, the **processing MR** turns it into a NetSuite record.

| Doc type | Processing script | Creates | Log home(s) |
|---|---|---|---|
| 850 | `customscript_orderful_transaction_mr` → `850/createSalesOrder.ts` | Sales Order | "Orderful \| Transaction Process" (all 3 deployments) |
| 860 | same MR → `BuyerRequestedChangeOrderService` | SO line updates | same |
| 945 | same MR → `PartnerFulfillmentService.processPartnerFulfillmentResponse` | Item Fulfillment | same |
| 944 | same MR → `processPartnerReceiveResponse` | Item Receipt | same |
| 947 | same MR → `InventoryAdjustment947ReduceService` | Inventory Adjustment | same |
| 864 (vendor sender) | same MR → `864/textMessageHandler.ts` | Note | same |
| SIMPLIFIED_PURCHASE_ORDER | `customscript_simplified_in_process_mr` | Sales Order | "Simplified Inbound Processing MapReduce" |
| anything else | same MR, **generic JSONata path** (requires ETT JSONata + v1/v2 writeback config) | per mapping | "Orderful \| Transaction Process" |
| *ingest itself* (record never appeared) | `customscript_orderful_inbound_mr` | the OT record | "Orderful \| Polling Inbound Transactions" |

**Outbound** (NetSuite → Orderful). The default path is **synchronous in the User Event** — for most problems the UE deployment matching the source record type is the log to read.

| Doc type | Source record | Default path (log home) | Other paths |
|---|---|---|---|
| 855 / simplified PO ack | SO (APPROVE or → Pending Fulfillment) | UE inline → `customdeploy_orderful_so_handler_ue` | consolidation MR; Generate 855 button/WA (flag-flip → UE) |
| 856 / simplified ASN | IF (SHIP or → Shipped) | UE inline → `customdeploy_orderful_if_handler_ue` | consolidation MR; Generate 856 button/WA |
| 810 (invoice) / simplified invoice | Invoice (CREATE) | UE inline → `customdeploy_orderful_inv_handler_ue` | consolidation MR; Generate 810 button/WA |
| 810 (credit memo) | Credit Memo (CREATE) | UE inline → `customdeploy_orderful_cm_handler_ue` | same (ETT `sourceTransactionType = CreditMemo`) |
| 880 | Invoice | **always status-reliant** → consolidation MR reduce | requires customer JSONata (no native default) |
| 940 | SO w/ vendor location / TO | UE inline (vendor ETT) → so/to handler deployment; multi-loc per-line variant | Generate 940 button/WA; **NOT in the scheduled MR sweep** |
| 943 | transfer-related IF / PO | UE inline via PartnerFulfillmentService → if/po handler deployment | `readyToProcessWst` flag exists but no shipped button/WA |
| 846 | none (inventory dataset/search) | **dedicated MR** `customscript_orderful_inventory_adv_mr` — "Orderful Inventory Advice Handler" | run on demand / customer-scheduled; optional `custscript_orderful_customer_ids` param |
| *post-send validation* (Pending → Success/Error) | — | `customscript_orderful_outbound_status_mr` — "Orderful Transaction Status Update" (**check all 5 deployments**) | — |

**Manual actions** log the *click* in one place and the *work* in another (§4).

---

## 2. Script census — every entry point

All ship at deployment log level **DEBUG** except where noted. "Ships NOTSCHEDULED" = the SDF object defines a recurrence but the deployment is not scheduled out of the box; scheduling is flipped per account (so **check the account's deployment, not the repo**, for live cadence).

### MapReduce scripts

| scriptId | UI name | Deployments | Trigger |
|---|---|---|---|
| `customscript_orderful_inbound_mr` | Orderful \| Polling Inbound Transactions | `customdeploy_orderful_inbound_mr` | Ships NOTSCHEDULED (PT15M recurrence defined; the SPA's `savePollingConfig` flips it SCHEDULED). Also task-created by agent-write RESTlet `triggerInboundPolling` and SPA `runInboundPoller` |
| `customscript_orderful_transaction_mr` | Orderful \| Transaction Process | `customdeploy_orderful_transaction_mr` (scheduled), `_ns` (poller-chain target), `_nss` (spare) | Chained from poller summarize; 15-min schedule; reprocess task (`custscript_orderful_single_inbound`, **no deploymentId → NetSuite picks any free deployment; check all three logs**) |
| `customscript_simplified_in_process_mr` | Simplified Inbound Processing MapReduce | `customdeploy_simplified_in_process_mr` | Chained from poller summarize; reprocess of simplified POs |
| `customscript_orderful_outbound_cons` | Orderful Outbound Consolidate MR | `customdeploy_orderful_cons_1`…`_9`, `customdeploy10`, `customdeploy11` — **all ship NOTSCHEDULED** (`customdeploy10` carries the PT15M recurrence definition) | Account-side schedule (backstop sweep of `to_be_processed` + ready flags, 30-day window / 500 cap; **`_wso`/`_wst` flags not in the sweep**); param-triggered path exists but has no shipped caller (testHook only) |
| `customscript_orderful_outboundrunctrl_mr` | Orderful Outbound RunControl MR | ⚠️ `customdeploy1` (generic id) | Task-only: chained from consolidation summarize on governance exhaustion, and from Generate & Send when an envelope has > 20 linked transactions |
| `customscript_orderful_outbound_sending` | Orderful Outbound Status-Based Sending | `customdeploy_orderful_status_send_deploy`, `customdeploy2` ("…stuck in ready-to-send state") | **Never triggered internally** — manual/external only. Picks every OT in ReadyToSend + direction Out; param `custscript_orderful_generatemessage` regenerates before sending. The recovery tool for stuck ReadyToSend and the send stage for custom-process outbound |
| `customscript_orderful_outbound_status_mr` | Orderful Transaction Status Update | `customdeploy_orderful_outbound_status_mr` (**SCHEDULED PT15M**), `customdeploy_orderful_out_stat_mr_ns_1`…`_ns_4` (task pool) | Schedule + task-chained after **every** successful send and from 846 summarize |
| `customscript_orderful_inventory_adv_mr` | Orderful Inventory Advice Handler | `customdeploy_orderful_inventory_adv_mr` | Ships NOTSCHEDULED; customer-scheduled or on-demand. Param `custscript_orderful_customer_ids` scopes a run. Does its **own JSONata** (bypasses `generateOutboundTransactionMessage`) |
| `customscript_orderful_bulk_carton_mr` | Orderful \| Bulk Carton Creation MR | `customdeploy_orderful_bulk_carton_mr` | Task from AUTO_PACK / SAVE_PACKING_APP_DATA when ≥ 20 operations |
| `customscript_orderful_bulk_unpack_mr` | Orderful \| Bulk Unpack MR | ⚠️ `customdeploy1` (generic id — same as RunControl's; different scripts) | Task from UN_PACK when large |
| `customscript_orderful_settings_migration` | ⚠️ Orderful Settings Migration | `customdeploy_orderful_settings_migration` | Enqueued only by the install script on `project:deploy` |

### User Events

| scriptId | UI name | Deployments | Role |
|---|---|---|---|
| `customscript_orderful_nstrx_handler_ue` | Orderful \| NS Transaction Handler UE | **six**: `customdeploy_orderful_so_handler_ue` (SO), `_if_` (IF), `_inv_` (Invoice), `_cm_` (CM), `_po_` (PO), `_to_` (TO) | **The outbound workhorse.** afterSubmit generates + sends inline (§3); beforeLoad injects buttons; beforeSubmit ETT sanity check. **The log lives on the deployment matching the record type** |
| `customscript_orderful_transaction_ue` | Orderful Transaction UE | `customdeploy_orderful_transaction_ue` (on the OT custom record) | beforeLoad buttons only (Reprocess / Generate & Send / Send to Orderful) |
| `customscript_orderful_feature_flag_ue` | Orderful Feature Flag UE | `customdeploy_orderful_feature_flag_ue` | Singleton guard + JSON validation on the feature-flags record |
| `customscript_orderful_doctype_ue`, `customscript_orderful_mapping_ue` (`_head`/`_line`), `customscript_orderful_itemlookup_ue`, `customscript_orderful_uom_mapping_ue` | (config-form UEs) | one each (mapping has two) | UI support on config records; errors land in their own logs |
| `customscript_orderful_outbound_ue`, `customscript_orderful_invoice_ue` | — | none | **Vestigial no-ops** (afterSubmit returns null). Ignore |

### Suitelets, RESTlets, WAs, client, SPA, install

| scriptId | UI name | Role / log home |
|---|---|---|
| `customscript_orderful_button_handler_sl` | Orderful Button Handler SL | Backend for **every** record-page button (§4). Synchronous work logs here; catch-all marker `Error while processing function: <BUTTON_FUNCTION>` |
| `customscript_orderful_spa_api_sl` | SPA API | The SPA's credentialed server actions: `validateApiKey`, `get/saveIsaConfig`, `get/savePollingConfig` (**flips the poller deployment schedule**), `runInboundPoller` (sets `custscript_oprun_run_id = manual:<ts>-<rand>`), `getPollerStatus`, `saveSubsidiaryDefaults`. Markers: `action`, `SPA API Error` |
| `customscript_orderful_agent_write_rl` | Orderful Agent Write Restlet | Actions: `triggerInboundPolling`, `reprocessTransaction` (requires `authorizedBy` + `agentPlanId`). Markers: `agentWrite: action invoked` / `: error` / `: unknown action` / `: missing attribution fields`. Audience locked to `customrole_orderful_agent_writer` |
| testHook RESTlet | (hand-created; **no SDF object**) | Dev/QA accounts only; e2e targets numeric ids via `NS_RESTLET_ID`/`NS_RESTLET_DEPLOY_ID`. All markers prefixed `testhook:` |
| 7 workflow actions: `customscript_orderful_generate_810/855/856/940_wa`, `customscript_orderful_generate_send_wa` (⚠️ deploy id abbreviated: `customdeploy_orderful_gen_send_wa`), `customscript_orderful_reprocess_wa`, `customscript_orderful_send_orderful_wa` | Orderful \| … WA | Thin wrappers over the same `action.handlers.ts` the buttons use. **No shipped workflow invokes them** — the 3 shipped `customworkflow` objects are field-display only; WAs run only where a customer account wired its own workflow. Click logs in the WA's own log; work logs downstream |
| `customscript_orderful_itemfulfillment_cs`, `customscript_orderful_enabled_config_cs` (⚠️ ships log level **ERROR**), `orderful_buttonHandler_CM` (module — no script record) | client scripts | **Client context: their log calls never persist to any execution log** — failures surface in the browser console / user dialogs only |
| `custspa_orderful` | Orderful Connector App (SPA) | Client bundle runs in the browser (no persisted logs); server piece logs nothing in practice. Persisted SPA-related logs live in the **SPA API Suitelet** and (for the packing app) the **Button Handler SL** |
| `customscript_orderful_install_sdf` | ⚠️ Orderful Settings Migration (**same UI name as the migration MR — distinguish by scriptId**) | Runs on **every** `project:deploy` (`deploy.xml <run>`). Blocks upgrades from < 1.22.0 with generate-only ETTs (`Auto Send has been removed…` aborts the deploy); enqueues the settings-migration MR; other failures swallowed as `run failed (non-fatal)` |

---

## 3. Flow details

### Inbound chain

1. **Poller** (`customscript_orderful_inbound_mr`): GETs each bucket (`custscript_orderful_polling_bucket`, limit param, 1MB max content — oversize is **failed back to Orderful, no NS record**). Sandbox skips LIVE-stream. map → `handlePolledEDIData`: ISA → entity match, ETT match by doc-type prefix, creates the OT (status **Pending**, or **Pending - Custom Process** for process-as-custom), confirms delivery back to Orderful. Unsupported doc types are failed back — *an expected-but-missing inbound record is a poller-log question, not a processing question*. summarize → task-chains the processing MR (`_ns` deployment) + simplified MR **unconditionally**.
2. **Processing MR** (`customscript_orderful_transaction_mr`): picks OTs direction=In, status NOT IN (Success, Ignore, Pending-Custom-Process, Stale) — **Error records are re-picked every cycle** — `pending_transactions` null, doc type not `simplified_*`. Then per doc type: native path (850/945/944/947/860/864) or generic-JSONata path (v1/v2 writeback). reduce creates the NS record (failed SO creates are **deleted** — no orphans). summarize → `finalizeTransactionAfterMR`: retry_count++, **Stale** at max (default 3).
3. **Reprocess** (button `RE_PROCESS` / `customscript_orderful_reprocess_wa` / agent-write `reprocessTransaction` — all → `handleReprocess`): resets retry_count, Stale→Pending, then task.creates the processing MR with `custscript_orderful_single_inbound` — this path **loads the record directly** and skips the batch query. Trigger logs where clicked; work logs in the processing MR.
4. **Custom process**: OTs at **Pending - Custom Process** are *deliberately never touched again by the SuiteApp* — a **customer-owned script** must consume them and flip the status itself. Stuck there forever ⇒ the customer's script is missing/broken; its log home is the **customer's** deployment, not any Orderful script.

The **~10-minute freshness gate**, corrected against source (July 2026): the deployment check compares `deploymentId !== scriptId` — always true — so the gate nominally applies to *every* deployment. **But** `lastmodified` is read date-only (parses to midnight), so "older than 10 minutes" is true any time after 00:10 — in practice the gate only excludes records during **00:00–00:10**. Don't reach for it to explain a stuck OT; check the SUMMARY beacon's `mapKeys` and the pending-query filters instead.

### Outbound chain

1. **UE afterSubmit** on any save of SO/IF/Invoice/CM/PO/TO — *including the `record.submitFields` that buttons/WAs use to flip `custbody_orderful_ready_to_process_*`* (that's why "Generate 856" work logs in the **UE's** log, not the Suitelet's). Routing: PO/TO/transfer-IF → PartnerFulfillmentService (940/943); everything else → `processOutboundTransaction`. Gates in order: `custbody_orderful_do_not_process` → NS-988 cheap ETT gate (`processOutboundTransaction: gated`). Every invocation ends with audit **`processOutboundTransaction: done`** carrying JSON `{recordId, recordType, path: gated|suppressed|full, elapsedMs, saved, error?}` — parse `path` before anything else.
2. **Fork on resolved consolidation method** (ETT value → per-doctype subsidiary default): **None/unset → generation + sending run inline in the UE**; a real method → deferred to the consolidation MR sweep.
3. **Consolidation MR**: map filters to consolidated ETTs and links records into envelopes; reduce checks readiness off the linked 850's Sales Orders (810 = all SOs Billed; 856 = PendingBilling/Billed; 855 = none PendingApproval; 880 always status-reliant) and then generates + sends. summarize does **not** self-chain; it hands leftover flag-clearing to the RunControl MR.
4. **Sending** always happens in the same host as generation (`createTransactionInOrderful` — POST, then status **Pending** + `orderful_id`, or **Error** + response body slice). Status **ReadyToSend** is set *at generation start* as a re-entrancy lock ⇒ **stuck ReadyToSend = generation crashed mid-flight**; recover with the Status-Based Sending MR.
5. **Status-update MR** flips Pending → Success/Error from Orderful's `validationStatus` (INVALID ⇒ error text `Review transaction in Orderful` — the detail lives only in Orderful; use fetch-validations). Non-200 GETs are silently skipped: stuck-Pending with no `status response` log line ⇒ the poll never resolved that id.
6. **846** is fully self-contained in its own MR (dataset/search input → per-customer LIN loops → own JSONata → `createVeryLargeTransactionInOrderful`), then chains the status MR.

### The JSONata override marker

Wherever generation runs, the ECT Advanced Mapping emits audit **`Outbound JSONata mapper`** / "Overriding <docType> JSON message by JSONata". Present = the override executed in that host. (Remember: the *received* payload in Orderful is post-platform-rule — see [audit-outbound-rules](../skills/audit-outbound-rules/SKILL.md) before blaming the mapping.)

### 4. Buttons — click log vs work log

Buttons are injected at beforeLoad by the two UEs; clicks POST to the Button Handler SL (`LAUNCH_PACKING_APP` excepted — it opens the SPA directly, no server log).

| Button | Work runs in / log home |
|---|---|
| Generate & Send (OT record) | **Inline in the Suitelet** (generation + send); > 20 linked txns → flag-clear chains to RunControl MR |
| Send to Orderful (OT record) | Inline in the Suitelet — **send-only**, reuses the stored message |
| Generate 855/856/810/940 (source record) | Suitelet only flips the ready flag + saves → **work logs in the NS Transaction Handler UE** deployment for that record type |
| Reprocess (OT record) | task → processing MR (any of its 3 deployments) |
| Auto Pack / Unpack / Save Packing Data | Sync in Suitelet; ≥ 20 ops → Bulk Carton / Bulk Unpack MR |
| Generate SSCC / Labels | Sync in Suitelet |

---

## 5. Symptom → first surface → next log

Check the record before any log. Full field/status semantics: outbound-dispatch.md + mapreduce-monitoring.md layer 3.

| Symptom | First surface (no log needed) | Next log + grep |
|---|---|---|
| Expected inbound never became an OT record | — | Poller log: `failUnsupportedTransactionType`, `Max Content Size Exceeded`, `Sandbox: skipping LIVE inbound transaction` |
| Inbound OT stuck Pending | `retry_count`, `pending_transactions` | Processing MR (all 3 deployments): `Inbound Processing - map` + the OT's internalid |
| Inbound OT stuck Pending, `pending_transactions` non-null | that field | same log: `summarize`, `Reduce Error` — MR died between map and summarize |
| Inbound Error, "See Validation Tab…" | child `customrecord_orderful_transaction_error` rows; `validation_results` entries with `result:false` | usually none needed; else `inboundDataProcess` / `createSalesOrder` |
| Stale status | `retry_count` ≥ max | `Transaction marked as Stale`, then the earliest failing `Inbound Processing - map` |
| Stuck Pending - Custom Process | by design | the **customer's** script log, not the SuiteApp's |
| Outbound expected but no OT created | source record: ready flag, `do_not_process`, `document_created` | UE @ record-type deployment: `processOutboundTransaction: done` (parse `path`), `: gated`, `: do-not-process` |
| Outbound OT stuck **ReadyToSend** | status + stale/empty message | UE or Consolidate MR log: `generateOutboundTransactionMessage`, `Outbound JSONata mapper`; recover via Sending MR |
| Outbound stuck Pending, `orderful_id` set | status | Status Update MR (all 5 deployments): `status response` |
| Outbound Error, `orderful_id` empty | `custrecord_ord_tran_error` = HTTP body slice | UE/MR log: `createTransactionInOrderful` |
| Outbound Error "Review transaction in Orderful" | error field | Not in NS — fetch-validations |
| Source record's ready flag stuck T | body flag | Consolidate MR (`OutboundProcessing: Reduce Stage`) or RunControl MR (`map`) |
| 846 wrong/missing | OT from the 846 MR | "Orderful Inventory Advice Handler": `getInventoryResults`, `reduce`, `Applying JSONATA transformation` |
| Message shows "Payload is too large to log" | placeholder by design (100KB guard; 846 > 200 lines) | payload was still sent — fetch from Orderful by `orderful_id` |
| Button click "did nothing" | — | Button Handler SL: `Error while processing function: <NAME>`; if it was a Generate-X button, the real work/failure is in the **UE** log |

---

## 6. Traps (learned the hard way)

- **Deployment names lie about scheduling.** Nearly everything ships NOTSCHEDULED with a recurrence *definition*; the account decides. Always check the account's deployment list for live cadence.
- **Two different scripts both deploy as `customdeploy1`** (Bulk Unpack MR, Outbound RunControl MR) — never search logs by that deployment id alone; go by script.
- **Two script records named "Orderful Settings Migration"** (the SDF install script and the migration MR) — distinguish by scriptId.
- **`customdeploy_orderful_gen_send_wa`** is abbreviated relative to its scriptId (`…generate_send_wa`) — exact-prefix searches miss it.
- **Reprocess picks any free processing-MR deployment** — grep all three, or query logs per *script* (the SuiteQL path doesn't care about deployments).
- **`custrecord_ord_tran_run_id` null is normal** — only manual SPA-triggered polls set it. It does *not* mean "never polled".
- **`transaction_status_awaiting_siblings` has no live setter** (legacy); `do_not_process` is only ever human-set.
- **Client-context logging (client scripts, the button CM, SPA client) never persists** — browser console only.
- **Deployment log level gates what persists** — a deployment at ERROR keeps nothing from a clean run (the ETT config client script ships at ERROR; accounts sometimes raise levels on noisy MRs).
