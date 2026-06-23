---
name: cleanup-orderful-transactions
description: Delete failed/duplicate "Orderful Transaction" (customrecord_orderful_transaction) records and their customrecord_orderful_edi_trx_join rows in a customer's NetSuite, keeping the valid (Success) record for each consolidation group — and optionally delete the matching unsent transactions on the Orderful platform. Use after an outbound document was (re)fired several times during debugging and left Error-status duplicates, or when the user says "clean up the failed transactions", "remove the duplicate Orderful Transaction records", "delete the failed OTs for this invoice/order", "clean up the invalid trx and joins", or "/cleanup-orderful-transactions". Dry-run by default; deletes only Error duplicates that have a Success sibling; never deletes the valid record.
---

# Cleanup Orderful Transactions

Iterating on an outbound mapping means firing the same source document (invoice, item fulfillment, etc.) through the SuiteApp repeatedly. Each fire creates a fresh `customrecord_orderful_transaction` (OT) record + a `customrecord_orderful_edi_trx_join` row linking it to the source. After a few rounds you're left with a pile of Error-status OTs for one document and a single good one. This skill removes the failures and keeps the winner.

It works one **source transaction** at a time, groups its OTs by consolidation key, and deletes only the **Error** records that have a proven **Success** sibling — joins first, then the OTs. It is **dry-run by default**. If Orderful API credentials are present, it also deletes the matching transactions on the Orderful platform, but **only while they are unsent**.

## When to use this skill

- "clean up the failed 810 transactions for invoice 1234567 — I re-fired it five times"
- "remove the duplicate Orderful Transaction records on acme-foods, keep the valid one"
- "delete the failed OTs and joins for this fulfillment"
- "we've got three Error transactions and one Success for the same invoice — clean it up"
- "/cleanup-orderful-transactions acme-foods 1234567"

## Inputs the skill needs

- **Customer slug** — which `~/orderful-onboarding/<slug>/` to use. Ask if not specified; list the available dirs. Stop and direct to `/netsuite-setup` if the dir has no `.env`.
- **Source transaction internal ID** — the NetSuite internal id of the source record the OTs were generated from (the Invoice for an 810, the Item Fulfillment for an 856, etc.). This is **not** the OT id and **not** the Orderful UUID. The join table's `custrecord_orderful_netsuite_transaction` points at this id.

## The recipe

### Step 1 — Dry-run (always first)

```sh
node <path-to-this-skill>/cleanup-orderful-transactions.mjs ~/orderful-onboarding/<slug> <source-transaction-id>
```

The script reads the customer's `.env` (picks `NS_SB_*` or `NS_PROD_*` from `ENVIRONMENT`), then:

1. Finds every consolidation key the source feeds (via the join table) and pulls **all** OTs in those keys — including any join-less orphans — with their status, `orderful_id`, testmode, and join rows.
2. Groups by `custrecord_orderful_consolidation_key`.
3. Within each group, marks the **Success** record(s) as keepers and the **Error** records as delete candidates.
4. Prints the full NetSuite plan **and** the Orderful-side plan (which platform transactions are unsent and would be deleted) — and changes nothing.

### Step 2 — Review the plan with the user

Confirm the keeper is the one they expect (Success, has an `orderful_id`) and the candidates are all the failed attempts. **Production runs require explicit confirmation** before applying.

### Step 3 — Apply

```sh
node <path-to-this-skill>/cleanup-orderful-transactions.mjs ~/orderful-onboarding/<slug> <source-transaction-id> --apply
```

`--apply`:

1. Re-asserts each group still has exactly one Success keeper and the candidates are still Error.
2. Backs up the full OT + join JSON to `~/orderful-onboarding/<slug>/cleanup-backup-<source-id>-<timestamp>.json`.
3. Deletes **join rows first, then OT records** (REST DELETE → HTTP 204).
4. If `ORDERFUL_API_KEY` + `ORDERFUL_ORG_ID` are set, deletes each candidate's Orderful transaction **only if it is still unsent** (`deliveryStatus = PENDING`), re-checking immediately before each delete.
5. Re-queries and confirms only the keeper(s) remain.

