---
name: custom-process-transactions
description: Build custom NetSuite SuiteScripts that extend the Orderful SuiteApp's
  "Process as Custom" flow — for inbound EDI documents the SuiteApp can't standard-map
  (812, 820, 940, 945, 865, etc.) and outbound documents derived from non-standard
  NetSuite records (e.g. 850 outbound from a Purchase Order instead of a Sales Order).
  Covers when to escape JSONata, the inbound MapReduce shape (search PendingCustomProcess →
  parse `custrecord_ord_tran_message` → write NS records → set status), the outbound
  shape (build payload → write `customrecord_orderful_transaction` with `Ready To Send` →
  SuiteApp sends), the mandatory library-file pattern, and the deploy scaffolding (File
  Cabinet folder → script + deployment + parameters + saved search).
  Trigger phrases: "build a custom 945/940/812/820/865", "process this EDI as custom",
  "we need a script for X", "JSONata can't do this", "extend the SuiteApp",
  "custom process transactions", "/custom-process-transactions".
---

# Custom Process Transactions — Inbound & Outbound

A "Process as Custom" extension is a SuiteScript that takes over from the Orderful SuiteApp's standard mapping for a specific (customer × document type) pair. Inbound, the SuiteApp drops the EDI payload on `customrecord_orderful_transaction` and waits — your script reads it, creates NetSuite records, and flips the status. Outbound, your script builds the payload and writes a new `customrecord_orderful_transaction` with `Ready To Send`; the SuiteApp's outbound MR picks it up and POSTs to Orderful.

## When to use this skill

- "We need a custom 945 / 940 / 865 / 812 / 820"
- "Build a script to process X EDI as custom"
- "Send an 850 outbound from a Purchase Order, not a Sales Order"
- "JSONata can't express this — how do we extend the SuiteApp"
- The requirement mentions "Process as Custom"
- `/custom-process-transactions`

## When NOT to use this skill

- Standard inbound 850/855 mapping → use `writing-inbound-jsonata`
- Standard outbound 856/810/855 mapping → use `writing-outbound-jsonata`
- Carton/packaging data lives in a non-standard record but the rest is normal → use `alternative-packing-source`
- Bug in an existing custom script → that's a private-repo job, not a new SuiteApp extension

Custom scripts cost more to maintain than JSONata. **Confirm with the user that JSONata can't do it before proceeding.**

## Inputs the skill needs

1. **Direction.** Inbound (Orderful → NS) or outbound (NS → Orderful)?
2. **EDI document type.** 812, 820, 850, 940, 945, 865, etc.
3. **Source / target NS record(s).** Sales Order, Item Fulfillment, Purchase Order, Transfer Order, Inbound Shipment, custom record? **Note**: which entity record carries the EDI configuration depends on the doc-series:
   - **800-series** (810, 812, 820, 850, 855, 856, 865, 870, 875, etc.) → trading-partner-facing → **Customer record**. The "Process as Custom" toggle lives on the customer's Orderful EDI Customer Transactions subtab.
   - **900-series** (940, 943, 944, 945, 947, etc.) → 3PL/warehouse-facing → **Vendor record** *and* the relevant **Location** must be set up in NetSuite, with the 3PL linked as the location's vendor (or via the SuiteApp's 3PL location convention). 945 in particular won't resolve a target Item Fulfillment without the location wired in. **The same EDI doc-type can have multiple NS sources** — e.g. 940 can be generated from a SO *or* a TO; 943 from a TO IF *or* an Inbound Shipment; 945 creates an IF on a SO *or* a TO; 944 creates an IR on a TO *or* a PO/IS. **Confirm which Case applies before writing code** — see `reference/900-series-lifecycle.md` for the full Case-by-Case mapping. Don't assume.
4. **The JSON contract** — non-negotiable, different shape per direction:
   - **Inbound**: a real sample of `custrecord_ord_tran_message` for this doc type. Either pull it from an existing Orderful Transaction in the customer's NS, or inject a synthetic one via `inject-test-transaction` and grab the staged payload. Without a real sample, the field paths (`transactionSet.warehouseShipmentIdentification[0].depositorOrderNumber`, etc.) are guesswork — every partner converts EDI to JSON with subtle shape differences and the SuiteApp passes that shape through unchanged.
   - **Outbound**: **Orderful's JSON schema for this doc type** (from `docs.orderful.com` or the customer's Orderful Transaction Type page — the JSON contract Orderful expects you to produce). This is the source of truth: Orderful handles the JSON → EDI translation on its side. The trading-partner's EDI implementation guide is *supplementary*, useful for understanding required values and partner-specific qualifiers, but not the contract the script writes against.
