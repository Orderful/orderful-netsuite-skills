# NetSuite custom records — Orderful connector

Reference doc for the custom records the Orderful SuiteApp creates and uses. Skills cite this so Claude has accurate field names + relationships when querying. Pulled from the connector's SDF object definitions.

> **When you query these records via SuiteQL**: the table name in SuiteQL is the same as the record's `scriptid` (e.g. `customrecord_orderful_item_lookup`). MULTISELECT fields (and other relationship-backed fields) are exposed via auto-generated mapping tables prefixed `map_` (e.g. `map_customrecord_orderful_item_lookup_custrecord_orderful_item_customer`), where `mapone` = this record's id and `maptwo` = the referenced record's id.
>
> **Gotcha — don't filter a multiselect/relationship field directly.** `WHERE custrecord_orderful_item_customer = '123'` runs without error but silently returns **0 rows** — the column isn't a scalar. A plain `SELECT` of it returns the referenced id (e.g. `392`), but string functions on it return the literal text `RELATIONSHIP FIELD` (and `LENGTH()` = 18) — that's the tell you're looking at one of these. Filter through the `map_` table instead: `JOIN map_<record>_<field> m ON m.mapone = <record>.id WHERE m.maptwo = :referenced_id`.

## `customrecord_orderful_item_lookup` — Item Lookup

The core record for mapping inbound EDI item identifiers to NetSuite items. Failed 850s with `ITEM_LOOKUP_MISSING` are about a missing or mismatched row in this table.

| Script ID | Type | Label | Notes |
|---|---|---|---|
| `custrecord_orderful_item_item` | SELECT (item, recordtype `-10`) | Item | The NS item to return when this lookup matches. Required. |
| `custrecord_orderful_item_qualifier` | TEXT | EDI Product Qualifier | The qualifier code in the inbound EDI (e.g. `BP`, `VN`, `UP`, `EN`, `IN`). Required. |
| `custrecord_orderful_item_qualifier_value` | TEXT | EDI Qualifier Value | The exact value paired with the qualifier. Must match exactly to fire the lookup. Required. |
| `custrecord_orderful_item_subsidiary` | SELECT (subsidiary, recordtype `-117`) | Restrict to Subsidiary | Optional. If set, this lookup only fires for transactions in the specified subsidiary. |
| `custrecord_orderful_item_customer` | MULTISELECT (customer, recordtype `-2`) | Restrict to Customer(s) | Optional. If set, this lookup only fires for the listed customers. Customer-specific lookups beat parent-customer fallbacks one level. |
| `isinactive` | CHECKBOX | Inactive | Standard NS field. Inactive lookups are ignored at runtime. |

### How matching works at runtime

For each PO1-loop line in an inbound 850, the connector iterates `(qualifier, value)` pairs (e.g. `BP=ABC-123`, `UP=999000111`) and runs a lookup query like:

```sql
SELECT id, custrecord_orderful_item_item AS ns_item_id
FROM   customrecord_orderful_item_lookup l
LEFT JOIN map_customrecord_orderful_item_lookup_custrecord_orderful_item_customer cm
  ON cm.mapone = l.id
WHERE  l.isinactive != 'T'
  AND  UPPER(l.custrecord_orderful_item_qualifier)       = UPPER(:qualifier)
  AND  UPPER(l.custrecord_orderful_item_qualifier_value) = UPPER(:value)
  AND  (l.custrecord_orderful_item_subsidiary IS NULL OR l.custrecord_orderful_item_subsidiary = :subsidiary_id)
  AND  (cm.maptwo IS NULL OR cm.maptwo = :customer_id)
ORDER BY
  CASE WHEN cm.maptwo = :customer_id THEN 0 ELSE 1 END,  -- prefer customer-specific
  CASE WHEN l.custrecord_orderful_item_subsidiary IS NOT NULL THEN 0 ELSE 1 END
```