## What counts as a keeper vs a duplicate

| OT status | Action | Why |
|---|---|---|
| **Success** (`TRANSACTION_STATUS_SUCCESS`) | **Keep** | The valid record — the one that posted cleanly. Never deleted. |
| **Error** (`TRANSACTION_STATUS_ERROR`) | Delete — **only if** the group has a Success sibling | A failed/superseded attempt. If there's no Success sibling, it's the *only* record of that document — skipped (you may still need it to diagnose/reprocess). |
| Pending / AwaitingSiblings / anything else | Skip | In-flight or not a duplicate. Out of scope. |

Status codes seen in SuiteQL: `1` = Success/Sent, `3` = Error. `testmode` `F` = LIVE, `T` = TEST.

Edge cases the script skips (and tells you about):
- A group with **no** Success keeper → nothing deleted (don't destroy the only attempt).
- A group with **more than one** Success record → ambiguous, resolve manually.
- An Error OT whose join links it to **another** source transaction → it's part of a consolidation spanning multiple sources; skipped for safety.

## Orderful-side deletion (unsent only)

An Error OT that actually reached Orderful carries an `orderful_id`. Orderful permits deleting a transaction **only while it is unsent** (`deliveryStatus = PENDING`) — a sent/delivered transaction is an immutable audit record and the delete is refused. The script:

- deletes via `DELETE https://api.orderful.com/v2/transactions/<id>` with `orderful-api-key` + `X-ActingOrgId` headers (the org-scoped `/v2/organizations/<org>/transactions/<id>` path returns 403 for deletes — use the non-scoped path);
- only ever targets the `orderful_id`s of the **Error** OTs being removed, so the keeper's transaction is never in the delete set;
- re-confirms `deliveryStatus = PENDING` immediately before each delete and skips anything sent.

OTs rejected at ingestion (e.g. a data-format mismatch) never get an `orderful_id`, so there's nothing to delete on the platform for those — only the NetSuite OT + join.

## Required role permissions

Deleting custom-record entries needs **Custom Record Entries = Full** on the **Lists** subtab of the TBA role (Full is required for delete; Edit only covers create/update). This is the same generic `CUSTRECORDENTRYPERM` that gates `customrecord_orderful_transaction` and `customrecord_orderful_edi_trx_join` — the per-record-type permission rows are ignored under that access type. Administrator already has it.

## Behaviour rules

1. **Always dry-run first; never pass `--apply` without showing the user the plan.** Deletes are irreversible (the JSON backup is for reference, not a one-click restore).
2. **Never delete a Success (keeper) record, on either side.** The script enforces this; don't work around it.
3. **Only delete Error OTs that have a Success sibling.** A lone Error OT with no successful retry is the only record of that document — leave it (the user may want to reprocess or diagnose it).
4. **Require explicit confirmation for production.** The script reads `ENVIRONMENT`; if it's `production`, confirm with the customer/owner before `--apply`.
5. **Orderful deletes are unsent-only.** Never attempt to delete a sent/delivered Orderful transaction; the script guards this, and you shouldn't override it.
6. **One source transaction per invocation.** No batch mode. Run it again for the next document.
7. **Don't delete across consolidations.** If a candidate OT links to other source transactions, skip it and tell the user — deleting it would affect documents you weren't asked to touch.
8. **Don't paste credentials into chat.** Everything stays in the `.env`; the script reads it locally.

## Reference material

- Custom record schema: [`reference/record-types.md`](../../reference/record-types.md) — the `customrecord_orderful_transaction` section, plus `customrecord_orderful_edi_trx_join` (the typed link between a NetSuite source transaction and its OT — prefer it over parsing the consolidation key).
- Transaction status enum: `Models/orderful_transaction.ts` → `OrderfulTransactionStatus` in the [netsuite-connector](https://github.com/Orderful/netsuite-connector) repo.
- Companion skills: [`/reprocess-transaction`](../reprocess-transaction/SKILL.md) (retry a single inbound OT), [`/fetch-validations`](../fetch-validations/SKILL.md) (why an outbound transaction is INVALID before you decide it's a throwaway).