5. **Why custom?** The specific JSONata limitation or business rule that requires code.

## The recipe

### Step 1 — Confirm a custom script is actually needed

Try JSONata first. The SuiteApp's Advanced Mapping handles most simple transforms. Only escape to custom code when:
- The EDI doc isn't on the SuiteApp's standard list (940, 945, 812, 820, 865, etc.)
- The source NS record is non-standard (PO instead of SO for 850 outbound)
- The transform requires multi-record joins, File Cabinet config, or external lookups
- Validation needs to happen on a NS record event (User Event), not on inbound EDI

If the user hasn't tried JSONata, redirect to `writing-inbound-jsonata` / `writing-outbound-jsonata` and stop.

### Step 2 — Configure the entity side

**First, pick the right entity record for the doc series:**

| Doc series | Entity | Also required |
|---|---|---|
| **800-series** (810, 812, 820, 850, 855, 856, 865, 870, 875, …) | **Customer** record | — |
| **900-series** (940, 943, 944, 945, 947, …) | **Vendor** record (the 3PL/warehouse) | A NetSuite **Location** set up for the 3PL, with the vendor linked. 945 fulfillment-creation needs this wired or the script can't resolve the target IF. |

Then, on that entity's record → **Orderful EDI Customer Transactions** subtab → enable the doc type → check **Process as Custom**. This sets `custrecord_edi_enab_trans_cust_process = T`. The label says "Customer" but the same subtab + field is used for vendors.

- **Inbound result:** incoming transactions of that type now land on `customrecord_orderful_transaction` with status `transaction_status_pending_cust_process` instead of being auto-processed.
- **Outbound result:** same subtab — set handling preference to **Custom (Manual/Workflow)** so the SuiteApp waits for your script's `Ready To Send` write instead of trying to generate the payload itself.

If the entity record or (for 900s) the Location isn't set up first, configuration on the subtab won't be possible. Stop and have the user create those records before proceeding.

### Step 3 — Choose the script type

| Direction | Trigger | Script type |
|---|---|---|
| Inbound, batch | Saved search of pending Orderful Transactions | **MapReduce** (scheduled) |
| Outbound, on NS record save | e.g. SO saved → emit 940 | **User Event** (`afterSubmit`) |
| Outbound, batch | Saved search of fulfilled records → emit 945 | **MapReduce** (scheduled) |
| Outbound, workflow-driven | Approval-based send | **WorkflowAction** |

### Step 4 — Author a library file FIRST

Every custom script in this pattern gets a sibling `<prefix>_Orderful_lib.js`. **Do not skip this** — it's where multi-script consistency lives, and it's the single biggest difference between a maintainable extension and a one-off.

What goes in the lib (frozen objects via `Object.freeze`):

- **Field-ID constants** — `TransactionBodyFields`, `TransactionLineFields`, `LocationFields`, etc. So no script hardcodes a `custcol_*` or `custbody_*` ID inline.
- **Script-parameter keys** — `ScriptParams = { searchId: 'custscript_orderful_xxx_ss', testMode: 'custscript_orderful_test_mode', ... }`. Single source of truth for parameter names.
- **Status-ID resolver** — `getStatusId(scriptId)` (snippet in `reference/record-types.md`).
- **ISA resolution** — `getCompanyIsaID()`, `getIsaOverrides()`, reading from customer/subsidiary records and the test-mode flag. Centralizes the live-vs-test ISA lookup that every outbound script needs.
- **Format helpers** — `parseDate8` (CCYYMMDD), `parseTime4` (HHMM), etc.
- **Item-lookup helpers** — `getItemLookup()` if the script does item resolution beyond the SuiteApp's built-in lookup.

The lib means the script file holds business logic only.

### Step 5 — Author the script

#### Inbound MapReduce shape