(Approximate — the connector uses a Kysely query builder, not raw SQL.)

If no match: `ITEM_LOOKUP_MISSING`. The transaction lands in `customrecord_orderful_transaction` with status = `Failed` and an error row in `customrecord_orderful_transaction_error`.

### Common gotchas

- **Wrong qualifier in the lookup.** Customer sends `BP=X` but the lookup is created under `VN=X`. The cross-qualifier check (proposing to add the missing pair to the existing lookup) is one of the most common fixes.
- **Trailing whitespace / case mismatch.** The connector uppercases both sides before comparing, so case shouldn't matter — but trailing spaces or non-printable chars in either field will silently break matching.
- **Customer restrict has the wrong customer.** Multi-select; if the customer's NS internal ID isn't in the list, no match.
- **Inactive lookup.** `isinactive = T` causes the row to be ignored.

## `customrecord_orderful_transaction` — Inbound/Outbound Transaction

The connector's record of every transaction (per direction) it touches. This is where you find the failed 850 itself.

| Script ID | Type | Label | Notes |
|---|---|---|---|
| `custrecord_ord_tran_orderful_id` | TEXT | Orderful Transaction ID | The Orderful-side UUID. Used to cross-reference with Orderful's API / UI. |
| `custrecord_ord_tran_document` | SELECT | Document Type | E.g. 850, 855, 856. |
| `custrecord_ord_tran_direction` | SELECT | Direction | `Inbound` (value `1`) or `Outbound` (value `2`). |
| `custrecord_ord_tran_status` | SELECT | Status | E.g. `Pending`, `Processing`, `Completed`, `Failed`, `Pending - Custom Process`, `Ready To Send`. Backed by `customlist_orderful_transaction_status` — see "Custom Process status values" below. |
| `custrecord_ord_tran_entity` | SELECT | Entity | The customer (or vendor) on the NS side. |
| `custrecord_ord_tran_isa_sender` | TEXT | Sender ID (ISA) | Trading partner ISA sender. |
| `custrecord_ord_tran_receiver` | TEXT | Receiver ID (ISA) | Trading partner ISA receiver. |
| `custrecord_ord_tran_orderful_date` | DATETIMETZ | Created Date Orderful | When Orderful received the transaction. |
| `custrecord_ord_tran_link` | URL | View in Orderful | Direct link to the Orderful UI for this transaction. |
| `custrecord_ord_tran_message` | LONGTEXT | Message | Stringified JSON. Inbound: the EDI payload the SuiteApp received and converted to JSON — read this in custom inbound scripts. Outbound: the payload your custom script writes for the SuiteApp's outbound MR to POST to Orderful. |
| `custrecord_ord_tran_error` | TEXTAREA | Error | Surface-level error message if `status = 'Failed'` or `Error`. Custom scripts must populate this on failure. |
| `custrecord_ord_tran_inbound_transaction` | SELECT | Inbound Purchase Order | For outbound docs (e.g. 855), points at the original 850. |
| `custrecord_ord_tran_testmode` | CHECKBOX | Test Mode | True if this came in via the test ISA. |
| `custrecord_ord_tran_poller_id` | TEXT | Poller Bucket ID | Which Orderful polling bucket this came in on. |

### Custom Process status values (`customlist_orderful_transaction_status`)

When using the SuiteApp's "Process as Custom" flow (see `custom-process-transactions` skill), these are the status script IDs your code writes:

| Script ID | Meaning | Set by |
|---|---|---|
| `transaction_status_pending_cust_process` | Inbound transaction has landed but the SuiteApp won't auto-process it because the customer's enabled-transaction record has `Process as Custom` checked. Your custom MR picks these up. | SuiteApp (on inbound) |
| `transaction_status_ready_to_send` | Outbound transaction is ready for the SuiteApp's `customscript_orderful_outbound_sending` MR to POST to Orderful. | Your custom outbound script |
| `transaction_status_success` | Terminal — processing succeeded. | Your custom script (after writing NS records) or the SuiteApp (after a successful POST) |
| `transaction_status_error` | Terminal — processing failed. Error message goes in `custrecord_ord_tran_error`. | Your custom script or the SuiteApp |

