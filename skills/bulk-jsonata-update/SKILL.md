---
name: bulk-jsonata-update
description: Apply a controlled JSONata change across every customer-enabled-transaction-type record of a given doc type in a customer's NetSuite. Walks through audit (with per-record backups), plan (textual diff preview), dry-run, deploy (one record at a time with read-back verification), and rollback. Use when the user says "I need to add field X to every 850 customer", "roll out an externalid mapping to all customers", "update all our 856 JSONata to do Y", "audit our existing JSONata", or any other "apply the same JSONata change to many enabled transactions" scenario. Does NOT change the SuiteApp source. Does NOT touch records the user did not approve. Refuses to deploy without an explicit dry-run + plan approval.
---

# Bulk JSONata Update

Apply a single JSONata change consistently across every `customrecord_orderful_edi_customer_trans` record for a given document type in a customer's NetSuite, with full backups, dry-run preview, per-record verification, and one-step rollback.

This skill exists because JSONata mappings live per-customer-per-doc-type on the Enabled Transaction record. When you need to change a mapping pattern (add a field, fix a typo, normalize behavior across the fleet), the change has to land on every applicable record. Ad-hoc scripts work but lose backups, drift between dry-run and live, and have no rollback story.

## When to use this skill

Triggers from the user:

- "Add an `externalid` mapping to every 850 inbound across all our customers"
- "Roll out the new ship-to logic to all 855 outbound"
- "Audit our 850 JSONata — I want to see what every customer is doing today"
- "We need to fix the casing typo in customer X's userDefinedFields block — and check the others"
- "Bulk update our prod JSONata for the [doc type] flow"

Do **not** use this skill for:

- Changes to a single customer's JSONata (just edit it directly via the SuiteApp UI or one-shot REST PATCH).
- Changes to the SuiteApp source code (different project, different review path).
- Changes to outbound JSONata that depends on customer-specific runtime state (workflow context, NS record IDs) — review carefully if the transformation references such fields.

## Inputs the skill needs up-front

Ask the user for:

1. **Customer slug** — the directory name under `~/orderful-onboarding/`. The skill reads `<slug>/.env` to pick prod/sandbox creds.
2. **Document type** — the EDI transaction type to target (e.g., `850_PURCHASE_ORDER`, `855_PURCHASE_ORDER_ACKNOWLEDGMENT`). The skill resolves this against the `customrecord_orderful_edi_document_type` table to get the FK id.
3. **Direction** — inbound or outbound (helps disambiguate when a doc type can be either; usually deducible from the doc type name).
4. **The change description** — what to insert / replace / delete in the JSONata. The skill expects a *transformation function* (a JS function `(originalJsonata) => { newJsonata, notes[] }`) — see "How to express the change" below.
5. **Environment** — sandbox or production. **Always start in sandbox.** Refuse to operate against production until the user has run a dry-run + at least one record live in sandbox.

## The recipe

### Step 1 — Audit (read-only)

Run `scripts/audit.mjs` against the customer's `.env`. It does:

1. Resolves the document-type FK id from the doc type name.
2. Pulls every `customrecord_orderful_edi_customer_trans` record where `custrecord_edi_enab_trans_document_type = <id>`.
3. For each record, writes the full JSONata to `<backup-dir>/jsonata-<docType>-<recordId>-<customerEntityId>-<ts>.txt`.
4. Writes an `audit-summary-<ts>.json` with one entry per record: id, customer name, customer entityid, company ISA, jsonata version, use_custom flag, jsonata length, has-userDefinedFields flag, style detection (`$merge` / `~>` / mixed), backup path.
5. Surfaces side findings: records with empty JSONata, lowercase `userdefinedfields` typos, missing `userDefinedFields` block, very-short JSONata that may be defaults.

Default backup dir: `~/orderful-onboarding/<customer-slug>/jsonata-backups/<docType>/`.

Report the audit summary back to the user. **Stop here and confirm scope before continuing.** Surface anything unusual — the audit is the cheapest place to catch a mismatch in expectations.

### Step 2 — Plan & dry-run

Together with the user, articulate the transformation. Two common shapes:

