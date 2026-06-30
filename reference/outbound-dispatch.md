# Outbound dispatch flow

How a saved NetSuite source record (Invoice, Item Fulfillment, Sales Order, etc.) becomes an outbound EDI transaction posted to Orderful. Useful when a record is stuck in `Pending` and you need to know *what should have fired* and *which gates can suppress it*.

## TL;DR

- Standard outbound runs **synchronously inside the User Event** `orderful_netsuiteTrxHandler_UE.afterSubmit`. By the time the source record's save returns, the outbound transaction has been generated and POSTed to Orderful — or an error has been written to the `customrecord_orderful_transaction` row.
- The MapReduce `orderful_outboundTransactionHandling_MR.ts` is **a scheduled backstop only**, picking up records the UE didn't process (within `outboundBackProcessingWindowInDays`). The happy path never touches it.
- As of SuiteApp **v1.22.0** (NS-1037), the sole dispatch gate is the **handling preference** for the document type — a Pattern D setting resolved customer → parent customer → subsidiary default → hardcoded read-site default. With no effective handling preference, the UE creates the `customrecord_orderful_transaction` row + link but never writes the message — record stuck in `Pending`, length 0, no Orderful id, no error.
- The old ECT field `custrecord_edi_enab_trans_auto_send_asn` ("auto-send") still **exists and is visible** in NetSuite, but as of v1.22.0 it **no longer gates outbound dispatch**. (Legacy note for accounts still on SuiteApp **< v1.22.0**: there, `auto_send_asn = T` *was* the gate.) Do not confuse this with `custbody_orderful_force_autosend`, a separate and still-valid field on the source record that drives the Generate-&-Send workflow-action manual-send mechanism.

## The dispatch path on transaction submit

When a source record is saved with the relevant `custbody_orderful_ready_to_process_*` flag = T, the UE `orderful_netsuiteTrxHandler_UE` fires `afterSubmit`:

```
afterSubmit (orderful_netsuiteTrxHandler_UE.ts)
  ↓
processOutboundTransaction (TransactionHandling/common/outbound.utilities.ts)
  ↓
linkRecordToOutboundTransaction
  → creates customrecord_orderful_transaction (status = Pending)
  → creates customrecord_orderful_edi_trx_join (link to source NS record)
  ↓
readiness check
  → STATUS_RELIANT_DOCUMENT_TYPES (currently just 880 grocery invoice) take the SO-status-reliant path via checkOutboundReadiness
  → others take the simple gate: status === Pending && an effective handling preference is set for the doc type
  ↓ (if ready)
generateAndDispatchOutboundTransaction
  → switches on documentType to call generateOutbound810 / generateAndSaveASN / etc.
  → builds the EDI message (applying any JSONata override configured on the ECT)
  → POSTs to Orderful
  → updates the customrecord_orderful_transaction row with status (Success/Error) and the Orderful tx id
```

All of this happens before the source record's save returns. End-to-end latency from `record save → Orderful tx visible` is a few seconds, not a scheduled-MR cycle.

The trigger flags on the source record:

| Source record | Flag |
|---|---|
| Invoice | `custbody_orderful_ready_to_process_inv` |
| Item Fulfillment | `custbody_orderful_ready_to_process_ful` |
| Sales Order | `custbody_orderful_ready_to_process_ack` |

Some of these get auto-set by UE logic on customer-configured triggers (e.g., when `custentity_orderful_inv_handling_prefs` = `_ORDERFUL_ON_INVOICE_CREATION` on the customer record, Invoice creation auto-sets the `_inv` flag). Others require workflow logic or manual toggling via REST PATCH or the UI.

## The MR is a backstop, not the primary path

`orderful_outboundTransactionHandling_MR.ts` runs on a schedule. Its `getInputData` first checks for a `transactionIds` script parameter (used by manual batch-reprocess tooling); if absent, it queries `transaction` for records where any `custbody_orderful_ready_to_process_*` flag is `T` and `createddate >= SYSDATE - outboundBackProcessingWindowInDays` (default 30 days). It then runs the same `processOutboundTransaction` logic the UE does.