**Status-ID resolver** (drop into your lib file — every custom-process script needs this):

```js
function getStatusId(scriptId) {
  const results = query.runSuiteQL({
    query: 'SELECT id FROM customlist_orderful_transaction_status WHERE UPPER(scriptid) = ?',
    params: [scriptId.toUpperCase()],
  }).asMappedResults();
  return results.length ? results[0].id : null;
}
```

### Customer-record toggle for "Process as Custom"

On the customer (or vendor) record → **Orderful EDI Customer Transactions** subtab → per enabled transaction type:

- **`custrecord_edi_enab_trans_cust_process`** (CHECKBOX, label "Process as Custom") — when checked, inbound transactions of this type land at `transaction_status_pending_cust_process` instead of being auto-mapped. Outbound: also requires the handling preference to be set to **Custom (Manual/Workflow)** for the SuiteApp to wait on your script's `Ready To Send` write. **As of NS-1037 this also has a 3-value override (`custrecord_edi_enab_custproc_override`, `customlist_orderful_setting_override` = Yes/No/Default) and per-doctype subsidiary defaults (`custrecord_orderful_sub_custproc_<doctype>`, e.g. `_850` / `_855` / `_856` / `_810` / `_940` / `_943` / …), so "process as custom" can be defaulted at the subsidiary per doc type. This legacy checkbox is the bilingual fallback only.**

### Outbound payload formats (for `custrecord_ord_tran_message`)

The SuiteApp's outbound sender auto-detects which format your custom script wrote and routes accordingly.

**X12 nested** (used for 810, 855, 856, 940, etc.):

```json
{
  "sender":   { "isaId": "<COMPANY_ISA>" },
  "receiver": { "isaId": "<PARTNER_ISA>" },
  "type":     { "name":  "810_INVOICE" },
  "stream":   "LIVE",
  "message":  { "transactionSets": [ ... ] }
}
```

**Simplified** (used for non-X12-shaped docs, e.g. 855 acknowledgments):

```json
{
  "senderId":   "<COMPANY_ISA>",
  "receiverId": "<PARTNER_ISA>",
  "type":       "855_PURCHASE_ORDER_ACKNOWLEDGMENT",
  "stream":     "LIVE",
  "message":    { ... }
}
```

The SuiteApp strips null values and empty collections before sending. ISA sender/receiver are required — populate them explicitly rather than relying on company-level defaults.

### Common queries

```sql
-- Find recent failed inbound 850s for a customer
SELECT id, custrecord_ord_tran_orderful_id, custrecord_ord_tran_error, custrecord_ord_tran_orderful_date
FROM   customrecord_orderful_transaction
WHERE  custrecord_ord_tran_direction = 'Inbound'
  AND  custrecord_ord_tran_document   = '<850-list-id>'
  AND  custrecord_ord_tran_status     = '<Failed-list-id>'
  AND  custrecord_ord_tran_entity     = :customer_id
ORDER BY custrecord_ord_tran_orderful_date DESC;
```

(SELECT-field internal IDs can be discovered via `getSelectValue` or by inspecting an example record.)

## `customrecord_orderful_transaction_error` — Error Detail

When a transaction fails, this record holds the error detail. Multiple error rows can exist per transaction (one per retry/attempt), so the rows read as a failure timeline.

