# Outbound dispatch flow

How a saved NetSuite source record (Invoice, Item Fulfillment, Sales Order, etc.) becomes an outbound EDI transaction posted to Orderful. Useful when a record is stuck in `Pending` and you need to know *what should have fired* and *which gates can suppress it*.

## TL;DR

- Standard outbound runs **synchronously inside the User Event** `orderful_netsuiteTrxHandler_UE.afterSubmit`. By the time the source record's save returns, the outbound transaction has been generated and POSTed to Orderful — or an error has been written to the `customrecord_orderful_transaction` row.
- The MapReduce `orderful_outboundTransactionHandling_MR.ts` is **a scheduled backstop only**, picking up records the UE didn't process (within `outboundBackProcessingWindowInDays`). The happy path never touches it.
- The ECT field `custrecord_edi_enab_trans_auto_send_asn` is suffixed `_asn` but **gates auto-send for every outbound document type**, not just ASN. With it `F`, the UE creates the `customrecord_orderful_transaction` row + link but never writes the message — record stuck in `Pending`, length 0, no Orderful id, no error.

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
  → others take the simple gate: status === Pending && isAutoSendEnabled
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

## The `_asn`-suffixed flag actually gates everything

The simple readiness gate inside `processOutboundTransaction` is:

```typescript
readyToSend =
  orderfulTransaction.status === OrderfulTransactionStatus.Pending &&
  autoSendEnabled;
```

`autoSendEnabled` is sourced from the ECT row, mapped in `Repositories/entity.repository.ts`:

```typescript
'customrecord_orderful_edi_customer_trans.custrecord_edi_enab_trans_auto_send_asn as auto_send'
```

That's the **only** field driving `auto_send`, regardless of the document type the ECT is for. The `_asn` suffix is a historical naming artifact — the field originated for ASN auto-send and was repurposed without renaming. The Models layer aliases it to `isAutoSendEnabled` and the dispatcher gates on it for **every** outbound type (810, 856, 855, 940, 943, 880, simplified types, etc.).

**Setup implication:** when enabling a new outbound document type for a customer (creating an ECT row), `custrecord_edi_enab_trans_auto_send_asn` is the auto-send flag you set to T — **even if the document type has nothing to do with ASN**. Otherwise the UE will create Pending rows but never dispatch them.

`STATUS_RELIANT_DOCUMENT_TYPES` (currently only 880) takes the alternate `checkOutboundReadiness` path with parent-SO status logic, so 880 may behave differently if the underlying SOs aren't in the expected status. Every other type uses the simple gate above.

## Diagnostic table — record stuck in Pending

| Observation on `customrecord_orderful_transaction` | Likely cause |
|---|---|
| status = Pending, `LENGTH(custrecord_ord_tran_message) = 0`, no `custrecord_ord_tran_orderful_id`, error empty | UE created the row + link but didn't dispatch. **Most common cause:** `custrecord_edi_enab_trans_auto_send_asn = F` on the ECT for this doc type. Set it to T and re-trigger by toggling the source record's `custbody_orderful_ready_to_process_*` flag (saving the source record re-fires the UE). |
| status = Pending, message populated (length > 0), no Orderful id, error empty | Generation succeeded but the POST to Orderful didn't run or didn't update the row. Rare. Usually means dispatch was interrupted mid-flight (governance limit, NS failure). The MR backstop will pick it up on its next scheduled run. |
| status = Error, message populated, error = "Review transaction in Orderful", Orderful id populated | Orderful received the message and rejected validation. Pull validations via `GET /v2/organizations/{orgId}/transactions/{txId}/validations` and iterate JSONata via [`writing-outbound-jsonata`](../skills/writing-outbound-jsonata/SKILL.md). |
| status = Error, error contains a stack trace / specific exception | Generation failed before POST. Read the error text — usually a missing field, missing customer config, or a NS data issue (no cartons on IF, no Location, no shippingAddress, etc.). |

Useful confirmation query when checking ECT auto-send for a customer:

```sql
SELECT id,
       BUILTIN.DF(custrecord_edi_enab_trans_document_type) AS doc_type,
       custrecord_edi_enab_trans_auto_send_asn AS auto_send,
       custrecord_edi_enab_trans_cust_process AS process_as_custom
FROM customrecord_orderful_edi_customer_trans
WHERE custrecord_edi_enab_trans_customer = <customer_id>
  AND custrecord_edi_enab_trans_direction = '2'   -- outbound
ORDER BY id;
```

For each outbound ECT expected to auto-dispatch, `auto_send` should be `T`. If `process_as_custom` is `T`, this ECT bypasses native generation — records route through customer-built SuiteScript via the `PendingCustomProcess` status, separate from the dispatch path described here.

## Source pointers

| File (under `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/`) | Role |
|---|---|
| `TransactionHandling/orderful_netsuiteTrxHandler_UE.ts` | UE entry point — `afterSubmit` calls `processOutboundTransaction` |
| `TransactionHandling/common/outbound.utilities.ts` | `processOutboundTransaction` (shared by UE + MR), `linkRecordToOutboundTransaction`, `generateAndDispatchOutboundTransaction`, `writeTransactionMessageToOrderfulTransactionRecord` |
| `TransactionHandling/orderful_outboundTransaction_LIB.ts` | Document-type dispatch switch (`STATUS_RELIANT_DOCUMENT_TYPES`, `checkOutboundReadiness`, generator routing) |
| `TransactionHandling/orderful_outboundTransactionHandling_MR.ts` | Scheduled backstop |
| `Repositories/entity.repository.ts` | Where `custrecord_edi_enab_trans_auto_send_asn` is aliased to `auto_send` |
| `Repositories/netsuite_transaction.repository.ts::getToBeProcessedTransactionIds` | The query the MR uses to find Pending-by-flag records |