Practical implication: **the MR only catches records the UE didn't process at submit time** — typically because the UE errored, didn't fire (missing UE deployment), or the customer wasn't fully configured at the time of submit and someone later finished the setup. For a correctly-configured active customer, every save of a ready-to-process source record dispatches in the UE and you should see `Pending → Success/Error` within seconds.

**Diagnostic mistake to avoid:** seeing a record stuck in `Pending` and concluding "the MR hasn't run yet." That's almost always wrong. If the source record was saved more than a few seconds ago and the `customrecord_orderful_transaction` is still `Pending` with no Orderful id and no error, the UE saved a Pending shell but didn't dispatch. The next section covers why.

## The handling preference is the dispatch gate (v1.22.0+)

The simple readiness gate inside `processOutboundTransaction` is now `status === Pending` **plus an effective handling preference for the document type**. The handling preference is a Pattern D setting (the nullable field IS the override): the dispatcher resolves it customer → parent customer → subsidiary default → hardcoded read-site default. If it resolves to something dispatchable, the message generates and POSTs; if not, the UE leaves a `Pending` shell.

The per-document-type customer fields and their subsidiary-default backstops:

| Document type | Customer handling-pref field | Subsidiary-default field |
|---|---|---|
| 810 Invoice | `custentity_orderful_inv_handling_prefs` | `custrecord_orderful_sub_inv_hp` |
| Credit Memo | `custentity_orderful_cm_handling_prefs` | `custrecord_orderful_sub_cm_hp` |
| 855 PO Ack | `custentity_orderful_poack_handling_prefs` | `custrecord_orderful_sub_poack_hp` |
| 856 ASN | `custentity_orderful_asn_handling_prefs` | `custrecord_orderful_sub_asn_hp` |
| 940 / WSO | `custentity_orderful_wso_handling_prefs` | `custrecord_orderful_sub_wso_hp` |
| WST (TO) | `custentity_orderful_wst_handling_prefs` | `custrecord_orderful_sub_wst_hp` |
| WST (PO) | `custentity_orderful_wst_po_handling_prefs` | `custrecord_orderful_sub_wstpo_hp` |

Resolution is Pattern D: the customer field `!== undefined` stops the chain (so an explicit empty/zero counts as set); only an unset customer field falls through to the parent customer, then the subsidiary default (e.g. `custrecord_orderful_sub_inv_hp` seeds to `_ORDERFUL_ON_INVOICE_CREATION`), then the read-site hardcoded last resort.

**Setup implication:** when enabling a new outbound document type for a customer, set the handling preference for that doc type — on the customer, or rely on the subsidiary default. Otherwise the UE will create Pending rows but never dispatch them.

> **Legacy (SuiteApp < v1.22.0):** before v1.22.0 the gate was the ECT flag `custrecord_edi_enab_trans_auto_send_asn` ("auto-send"), aliased to `auto_send` in `Repositories/entity.repository.ts` and to `isAutoSendEnabled` in the Models layer. Despite the `_asn` suffix (a historical naming artifact) it gated **every** outbound type, and you set it to `T` on each outbound ECT. NS-1037 removed it as a gate in v1.22.0 — the field is still present and visible in NetSuite but no longer drives dispatch. Accounts still on < v1.22.0 must still set `auto_send_asn = T`.

`isProcessAsCustom` still routes around native generation: if the ECT's process-as-custom is effective (`custrecord_edi_enab_trans_cust_process` legacy boolean / `custrecord_edi_enab_custproc_override` override / per-doctype subsidiary default), records route through customer-built SuiteScript via the `PendingCustomProcess` status instead of native generation + dispatch.

`STATUS_RELIANT_DOCUMENT_TYPES` (currently only 880) takes the alternate `checkOutboundReadiness` path with parent-SO status logic, so 880 may behave differently if the underlying SOs aren't in the expected status. Every other type uses the simple gate above.

## Diagnostic table — record stuck in Pending