| Script ID | Type | Notes |
|---|---|---|
| `custrecord_orderful_error_transaction` | SELECT | Link back to the parent `customrecord_orderful_transaction` — holds that record's **internal id**, not the Orderful id. |
| `custrecord_orderful_error_message` | TEXTAREA | The error text. Native-path failures give a clean code/message (e.g. `ITEM_LOOKUP_MISSING`); JSONata / SO-save failures give the raw SuiteScript error JSON (e.g. `USER_ERROR: "Please choose an item to add"`). |
| `custrecord_orderful_error_type` | SELECT | Error category. |
| `custrecord_orderful_error_resolved` | CHECKBOX | Whether the error has been marked resolved. |

**Pulling the errors for a specific transaction is a two-step lookup**, because the link field holds the NS record id, not the Orderful transaction id:

```sql
-- 1. resolve the transaction record's internal id from the Orderful id
SELECT id FROM customrecord_orderful_transaction
WHERE custrecord_ord_tran_orderful_id = '<orderful-txn-id>';

-- 2. pull its error rows, newest first
SELECT custrecord_orderful_error_message, custrecord_orderful_error_type, created
FROM customrecord_orderful_transaction_error
WHERE custrecord_orderful_error_transaction = '<record-id-from-step-1>'
ORDER BY created DESC;
```

Reading the message history is the fastest way to see a transaction's failure timeline (e.g. `JSONata mapper is required` → repeated `Please choose an item to add` → `Stale - Max Retries Exceeded`).

(For the full field list, see `Objects/customrecord_orderful_transaction_error.xml` in the SuiteApp source.)

## `customrecord_orderful_diagnostic` — Diagnostic Log

Free-form diagnostic log entries written by the connector during processing. Useful for tracing what the connector did/saw on a specific transaction.

| Script ID | Type | Label |
|---|---|---|
| `custrecord_orderful_diag_log_text` | CLOBTEXT | Diagnostic Log Text |
| `custrecord_orderful_diag_orderful_trans` | SELECT | Transaction ID (link to `customrecord_orderful_transaction`) |
| `custrecord_orderful_diag_ns_record_id` | TEXT | NetSuite Record Id |
| `custrecord_orderful_diag_ns_record_type` | TEXT | NetSuite Record Type |
| `custrecord_orderful_diag_transaction_id` | TEXT | Orderful Transaction ID |

## Other custom records (less commonly relevant for v0 skills)

The connector ships these too. Most v0 skills won't need to query them directly, but listed here so Claude doesn't invent records that don't exist.

- `customrecord_orderful_carton`
- `customrecord_orderful_discount`
- `customrecord_orderful_distributioncenter`
- `customrecord_orderful_edi_customer_trans`
- `customrecord_orderful_edi_document_type`
- `customrecord_orderful_edi_field_map_head`
- `customrecord_orderful_edi_field_map_line`
- `customrecord_orderful_edi_trx_join`
- `customrecord_orderful_feature_flags`
- `customrecord_orderful_generic_lookup`
- `customrecord_orderful_item_pack_group`
- `customrecord_orderful_label_data_src`
- `customrecord_orderful_location_customer`
- `customrecord_orderful_packing_group`
- `customrecord_orderful_pkg_data_src`
- `customrecord_orderful_shipped_item`
- `customrecord_orderful_shipping_carrier`
- `customrecord_orderful_shipping_service`
- `customrecord_orderful_store`
- `customrecord_orderful_uom_mapping`

If a skill needs detail on one of these, add it to this file — that's how the reference grows.

## Standard NS records frequently joined

- **Item** (`item`, recordtype `-10`) — what `customrecord_orderful_item_lookup.custrecord_orderful_item_item` points at. Common columns: `id`, `itemid` (display name), `displayname`, `description`, `baseprice`, `cost`, `vendorname`, `manufacturer`.
- **Customer** (`customer`, recordtype `-2`) — what `customrecord_orderful_transaction.custrecord_ord_tran_entity` points at, and the multi-select target on item lookups. Common columns: `id`, `entityid`, `companyname`, `parent`.
- **Subsidiary** (`subsidiary`, recordtype `-117`) — for the optional `subsidiary` restriction.