- **Insert a key into `userDefinedFields`** (today's most common pattern): "add `externalid` as the first entry of every record's `userDefinedFields` block." The skill ships a helper `transformations/insertIntoUserDefinedFields.mjs` for this case — pass it the key name, the JSONata expression that produces the value, and an optional comment.
- **Custom transformation**: write a small `(original, recordId) => { newJsonata, notes[] }` function. The function must throw if it can't do the transformation safely; the skill stops the run on first throw.

Run `scripts/deploy.mjs --dry-run` with the audit summary + the transformation. The script:

1. Loads each backup.
2. Applies the transformation in memory.
3. Writes the new JSONata to `<backup-dir>/transformed/jsonata-<docType>-<recordId>-NEW.txt` for diffing.
4. Logs per-record byte deltas + transformation notes to `<backup-dir>/deploy-dryrun-<ts>.log.jsonl`.

**Show the user a diff for at least one record (preferably one that exercises any edge case — e.g., the lowercase typo).** Get explicit approval to proceed before running live.

### Step 3 — Sandbox validation

For non-trivial transformations, the user should validate in sandbox before prod:

1. Switch to the customer's sandbox `.env` (or use a separate sandbox onboarding dir).
2. Run audit + dry-run in sandbox first to confirm the transformation works against sandbox shapes.
3. Run live on a single sandbox record (`--only=<recordId>`).
4. Use the `inject-test-transaction` skill to send a test inbound and confirm the resulting Sales Order has the expected fields.

Don't skip this. The hot path for failures is "the transformation worked syntactically but produced semantically wrong output for a customer-specific edge case."

### Step 4 — Deploy

`scripts/deploy.mjs --execute` (optionally `--only=<id>,<id>` for a subset, or `--exclude=<id>,<id>` to skip records that need manual handling).

For each record:
1. PATCH `customrecord_orderful_edi_customer_trans/<id>` setting `custrecord_edi_enab_jsonata` to the transformed string.
2. Read back the field via SuiteQL.
3. Compare byte-for-byte to what was sent. Fail loudly on mismatch.
4. Log the result to `deploy-live-<ts>.log.jsonl`.

**Stop on first failure.** Do not continue trying to PATCH other records — investigate the specific failure, decide whether to skip it or roll back and reapproach.

### Step 5 — Rollback (if needed)

`scripts/restore.mjs <recordId>` or `scripts/restore.mjs --all` reads from the most recent audit-summary backup files and PATCHes each record back to its pre-state JSONata. Use immediately on any unexpected post-deploy behavior — backups are local and revert is cheap.

### Step 6 — Monitor (optional but recommended)

After deploy, watch for:
- Inbound transactions with status `Failed` referencing the changed fields.
- A drop in coverage (e.g., expected externalid not appearing on new SOs).
- New error messages in `custrecord_ord_tran_validation_results` not seen pre-deploy.

The skill ships a starter `scripts/post-deploy-monitor.mjs` template — fork it for the specific change.

## How to express the change

The transformation is a function `(originalJsonata, recordId) => { newJsonata, notes[] }`. Examples:

```js
// Pattern 1: insert one line at top of userDefinedFields
import { insertIntoUserDefinedFields } from './transformations/insertIntoUserDefinedFields.mjs';

const transform = insertIntoUserDefinedFields({
  key: 'externalid',
  expression:
    '$defaultValues.transaction.purchaseOrderNumber & "-" & ' +
    'message.transactionSets[0].beginningSegmentForPurchaseOrder[0].transactionSetPurposeCode',
  comment: 'External ID = PO# + "-" + BEG01 — uniqueness guard',
  fixCasingTypo: true, // also fix lowercase userdefinedfields → userDefinedFields if seen
});
```

```js
// Pattern 2: custom regex replacement
function transform(original, recordId) {
  const notes = [];
  // ...your logic...
  if (!result.changed) throw new Error(`Record ${recordId}: pattern not found`);
  return { newJsonata: result.text, notes };
}
```

The transformation must:
- Throw on any record where the change can't be safely applied (don't silently no-op).
- Return `notes[]` listing every observable change made (used in the deploy log + rollback diff).
- Be deterministic — calling it twice with the same input must produce the same output.

## Behaviour rules

1. **Always audit first.** Never deploy without a written summary of the current state.
2. **Always dry-run before live.** No exceptions. The dry-run output is the artifact you show the user for approval.
3. **One transformation per run.** Do not bundle unrelated changes. If the audit surfaces a side bug worth fixing (like a casing typo), surface it but ask whether to bundle or split — default to splitting unless the user explicitly says to bundle.
4. **Sandbox first, prod second.** Refuse to deploy to production without prior sandbox validation, even if the user pushes. If the customer doesn't have a sandbox configured, escalate; don't shortcut.
5. **Stop on first failure.** No partial-state recovery in the loop. The user can resume after fixing the underlying issue.
6. **Read back every PATCH.** Trust nothing. The SuiteApp's JSONata field is a long-text field; truncation or character-encoding bugs in transit have happened.
7. **Never skip backups.** If the audit hasn't run, the deploy script must refuse. Restore depends on the backups existing.
8. **Surface side findings, don't silently fix.** If a record has an unexpected shape (lowercase keys, unbalanced braces, empty JSONata), report it; let the user decide.
9. **Don't run against records the user excluded.** Honor `--exclude` strictly; do not "helpfully" include skipped records on a retry.
10. **Don't deploy to records with `custrecord_edi_enab_trans_cust_process = T`** (custom-process mode) without explicit user acknowledgement — those records' JSONata has different semantics.

## Outputs the skill produces

- `<backup-dir>/jsonata-<docType>-<recordId>-<customerEntityId>-<ts>.txt` — one per audited record (read-only)
- `<backup-dir>/audit-summary-<ts>.json` — machine-readable inventory
- `<backup-dir>/transformed/jsonata-<docType>-<recordId>-NEW.txt` — one per record on dry-run
- `<backup-dir>/deploy-dryrun-<ts>.log.jsonl` — dry-run audit log
- `<backup-dir>/deploy-live-<ts>.log.jsonl` — live deploy audit log
- `<backup-dir>/restore-<ts>.log.jsonl` — restore log (if rollback runs)

These are the user's audit trail. Don't move or delete them; they're the only path to a clean rollback.

## Reference material

- `reference/record-types.md` — `customrecord_orderful_edi_customer_trans` schema and fields
- See also the `writing-outbound-jsonata` skill for guidance on what's safe to put in JSONata expressions
- See the `inject-test-transaction` skill for the recommended sandbox validation flow