| Observation on `customrecord_orderful_transaction` | Likely cause |
|---|---|
| status = Pending, `LENGTH(custrecord_ord_tran_message) = 0`, no `custrecord_ord_tran_orderful_id`, error empty | UE created the row + link but didn't dispatch. **Most common cause (v1.22.0+):** no effective handling preference for this doc type — the customer's `custentity_orderful_*_handling_prefs` field is unset *and* the subsidiary default doesn't supply one. Set the handling preference (on the customer or the subsidiary default) and re-trigger by toggling the source record's `custbody_orderful_ready_to_process_*` flag (saving the source record re-fires the UE). On accounts still **< v1.22.0**, the equivalent cause is `custrecord_edi_enab_trans_auto_send_asn = F` on the ECT — set it to T instead. |
| status = Pending, message populated (length > 0), no Orderful id, error empty | Generation succeeded but the POST to Orderful didn't run or didn't update the row. Rare. Usually means dispatch was interrupted mid-flight (governance limit, NS failure). The MR backstop will pick it up on its next scheduled run. |
| status = Error, message populated, error = "Review transaction in Orderful", Orderful id populated | Orderful received the message and rejected validation. Pull validations via `GET /v2/organizations/{orgId}/transactions/{txId}/validations` and iterate JSONata via [`writing-outbound-jsonata`](../skills/writing-outbound-jsonata/SKILL.md). |
| status = Error, error contains a stack trace / specific exception | Generation failed before POST. Read the error text — usually a missing field, missing customer config, or a NS data issue (no cartons on IF, no Location, no shippingAddress, etc.). |

Useful confirmation query when checking outbound dispatch readiness for a customer — handling preference per doc type (with the subsidiary-default fallback), plus the process-as-custom routing flag:

```sql
SELECT c.id,
       BUILTIN.DF(c.custentity_orderful_inv_handling_prefs)   AS inv_hp,
       BUILTIN.DF(c.custentity_orderful_cm_handling_prefs)    AS cm_hp,
       BUILTIN.DF(c.custentity_orderful_poack_handling_prefs) AS poack_hp,
       BUILTIN.DF(c.custentity_orderful_asn_handling_prefs)   AS asn_hp,
       BUILTIN.DF(c.custentity_orderful_wso_handling_prefs)   AS wso_hp
FROM customer c
WHERE c.id = <customer_id>;
```

If a customer field is empty, dispatch falls through to the parent customer, then the subsidiary default (`custrecord_orderful_sub_inv_hp`, `_cm_hp`, `_poack_hp`, `_asn_hp`, `_wso_hp`, `_wst_hp`, `_wstpo_hp`) — so an empty customer field is not necessarily a misconfiguration. Check the resolved value, not just the customer row.

To check the process-as-custom routing on the ECT (records with it effective bypass native generation, routing through customer-built SuiteScript via the `PendingCustomProcess` status, separate from the dispatch path described here):

```sql
SELECT id,
       BUILTIN.DF(custrecord_edi_enab_trans_document_type) AS doc_type,
       custrecord_edi_enab_trans_cust_process              AS process_as_custom,
       BUILTIN.DF(custrecord_edi_enab_custproc_override)   AS process_as_custom_override
FROM customrecord_orderful_edi_customer_trans
WHERE custrecord_edi_enab_trans_customer = <customer_id>
  AND custrecord_edi_enab_trans_direction = '2'   -- outbound
ORDER BY id;
```

> **Legacy (< v1.22.0):** there, the per-ECT `custrecord_edi_enab_trans_auto_send_asn` was the auto-send gate and should be `T` on each outbound ECT expected to dispatch. As of v1.22.0 that field is no longer the gate (see the dispatch-gate section above).

## Test vs. live stream — the sandbox guard and the override that actually controls it

Outbound generation defaults to the **LIVE** stream. When the SuiteApp runs in a sandbox NetSuite account, a guard rejects live transactions before they post to Orderful, writing this to `custrecord_ord_tran_error`:

```
Blocked: live transaction not sent from sandbox environment
```

