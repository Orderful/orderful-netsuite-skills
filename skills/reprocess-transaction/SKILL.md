---
name: reprocess-transaction
description: Reprocess a single inbound Orderful Transaction in a NetSuite customer's account by calling the SuiteApp's agent-write RESTlet. Use when a previously-failed (or stale) inbound transaction needs another run through the inbound MapReduce, or the user says things like "/reprocess-transaction", "reprocess <id> for <customer>", "retry transaction <id>", "rerun the inbound MR for <id>", or "reprocess this 850".
---

# Reprocess Transaction

Triggers `customscript_orderful_transaction_mr` (the inbound MapReduce) for a single Orderful Transaction record by POSTing `{ "action": "reprocessTransaction", "recordId": <id> }` to the SuiteApp's `customscript_orderful_agent_write_rl` RESTlet over TBA.

The handler (`handleReprocess` in the SuiteApp) loads the transaction, resets `custrecord_ord_tran_retry_count` to 0, resets the status from `Stale` to `Pending` if applicable, then dispatches the inbound MR with the single transaction's internal ID. This is the same code path the **Reprocess** button on the transaction record runs.

## When to use this skill

- "reprocess transaction 39449 for cambridge-pavers"
- "retry the failing 850 — internal id 39449"
- "the customer's PO failed; rerun it"
- "/reprocess-transaction 39449"
- "this transaction is Stale, kick it back to Pending"

## Inputs the skill needs

- **Customer slug** — which `~/orderful-onboarding/<slug>/` to use. Ask if not specified; list the available dirs.
- **Transaction internal ID** — the `id` of the row in `customrecord_orderful_transaction`. This is the NetSuite internal ID, not the Orderful UUID.

If the user only has the Orderful UUID, ask them to look up the corresponding NS internal ID in NetSuite first (search `customrecord_orderful_transaction` by `custrecord_ord_tran_orderful_id`).

## The recipe

### Step 1 — Pick the customer

List `~/orderful-onboarding/` and confirm which customer the user wants. If the dir has no `.env`, stop and direct the user to `/netsuite-setup`.

### Step 2 — Run the script

```sh
node <path-to-this-skill>/reprocess-transaction.mjs ~/orderful-onboarding/<slug> <transaction-id>
```

The script:

1. Loads the customer's `.env` and picks `NS_SB_*` or `NS_PROD_*` based on `ENVIRONMENT`.
2. **Looks up the transaction's current status** via SuiteQL. This is a guard rail — calling reprocess on certain statuses is a no-op or actively harmful (see [Status guard](#status-guard) below).
3. If the status is not eligible for reprocess, exits with a clear explanation and does **not** call the RESTlet.
4. If eligible, TBA-signs a POST to the RESTlet with `{ "action": "reprocessTransaction", "recordId": <id> }`.
5. Prints the response.

### Step 3 — Read the result

A successful response looks like:

```json
{ "status": "success", "recordId": 39449 }
```

The MR is now queued in NetSuite — the actual reprocessing happens asynchronously. To verify completion:

- **Customization > Scripting > Map/Reduce Script Status** → look for the most recent run of `customscript_orderful_transaction_mr`
- Or check the `customrecord_orderful_transaction` row directly — its status should transition (e.g., `Error` → `Pending` → `Processing` → `Success` or `Error`) and `custrecord_ord_tran_retry_count` should reset to 0

## Status guard

`orderful_inboundProcessing_MR.queryPendingInboundOrderfulTransactions()` excludes transactions whose status is `Success`, `Ignore`, `PendingCustomProcess`, or `Stale` from its bulk processing pass. The single-transaction reprocess path bypasses that filter — meaning if you call reprocess on a transaction in one of those statuses, the MR will load it and *try* to process it again. That's almost always wrong:

| Status | Eligible for reprocess? | Reason |
|---|---|---|
| `Error` | ✅ | The main case. Transaction failed; reprocess to retry. |
| `Stale` | ✅ | `handleReprocess` explicitly resets Stale → Pending. This is a documented use case. |
| `Pending` | ⚠️ Allowed but redundant | Already queued for the next MR pass. Reprocess will re-enqueue and reset the retry count — usually harmless but unnecessary. |
| `AwaitingSiblings` | ⚠️ Allowed but rarely useful | Transaction is waiting for a related document. Reprocess won't fix the underlying coordination issue. |
| `Success` | ❌ Refused | Transaction already processed. Reprocess re-runs the inbound logic and may create duplicate records, fire duplicate webhooks, or otherwise diverge state. Almost never what's wanted. |
| `Ignore` | ❌ Refused | Explicitly marked as do-not-process. Reprocess reverses that decision. If you really want to reprocess, change the status in NS first. |
| `PendingCustomProcess` | ❌ Refused | Under a custom processing flow. Reprocess will interfere with that flow. |
| `ReadyToSend` | ❌ Refused | Outbound transaction. The inbound MR doesn't handle these. |

The script enforces the ❌ rows; ⚠️ rows proceed but the script logs a warning.

## Required role permissions

The token's role needs all of the [base TBA permissions in `INTEGRATION-RECORD-SETUP.md`](../netsuite-setup/INTEGRATION-RECORD-SETUP.md#required-role-permissions), plus these specific ones for reprocess:

