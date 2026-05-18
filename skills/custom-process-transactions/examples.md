# Custom Process Transactions — Worked Examples

Sanitized patterns extracted from real custom-process scripts. None of these are runnable as-is — they're the *shapes* you copy. All customer-specific field IDs, ISA values, partner names, and business rules have been stripped or abstracted.

Naming convention in these examples: `<prefix>` stands for whatever short identifier you choose for the script set (e.g. the customer slug abbreviated, or the doc type). Pick one and use it consistently across the lib + script + parameters + saved search.

---

## Example 1 — The library file (frozen constants + helpers)

Every script in a custom-process set has a sibling `<prefix>_Orderful_lib.js`. It centralizes field IDs, script-parameter keys, ISA resolution, and small helpers. The script file itself holds business logic only.

```js
/**
 * @NApiVersion 2.1
 */
define(['N/log', 'N/query', 'N/runtime'], (log, query, runtime) => {

  // --- 1. Script-parameter keys (single source of truth) ---
  const ScriptParams = Object.freeze({
    SEARCH_ID:         'custscript_<prefix>_search_id',
    DATASET_ID:        'custscript_<prefix>_dataset_id',
    COMPANY_TEST_MODE: 'custscript_orderful_test_mode',
    COMPANY_ISA_ID:    'custscript_orderful_isa_id',
  });

  // --- 2. SuiteApp record-type and field-ID constants ---
  // These come from the Orderful SuiteApp and are stable across customers.
  const OrderfulTransactionRecord = Object.freeze({
    type: 'customrecord_orderful_transaction',
    fields: {
      DOCUMENT_TYPE:  'custrecord_ord_tran_document',
      ENTITY:         'custrecord_ord_tran_entity',
      SENDER_ID:      'custrecord_ord_tran_isa_sender',
      RECEIVER_ID:    'custrecord_ord_tran_receiver',
      STATUS:         'custrecord_ord_tran_status',
      DIRECTION:      'custrecord_ord_tran_direction',
      ERROR:          'custrecord_ord_tran_error',
      MESSAGE:        'custrecord_ord_tran_message',
      TEST_MODE:      'custrecord_ord_tran_testmode',
    },
  });

  const EDITransactionJoinRecord = Object.freeze({
    type: 'customrecord_orderful_edi_trx_join',
    fields: {
      NETSUITE_TRANSACTION: 'custrecord_orderful_netsuite_transaction',
      ORDERFUL_DOCUMENT:    'custrecord_orderful_edi_document',
      EDI_DOCUMENT_TYPE:    'custrecord_orderful_edi_doc_type',
      DIRECTION:            'custrecord_orderful_direction',
    },
  });

  // --- 3. Customer-specific custom-field IDs (rename per project) ---
  // Put your custcol/custbody IDs here so the script never inlines them.
  const TransactionBodyFields = Object.freeze({
    // EXAMPLE_FIELD: 'custbody_<your_field>',
  });

  // --- 4. Status / direction resolvers (SuiteQL — preferred in 2.1) ---
  const getListValueId = (listType, scriptId) => {
    const results = query.runSuiteQL({
      query: `SELECT id FROM ${listType} WHERE UPPER(scriptid) = ?`,
      params: [scriptId.toUpperCase()],
    }).asMappedResults();
    return results.length ? results[0].id : null;
  };

  const getStatusId    = (scriptId) => getListValueId('customlist_orderful_transaction_status', scriptId);
  const getDirectionId = (scriptId) => getListValueId('customlist_orderful_edi_direction',      scriptId);

  // --- 5. Test-mode + ISA helpers ---
  const getCompanyTestMode = (objScript) =>
    objScript.getParameter({ name: ScriptParams.COMPANY_TEST_MODE }) === true;

  const getCompanyIsaID = (objScript, testMode) =>
    objScript.getParameter({ name: ScriptParams.COMPANY_ISA_ID + (testMode ? '_test' : '') });

  // --- 6. Format helper (CCYYMMDD -> Date) ---
  const parseDate8 = (dts) => {
    if (typeof dts !== 'string' || !/^\d{8}$/.test(dts)) return null;
    return new Date(+dts.slice(0, 4), +dts.slice(4, 6) - 1, +dts.slice(6, 8));
  };

  return {
    ScriptParams,
    OrderfulTransactionRecord,
    EDITransactionJoinRecord,
    TransactionBodyFields,
    getStatusId,
    getDirectionId,
    getCompanyTestMode,
    getCompanyIsaID,
    parseDate8,
  };
});
```