So a freshly-generated outbound transaction in sandbox lands in `Error` with that message, and nothing reaches Orderful. (This is distinct from the Orderful-side rejection *"Cannot post a LIVE transaction because the relationship is in testing"* — that one fires when the message does reach Orderful but the partnership is in test.)

### The field that actually flips the stream

There are **two** test-related fields on the ECT (`customrecord_orderful_edi_customer_trans`), and they are not the same lever:

| Field | Type | Effect on the outbound stream |
|---|---|---|
| `custrecord_edi_enab_trans_test` ("Test Mode" checkbox) | boolean | **Does NOT, by itself, make outbound generate as test.** Setting it `T` is not sufficient — generated rows still come out `custrecord_ord_tran_testmode = F` (live) and hit the sandbox guard. |
| `custrecord_edi_enab_test_override` ("Setting Override") | list `customlist_orderful_setting_override`: `Yes` (id 1) / `No` (id 2) / `Default` (id 3) | **This is the lever.** Default falls through to live. Set it to **`Yes`** to force the outbound transaction to generate as test (`testmode = T`), which passes the sandbox guard and posts to Orderful's test stream. |

For a sandbox account where every outbound should be test, set the override to `Yes` on each outbound ECT:

```http
PATCH /services/rest/record/v1/customrecord_orderful_edi_customer_trans/<ect_id>
{ "custrecord_edi_enab_test_override": { "id": "1" } }
```

Confirm across all outbound ECTs:

```sql
SELECT id,
       BUILTIN.DF(custrecord_edi_enab_trans_document_type) AS doc_type,
       BUILTIN.DF(custrecord_edi_enab_test_override)       AS test_override,
       custrecord_edi_enab_trans_test                      AS test_mode_checkbox
FROM customrecord_orderful_edi_customer_trans
WHERE custrecord_edi_enab_trans_customer = <customer_id>
  AND custrecord_edi_enab_trans_direction = '2';
```

### Regeneration recomputes testmode — manual edits don't survive

`custrecord_ord_tran_testmode` on an existing Orderful Transaction row is recomputed every time the record is (re)generated. Manually PATCHing an already-generated row to `testmode = T` will **not** make it send as test — the next dispatch (re-firing the source record's `custbody_orderful_ready_to_process_*` flag) regenerates the message and resets the stream from the ECT override. Fix the override on the ECT, then regenerate; don't edit the transaction row.

### Re-triggering creates a new row, and old rows can't be deleted

Re-firing the source record's ready-to-process flag does **not** reuse the existing `customrecord_orderful_transaction` row for that source + doc type — it **creates a new one** (same `custrecord_orderful_consolidation_key`, new internal id). Successive retries therefore accumulate rows. The stale ones cannot be deleted via REST (`This record cannot be deleted because it has dependent records` — the `customrecord_orderful_edi_trx_join` link). **Inactivate** them (`isinactive = true`) instead, leaving the latest successful row active.

## Source pointers

| File (under `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/`) | Role |
|---|---|
| `TransactionHandling/orderful_netsuiteTrxHandler_UE.ts` | UE entry point — `afterSubmit` calls `processOutboundTransaction` |
| `TransactionHandling/common/outbound.utilities.ts` | `processOutboundTransaction` (shared by UE + MR), `linkRecordToOutboundTransaction`, `generateAndDispatchOutboundTransaction`, `writeTransactionMessageToOrderfulTransactionRecord` |
| `TransactionHandling/orderful_outboundTransaction_LIB.ts` | Document-type dispatch switch (`STATUS_RELIANT_DOCUMENT_TYPES`, `checkOutboundReadiness`, generator routing) |
| `TransactionHandling/orderful_outboundTransactionHandling_MR.ts` | Scheduled backstop |
| `Repositories/entity.repository.ts` | Where `custrecord_edi_enab_trans_auto_send_asn` is aliased to `auto_send` |
| `Repositories/netsuite_transaction.repository.ts::getToBeProcessedTransactionIds` | The query the MR uses to find Pending-by-flag records |