| Tab | Permission | Level | Why |
|---|---|---|---|
| Setup | SuiteScript | Full | Executes the RESTlet itself |
| Setup | SuiteScript Scheduling | (no level — just add) | Required because `handleReprocess` calls `task.create()` to submit the MapReduce |
| **Lists** | **Custom Record Entries** | **Edit** | **Required to load and save `customrecord_orderful_transaction`.** The record's access type is `CUSTRECORDENTRYPERM`, which checks this generic permission — *not* per-record-type entries on the role's Custom Record subtab |

The **Custom Record Entries** permission is the most commonly missed one. It lives on the **Lists** subtab of the role, not the Custom Record subtab. With access type `CUSTRECORDENTRYPERM`, NetSuite ignores per-record-type permissions and the custom record's own Permissions tab — only the generic Lists permission counts.

Administrator already has all three. Custom roles often have the SuiteScript permissions but not Custom Record Entries with Edit; that's the typical failure mode. See troubleshooting below for the exact error message each missing permission produces.

### Troubleshoot if needed

| Symptom | Likely cause | Fix |
|---|---|---|
| `INSUFFICIENT_PERMISSION ... custom record type Orderful Transaction` with stack trace through `loadRecord_raw` | Role lacks **Custom Record Entries** on the Lists subtab | **Setup > Users/Roles > Manage Roles > [role] > Permissions > Lists tab** — add **Custom Record Entries** = `Edit`. *Not* the per-record-type "Custom Record: Orderful Transaction" entry — that's ignored under this access type |
| `INSUFFICIENT_PERMISSION` with message *"You need the 'SuiteScript' permission..."* | Role lacks **SuiteScript** | **Setup > Users/Roles > Manage Roles > [role] > Permissions > Setup tab** — add **SuiteScript** = `Full` |
| `INSUFFICIENT_PERMISSION` with no specific permission named, after the load+save succeeds | Role can't submit MapReduce tasks via `task.create()` | **Setup > Users/Roles > Manage Roles > [role] > Permissions > Setup tab** — add **SuiteScript Scheduling** (no level — just add the row) |
| 404 with `SSS_INVALID_SCRIPTLET_ID` (or `INVALID_LOGIN_INVALID_SCRIPT_ID` on older accounts) | Customer's installed SuiteApp version is older than the agent-write RESTlet | Upgrade the SuiteApp via `My SuiteApps` to the version that includes [NS-926](https://orderful.atlassian.net/browse/NS-926); or fall back to clicking **Reprocess** on the transaction record in the NS UI |
| Script refuses with `Status is "Success" — refusing to reprocess.` | The transaction already processed successfully | This is the status guard. If you genuinely need to reprocess (e.g., need to regenerate downstream records after a config change), change the status in NS first — but understand you may create duplicates |
| Script refuses with `Status is "Ignore"` or `"PendingCustomProcess"` | Same — refused for safety | Change the status in NS first if you truly need to reprocess |
| MR completes but the transaction is back in `Error` status | The underlying processing problem isn't fixed | Reprocess re-runs the same logic. Diagnose the error message on the transaction record (`custrecord_ord_tran_error`) before retrying — reprocess loops won't help |

## Behaviour rules

1. **Never invoke without explicit customer slug AND transaction ID.** Ask the user for both; don't pick or guess. The transaction ID must be the NetSuite internal ID, not the Orderful UUID.
2. **Honor the status guard.** Don't suggest workarounds (e.g., "change the status to Error first") just to bypass the refusal. If the user truly intends to reprocess a successful transaction, they should make that decision deliberately in the NS UI.
3. **Don't poll for completion in this skill.** The MR is asynchronous. Return the success response and direct the user to the Map/Reduce Script Status page if they want to confirm.
4. **Don't assume sandbox vs. production.** The script reads `ENVIRONMENT` from the `.env`. If the user expected production but the env says sandbox (or vice versa), ask before changing.
5. **One transaction per invocation.** No batch mode. If the user wants to reprocess multiple, run the skill multiple times — they can decide which IDs deserve retry.
6. **Don't paste TBA secrets into chat.** Everything stays in the `.env`; the script reads it locally.
7. **If reprocess succeeds but the transaction lands back in Error, don't loop.** Diagnose the underlying error first. Repeated reprocess calls on a structurally-broken transaction don't help and pollute the audit trail.

## Reference material

- The agent-write RESTlet (the endpoint this skill posts to): `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/ConfigAndUISupport/orderful_agentWrite_RL.ts` in the [netsuite-connector](https://github.com/Orderful/netsuite-connector) repo. Action used here: `reprocessTransaction`
- The reprocess handler: `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/TransactionHandling/common/action.handlers.ts` → `handleReprocess`
- The MR being dispatched: `customscript_orderful_transaction_mr` — defined in `Objects/customscript_orderful_transaction_mr.xml` (entry point: `TransactionHandling/orderful_inboundProcessing_MR.ts`)
- Transaction status enum: `Models/orderful_transaction.ts` → `OrderfulTransactionStatus`
- Status filter logic (which statuses the MR's bulk pass excludes): `Repositories/orderful_transaction.repository.ts` → `queryPendingInboundOrderfulTransactions`
- Custom record schema: [`reference/record-types.md`](../../reference/record-types.md) §`customrecord_orderful_transaction`
- Companion skill: [`/run-poller`](../run-poller/SKILL.md) — triggers the same MR but for *all* pending transactions, not a single one
- Companion skill: [`/reconcile-860-with-so`](../reconcile-860-with-so/SKILL.md) — when reconciling change orders against open Sales Orders across an ERP cutover, that skill identifies which `customrecord_orderful_transaction` rows (if any) need reprocessing through this one