**Why a lib is mandatory:** field IDs and status lookups appear in every script. Centralizing means renaming a field touches one file, not five. The `Object.freeze` calls prevent accidental mutation.

---

## Example 2 — Inbound MapReduce: `getInputData` + `map` skeleton

The saved search referenced by the parameter filters `customrecord_orderful_transaction` for `status = transaction_status_pending_cust_process` AND `direction = 1` AND `document = <your doc type>`.

```js
/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define([
  'N/error', 'N/log', 'N/query', 'N/record', 'N/runtime',
  './<prefix>_Orderful_lib.js',
], (error, log, query, record, runtime, lib) => {

  const getInputData = () => {
    const searchId = runtime.getCurrentScript().getParameter({
      name: lib.ScriptParams.SEARCH_ID,
    });
    if (!searchId) {
      throw error.create({
        name: 'MISSING_PARAMETER',
        message: `Parameter "${lib.ScriptParams.SEARCH_ID}" is mandatory`,
      });
    }
    return { type: 'search', id: searchId };
  };

  const map = (mapContext) => {
    const orderfulTransactionId = mapContext.key;
    const orderfulTransaction = record.load({
      type: lib.OrderfulTransactionRecord.type,
      id: orderfulTransactionId,
    });

    try {
      // 1. Parse the EDI payload that the SuiteApp staged for us
      const ediMsg = JSON.parse(
        orderfulTransaction.getValue({ fieldId: lib.OrderfulTransactionRecord.fields.MESSAGE })
      );
      const transactionSet = ediMsg.message.transactionSets[0];

      // 2. Look up the target NS record (example: SO by depositor order number)
      //    Actual lookup keys depend on the EDI doc type.
      //    const soNumber = transactionSet.warehouseShipmentIdentification?.[0]?.depositorOrderNumber;

      // 3. Transform → create / update NS records
      //    ...your business logic here...

      // 4. Mark success
      orderfulTransaction.setValue({
        fieldId: lib.OrderfulTransactionRecord.fields.STATUS,
        value: lib.getStatusId('transaction_status_success'),
      });
      orderfulTransaction.save();

    } catch (e) {
      log.error({ title: 'map', details: e.message + '\n' + e.stack });
      orderfulTransaction.setValue({
        fieldId: lib.OrderfulTransactionRecord.fields.STATUS,
        value: lib.getStatusId('transaction_status_error'),
      });
      orderfulTransaction.setValue({
        fieldId: lib.OrderfulTransactionRecord.fields.ERROR,
        value: (e.message || String(e)).slice(0, 999),
      });
      orderfulTransaction.save();
      // Do NOT mapContext.write(...) here — leaving the value unwritten keeps
      // the next stage clean and the source record retryable on the next run.
    }
  };

  const summarize = (summary) => {
    summary.mapSummary.errors.iterator().each((key, error) => {
      log.error({ title: 'map error', details: `key=${key} error=${error}` });
      return true;
    });
  };

  return { getInputData, map, summarize };
});
```

**Watch out:**
- Every code path through `map` must end with a *terminal* status (`_success` or `_error`). If you `return` early without setting status, the record stays in `pending_cust_process` and re-runs every cycle.
- Truncate the error message before writing to `custrecord_ord_tran_error` — that field has a length limit.

---

## Example 3 — Outbound: build payload and create the Orderful Transaction

The custom outbound script's **only** job is to stage a record. It does not POST anything. It writes a new `customrecord_orderful_transaction` with status `Ready To Send`, and the SuiteApp's separately deployed scheduled MR (`customscript_orderful_outbound_sending`) picks it up on its own cadence, POSTs to Orderful, and flips the status.

Either a UE on the source NS record (write-on-save) or an MR driven by a saved search of records ready to send. Both end the same way:

```js
const createOutboundOrderfulTransaction = (cfg) => {
  const t = record.create({ type: lib.OrderfulTransactionRecord.type });

  t.setValue({ fieldId: lib.OrderfulTransactionRecord.fields.DOCUMENT_TYPE,
               value: getDocumentTypeId('<doc>_<NAME>') });   // e.g. '850_PURCHASE_ORDER'
  t.setValue({ fieldId: lib.OrderfulTransactionRecord.fields.STATUS,
               value: lib.getStatusId('transaction_status_ready_to_send') });
  t.setValue({ fieldId: lib.OrderfulTransactionRecord.fields.DIRECTION,
               value: lib.getDirectionId('edi_direction_out') });
  t.setValue({ fieldId: lib.OrderfulTransactionRecord.fields.ENTITY,
               value: cfg.entityId });
  t.setValue({ fieldId: lib.OrderfulTransactionRecord.fields.SENDER_ID,
               value: cfg.companyIsaId });
  t.setValue({ fieldId: lib.OrderfulTransactionRecord.fields.RECEIVER_ID,
               value: cfg.partnerIsaId });
  t.setValue({ fieldId: lib.OrderfulTransactionRecord.fields.TEST_MODE,
               value: cfg.testMode });
  t.setValue({ fieldId: lib.OrderfulTransactionRecord.fields.MESSAGE,
               value: JSON.stringify(cfg.payload) });

  return t.save({ ignoreMandatoryFields: true });
};
```

### Payload shape — X12 nested (most outbound docs)

```js
const payload = {
  sender:   { isaId: companyIsaId },
  receiver: { isaId: partnerIsaId },
  type:     { name:  '<DOC>_<NAME>' },     // e.g. '850_PURCHASE_ORDER'
  stream:   testMode ? 'TEST' : 'LIVE',
  message:  { transactionSets: [ /* ...one per X12 ST/SE pair... */ ] },
};
```

### Payload shape — simplified (non-X12-shaped docs)

```js
const payload = {
  senderId:   companyIsaId,
  receiverId: partnerIsaId,
  type:       '<DOC>_<NAME>',
  stream:     testMode ? 'TEST' : 'LIVE',
  message:    { /* doc-specific body */ },
};
```

The SuiteApp auto-detects which format you used. Don't mix shapes within a single transaction set.

---

## Example 4 — ISA resolution with per-(customer × doc-type) override

Order of precedence:
1. Override on the Orderful EDI Enabled Transaction Type record (per customer × doc).
2. Field on the customer/vendor record (`custentity_orderful_isa_id` / `_test`).
3. Subsidiary-level field (`custrecord_orderful_isa_id` / `_test`).
4. Script-parameter fallback.

```js
const getIsaOverrides = (entityId, documentTypeScriptId, isTestMode) => {
  const suffix = isTestMode ? '_test' : '';
  const results = query.runSuiteQL({
    query: `
      SELECT
        custrecord_edi_enab_trans_isa_company${suffix === '_test' ? '_test' : ''}  AS company_isa,
        custrecord_edi_enab_trans_isa_customer${suffix === '_test' ? '_test' : ''} AS partner_isa
      FROM customrecord_orderful_edi_customer_trans
      WHERE custrecord_edi_enab_trans_customer = ?
        AND BUILTIN.DF(custrecord_edi_enab_trans_document_type) = ?
        AND isinactive != 'T'
    `,
    params: [entityId, documentTypeScriptId],
  }).asMappedResults();
  return results[0] || {};
};
```

**Why:** customers commonly need different ISAs per trading partner per doc type. The enabled-transaction override is the SuiteApp's intended escape hatch — use it instead of letting the script make routing decisions on its own.

---

## Example 5 — Loading static mapping data from File Cabinet

When the script needs a lookup table (EDI reason code → GL account, qualifier code → handling, etc.), keep the table in a JSON file in the File Cabinet rather than hardcoding it. The skill repo doesn't ship the table; each customer drops their own in.

**File** (`SuiteScripts/Orderful Scripts/<doc>/<doc>_<name>_config.json`):

```json
{
  "reasonCodeMappings": {
    "<CODE_1>": { "itemId": "<sku-or-id>", "description": "<label>", "glAccount": "<account>" },
    "<CODE_2>": { "itemId": "<sku-or-id>", "description": "<label>", "glAccount": "<account>" }
  }
}
```