```js
/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/runtime', 'N/record', 'N/query', 'N/log', './<prefix>_Orderful_lib'], (runtime, record, query, log, lib) => {
  // getInputData → { type: 'search', id: <searchId from script param> }
  // map → load Orderful Transaction → JSON.parse(custrecord_ord_tran_message)
  //       → look up matching NS record → transform → create/update
  //       → set status to _success or _error
  // reduce → optional, for aggregating by NS record key (e.g. one IF per SO)
  // summarize → iterate map+reduce errors, log
});
```

**Universal inbound saved-search shape.** Every inbound custom-process script — 850, 812, 820, 944, 945, etc. — uses the same three-filter shape on `customrecord_orderful_transaction`. Only the doc-type value changes:

| Filter | Value |
|---|---|
| `custrecord_ord_tran_status` | `transaction_status_pending_cust_process` |
| `custrecord_ord_tran_direction` | `1` (Inbound) |
| `custrecord_ord_tran_document` | the doc-type internal ID for this script |

This is the entire trigger contract. The SuiteApp lands inbound transactions for any (customer × doc-type) with `Process as Custom` checked at this status; your script's saved search filters down to the doc-type it handles.

In `map`, on success: `record.submitFields` to set status to `transaction_status_success`. On error: status to `transaction_status_error` AND populate `custrecord_ord_tran_error` with the message. **Don't write to `reduce` on a map error** — that keeps the source transaction retryable on the next run.

#### Outbound shape (MR or UE)

**Your custom outbound script never POSTs to Orderful.** It only stages a record. The SuiteApp's own scheduled MR (`customscript_orderful_outbound_sending`) is what actually calls the Orderful API.

What the custom script does:
- Pull source NS record(s) — saved search via script param (MR) or `record.load` (UE).
- Build the EDI payload as JSON. Two shapes (see `reference/record-types.md` for which to use):
  - **X12 nested**: `{ sender: { isaId }, receiver: { isaId }, type: { name }, stream, message: { transactionSets: [...] } }`
  - **Simplified**: `{ senderId, receiverId, type, stream, message: {...} }`
- Create `customrecord_orderful_transaction` with: `direction = 2`, `status = transaction_status_ready_to_send`, `custrecord_ord_tran_message = JSON.stringify(payload)`, ISA sender/receiver populated, test-mode flag from the script parameter.
- Optionally write an EDI Transaction Join record linking the source NS record to the new Orderful Transaction (audit trail).

**That's the full job.** Once the record is saved at `Ready To Send`, control passes to the SuiteApp.

**What the SuiteApp does (separately, on a schedule):** `customscript_orderful_outbound_sending` runs on its own deployment schedule, queries for transactions at `transaction_status_ready_to_send`, POSTs each to the Orderful API, and flips the status to `_success` or `_error` (with `custrecord_ord_tran_error` populated on failure).

**Verify the sending script is scheduled.** In Customization → Scripting → Script Deployments → filter for `customscript_orderful_outbound_sending`:
- Status must be `Scheduled` (not `Not Scheduled` or `Testing`)
- A recurrence interval must be set (typical: every 5–15 minutes)
- If the deployment is missing or unscheduled, your `Ready To Send` records pile up and nothing reaches Orderful. This is the most common "I built the script but nothing's sending" cause.

### Step 6 — Deploy

1. **File Cabinet** → under `SuiteScripts`, create (or reuse) a folder named **`Orderful Scripts`** with a subfolder per doc type (`945`, `812`, etc.). Upload the script *and* its lib.
2. **Customization → Scripting → Scripts → New** — pick the script file. The wizard infers the type from the JSDoc.
3. **Add the deployment** — Status `Released`, log level `Audit` (or `Debug` for new scripts), set the role/audience.
4. **Define script parameters** on the Script record's Parameters subtab. Naming: `custscript_orderful_<purpose>` (e.g. `custscript_orderful_of945_ss` for the 945 saved-search ID). **Every environment-dependent ID — saved search, dataset, file, location, ISA — is a parameter. Nothing hardcoded in the script.**
5. **Create the saved search** the script consumes. Reference its internal ID via the script parameter on the deployment.
6. **(Optional) JSON config in File Cabinet** — if the script needs static mapping data (e.g. EDI reason code → GL account), drop a JSON file in the same Orderful Scripts folder and load via `N/file`. Keeps mapping out of code.
7. **Outbound only — verify the SuiteApp's sending script is scheduled.** Customization → Scripting → Script Deployments → search `customscript_orderful_outbound_sending`. Status must be `Scheduled` with a recurrence (every 5–15 minutes is typical). If it isn't, your custom script's `Ready To Send` records will pile up and never reach Orderful. This is a one-time per-customer check — but easy to miss when the SuiteApp was installed without the sending deployment ever being scheduled.