**Loading from the script**:

```js
const loadConfig = (configPath) => {
  const fileRecord = file.load({ id: configPath });
  return JSON.parse(fileRecord.getContents());
};

// The path itself is a script parameter — never hardcode it.
const configPath = runtime.getCurrentScript().getParameter({
  name: 'custscript_<prefix>_config_path',
});
const config = loadConfig(configPath);
```

**Why:** mapping tables change without code changes. Operations can update the JSON in the File Cabinet without redeploying the script.

---

## Example 6 — Linking the source NS record to the Orderful Transaction (audit trail)

After writing the outbound `customrecord_orderful_transaction`, also write an `EDI Transaction Join` record so the source NS record (PO, SO, IF) has a queryable back-reference. The SuiteApp uses this same join table for its standard transactions.

```js
const linkSourceToOrderfulTransaction = (sourceTxnId, orderfulTxnId, docTypeScriptId) => {
  const join = record.create({ type: lib.EDITransactionJoinRecord.type });
  join.setValue({ fieldId: lib.EDITransactionJoinRecord.fields.NETSUITE_TRANSACTION,
                  value: sourceTxnId });
  join.setValue({ fieldId: lib.EDITransactionJoinRecord.fields.ORDERFUL_DOCUMENT,
                  value: orderfulTxnId });
  join.setValue({ fieldId: lib.EDITransactionJoinRecord.fields.EDI_DOCUMENT_TYPE,
                  value: getDocumentTypeId(docTypeScriptId) });
  join.setValue({ fieldId: lib.EDITransactionJoinRecord.fields.DIRECTION,
                  value: lib.getDirectionId('edi_direction_out') });
  return join.save({ ignoreMandatoryFields: true });
};
```

This is what lets you write SuiteQL like *"give me the outbound Orderful Transaction generated from PO X"* later.

---

## Example 7 — User Event "validate before save" pattern

Some outbound triggers want to gate the send on data quality. Run validation as a `beforeSubmit` UE on the source record; raise an error message (or set a hold flag) when the record isn't ready.

```js
/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/error', 'N/runtime'], (error, runtime) => {

  const beforeSubmit = ({ newRecord, type, UserEventType }) => {
    if (type === UserEventType.DELETE) return;

    const missing = [];
    // Example checks — replace with what the partner spec actually requires
    if (!newRecord.getValue({ fieldId: 'tranid' }))   missing.push('Transaction ID');
    if (!newRecord.getValue({ fieldId: 'entity' }))   missing.push('Entity');
    if (!newRecord.getValue({ fieldId: 'trandate' })) missing.push('Date');

    if (missing.length) {
      throw error.create({
        name: 'MISSING_REQUIRED_FIELDS_FOR_EDI',
        message: 'Cannot send EDI document. Missing: ' + missing.join(', '),
      });
    }
  };

  return { beforeSubmit };
});
```

**Why `beforeSubmit` and not `afterSubmit`:** `beforeSubmit` blocks the save with a user-visible error. `afterSubmit` runs after the data is already committed — too late to prevent a bad outbound.

---

## Anti-patterns to avoid

- **Hardcoded IDs** of any kind — locations, ISAs, saved searches, file paths, custom-field internal IDs. Everything env-dependent goes through script parameters. If you find yourself typing a numeric ID inline, stop.
- **Mixing `N/search` and `N/query`** in one script. SuiteScript 2.1 → prefer `N/query` (SuiteQL) for new lookups. Pick one per script.
- **Customer-specific business rules in the lib.** The lib is for SuiteApp-stable shapes (`OrderfulTransactionRecord`, status resolvers, ISA fallback). Per-customer logic (lot-numbered items, partner-specific allowance codes) belongs in the script, behind a script parameter where possible.
- **Bundling two doc types in one script.** A 945 processor and a 940 processor in one MR shares state in ways that bite you the first time only one of them fails. Separate scripts, separate deployments, separate parameters.
- **Writing partial output before erroring.** In `map`, if a write to the destination NS record succeeds but the status flip fails, you'll double-create on retry. Either wrap the whole map body in a transaction, or write the destination record last and the status update as the final step (so an exception leaves the source retryable).