### Step 7 — Test in sandbox first

- **Inbound**: use `inject-test-transaction` to send a synthetic EDI doc → confirm it lands on `customrecord_orderful_transaction` with `pending_cust_process` → run the MR → verify the NS record was created and the status flipped to `_success`.
- **Outbound**: trigger via the source NS record (saved-search match or UE event) → check that `customrecord_orderful_transaction` was created with `Ready To Send` → wait for `customscript_orderful_outbound_sending` to run → verify status went to `_success` and the payload reached Orderful.

Don't deploy to prod until sandbox is green.

## Behaviour rules

1. **JSONata first.** If the requirement is JSONata-expressible, refuse to design a custom script. Redirect to the JSONata skills.
2. **Library file is mandatory.** Every script gets a sibling `*_Orderful_lib.js` with field IDs, status helpers, ISA resolution, format helpers, and script-param keys. No exceptions — even one-script extensions get a lib.
3. **Never hardcode environment-dependent IDs.** Saved search IDs, dataset IDs, file IDs, location IDs, ISA IDs — all go through `runtime.getCurrentScript().getParameter()`. If you find yourself typing a numeric ID in a `.js` file, stop.
4. **Always set a terminal status.** On every code path, the Orderful Transaction must end at `_success` or `_error`. Else it stays in `pending_cust_process` forever and re-runs every cycle.
5. **Don't write to `reduce` on map errors.** Keeps the source transaction retryable. Writing partial output and then erroring causes double-creates on retry.
6. **No payload contract, no code.** For inbound, refuse to draft `map` logic until you have a real `custrecord_ord_tran_message` sample for the doc type — pulled from an existing transaction or injected via `inject-test-transaction`. For outbound, refuse to draft payloads without **Orderful's JSON schema** for the doc type; partner EDI implementation guides are optional supplementary context, not the contract. Inferring field paths from doc-type names alone is guesswork and produces silent runtime failures.
7. **Don't auto-deploy.** Propose the deployment plan; the user clicks through the NS UI (Script record + deployment + parameters + saved search). The skill does not push code into NetSuite.
8. **SuiteScript 2.1.** `@NApiVersion 2.1`. Prefer `N/query` (SuiteQL) over `N/search` for new lookups. Don't mix both modules in one script.
9. **Customer-specific business rules stay in the customer's private repo.** This skill — and any shared lib it references — describes the generic shape. Per-customer field IDs, hardcoded locations, partner-specific overrides do not belong in shared code.
10. **One doc type per script.** Don't bundle a 945 processor and an 812 processor into one MR. Separate scripts, separate deployments, separate parameters.

## Reference material

- [`reference/record-types.md`](../../reference/record-types.md) — `customrecord_orderful_transaction` field map, `customlist_orderful_transaction_status` script IDs, the `getStatusId` SuiteQL helper, the `Process as Custom` customer-record toggle, X12 vs simplified outbound payload formats.
- [`reference/900-series-lifecycle.md`](../../reference/900-series-lifecycle.md) — for 940/943/944/945 work: which NS transaction each doc reads from / writes to, the SO-cycle vs TO-cycle vs PO-IS-cycle variants, and which downstream EDI fires automatically. **Consult before scoping any 9xx custom-process script.**
- [Orderful: Custom Process Inbound Transactions](https://docs.orderful.com/docs/custom-process-inbound-transactions) — canonical for inbound mechanics.
- [Orderful: Custom Process Outbound Transactions](https://docs.orderful.com/docs/custom-process-outbound-transactions) — canonical for outbound mechanics including the three trigger modes (status-based, button, workflow action) and payload format detection.
- `writing-inbound-jsonata`, `writing-outbound-jsonata` — try these *first*.
- `inject-test-transaction` — sandbox validation for inbound.
