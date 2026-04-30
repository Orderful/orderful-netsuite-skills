---
name: item-lookup
description: Diagnose and propose fixes for ITEM_LOOKUP_MISSING errors on inbound 850 purchase orders. Combines NetSuite item search, Orderful transaction context, and customer-specific matching conventions to propose a single, scoped lookup record for the contractor to approve. Use when the user mentions a failing 850, a missing item lookup, ITEM_LOOKUP_MISSING, or asks to map a partner part number to a NetSuite item.
---

# Item Lookup Diagnosis

## When to use this skill

Use when the user says any of:

- "my 850 failed with item lookup missing"
- "ITEM_LOOKUP_MISSING"
- "help me fix a failing PO"
- "I need to add an item mapping" / "add a partner-part-to-item lookup"
- "this 850 has an unknown SKU"
- "the connector can't find the item for X"
- "create an item lookup for ABC-123 → \<NS item\>"

If the user is asking about a different failure mode (a stuck 855, a packing-group issue, a field-mapping problem), do NOT load this skill — it's specific to inbound-850 item-lookup failures.

## Prerequisites

This skill assumes the user has already run the `netsuite-setup` skill for the customer in question. That skill creates `~/orderful-onboarding/<customer-slug>/.env` containing `NS_SB_*` / `NS_PROD_*` TBA credentials and `ORDERFUL_API_KEY`, plus an `ENVIRONMENT=sandbox|production` selector.

Before issuing any SuiteQL or Orderful API calls, confirm with the user which customer slug they're working on and load the matching `.env`. Use the patterns in `samples/list-edi-customers.mjs` (SuiteQL with TBA OAuth 1.0a signing) and `skills/netsuite-setup/test-connections.mjs` as references for executing requests. If no `.env` exists for the customer yet, route the user to `/netsuite-setup` first.

## Inputs the skill needs

Ask up-front (do NOT proceed without these):

1. **The failing transaction ID.** Either:
   - The Orderful Transaction ID (UUID-shaped), or
   - The NetSuite internal ID of the `customrecord_orderful_transaction` row, or
   - A direct Orderful UI link (e.g. `https://app.orderful.com/transactions/...`)
2. **The customer entity** (NS internal ID or name) — sometimes implied by the transaction, sometimes the user knows it directly.

If the user has only "an 850 from \<customer\> is failing", ask them to find the specific failing transaction first (search `customrecord_orderful_transaction` by entity + status). Don't guess — multiple transactions may be failing for different reasons.

## The recipe

### Step 1 — Load failure context

From NetSuite, fetch the failing inbound transaction record + its error detail:

```sql
SELECT
  t.id                              AS ns_tran_id,
  t.custrecord_ord_tran_orderful_id AS orderful_tran_id,
  t.custrecord_ord_tran_status      AS status,
  t.custrecord_ord_tran_entity      AS customer_id,
  t.custrecord_ord_tran_isa_sender  AS isa_sender,
  t.custrecord_ord_tran_link        AS orderful_link,
  t.custrecord_ord_tran_error       AS error_summary
FROM customrecord_orderful_transaction t
WHERE t.id = :ns_tran_id   -- or use custrecord_ord_tran_orderful_id
```

Then fetch line-level error rows from `customrecord_orderful_transaction_error` linked to the same transaction. The error rows tell you which `(qualifier, value)` pair(s) failed to match.

(See [reference/record-types.md](../../reference/record-types.md) §`customrecord_orderful_transaction` and §`customrecord_orderful_transaction_error`.)

Also fetch the corresponding Orderful-side transaction (raw EDI / parsed JSON) via the Orderful API:

```
GET https://api.orderful.com/v3/transactions/{orderful_tran_id}
Headers: orderful-api-key: ${ORDERFUL_API_KEY}, Accept: application/json
```

This gives you the full PO1-loop content: every `(qualifier, value)` pair on the failing line, the description, the unit price, physical attributes, the partner-supplied PO line number.

### Step 2 — Cross-qualifier check (most common fix)

For each `(qualifier, value)` on the failing PO1 line, check whether the value already exists in `customrecord_orderful_item_lookup` for this customer **under any other qualifier**:

```sql
SELECT
  l.id                                          AS lookup_id,
  l.custrecord_orderful_item_qualifier          AS qualifier,
  l.custrecord_orderful_item_qualifier_value    AS value,
  l.custrecord_orderful_item_item               AS ns_item_id,
  l.custrecord_orderful_item_subsidiary         AS subsidiary_id
FROM customrecord_orderful_item_lookup l
LEFT JOIN map_customrecord_orderful_item_lookup_custrecord_orderful_item_customer cm
  ON cm.mapone = l.id
WHERE l.isinactive != 'T'
  AND UPPER(l.custrecord_orderful_item_qualifier_value) = UPPER(:value)
  AND (cm.maptwo IS NULL OR cm.maptwo = :customer_id)
ORDER BY
  CASE WHEN cm.maptwo = :customer_id THEN 0 ELSE 1 END
```

If you find a match for the **same value** under a **different qualifier**, the fix is almost always:

> Add a new lookup record with the *missing* qualifier + value, pointing at the same NS item the existing lookup uses, scoped to the same customer.

**Do NOT** modify the existing lookup; create a new one. Don't bundle multiple changes.

### Step 3 — Candidate search (when no cross-qualifier hit)

If Step 2 finds nothing, search the customer's NS item master for candidates that look like the failing PO1 line. Combine these signals (any one alone is too weak):

| Signal | Source | Use as |
|---|---|---|
| Description / partner SKU strings | `item.itemid`, `item.displayname`, `item.description` (also custom alias fields if present) | Fuzzy text match against PO1 description |
| Unit price | NS `item.baseprice`, customer-specific item rates | ±20% match against PO1 `unitPrice` |
| Physical attributes | NS item dimensions, weight, pack | Match PO1 `itemPhysicalDetails` if present |
| Recent purchase history | NS sales orders / 850s for this customer | "items this customer has ordered before" — strong prior |

Build a candidate list of 1-5 items. Score each by how many signals matched.

```sql
-- Example: find items this customer has ordered before, joined with text similarity
SELECT DISTINCT
  i.id, i.itemid, i.displayname, i.description, i.baseprice
FROM item i
JOIN transactionline tl ON tl.item = i.id
JOIN transaction tx     ON tx.id   = tl.transaction
WHERE tx.entity   = :customer_id
  AND tx.recordtype = 'salesorder'
  AND (
    UPPER(i.itemid)     LIKE '%' || UPPER(:partial_sku) || '%' OR
    UPPER(i.displayname) LIKE '%' || UPPER(:description_keyword) || '%' OR
    UPPER(i.description) LIKE '%' || UPPER(:description_keyword) || '%'
  )
  AND i.isinactive = 'F'
FETCH FIRST 10 ROWS ONLY
```

Adjust the keywords based on the actual PO1 content.

### Step 4 — Confidence scoring + propose

Score each candidate:

- **High confidence** (≥3 strong signals match): one clear winner. Propose creating a single lookup mapping `(qualifier, value)` → that NS item ID.
- **Medium confidence** (2 signals): show the user the top 2-3 candidates with the signals that matched. Let them pick.
- **Low confidence** (≤1 signal, or no candidates): **escalate, do not propose.** Tell the user what you searched for and what didn't match. Suggest they manually identify the right NS item.

### Step 5 — Output the proposed plan

For high-confidence fixes, output a structured proposal — never the actual write. Format:

```
PROPOSED FIX

Create item-lookup record:
  Customer:  <customer name> (id: <customer_id>)
  Qualifier: <qualifier>
  Value:     <value>
  NS Item:   <item itemid> — <displayname> (id: <ns_item_id>)

Reasoning:
  - <signal 1: e.g. partner SKU "ABC-123" matches NS item ABC-123-EA at 100% string sim>
  - <signal 2: e.g. unit price $59.99 matches NS list price $60.00 (within ±0.02%)>
  - <signal 3: e.g. customer has ordered this NS item 12 times in the last 90 days>

Confidence: high

To apply: in NetSuite, navigate to Customization → Lists, Records, & Fields → Record
Types → Orderful Item Lookup → New, fill in the fields above, and save. Then reprocess
transaction <ns_tran_id> in NS to verify the fix.
```

Then **stop**. Wait for the user to confirm. The skill never writes to NS itself.

If the user confirms, restate the manual steps clearly. If they want to do it via the API, point them at `record.create` patterns but make them invoke that themselves — this skill is propose-only.

## Behaviour rules

1. **Never create a lookup record without explicit user approval.** Always propose first; let the user execute (or have a future productized agent execute via approved plan).
2. **Reject ambiguous matches.** If no candidate has high confidence, escalate. Surface what you tried and why nothing matched. Don't propose a guess.
3. **Never invent items.** If you can't find the candidate NS item via SuiteQL, say so. Don't fabricate item IDs or names.
4. **Don't bundle unrelated fixes.** One failing transaction, one scoped lookup proposal. If the same 850 has multiple failing lines, propose one fix per line in separate output blocks — not a single combined diff.
5. **Preserve user intent on qualifiers.** If the PO sends `BP=ABC-123`, propose creating `BP=ABC-123 → \<item\>`. Don't silently propose a `UP=` lookup unless the cross-qualifier check (Step 2) showed that pattern, and even then, propose it as one additional lookup, not a replacement.
6. **Show your reasoning.** Every proposal includes the signals that led to the match. The user is approving based on your reasoning — make it inspectable.
7. **Reprocessing is NOT automated.** After the lookup is created, the user manually reprocesses the failed transaction in NS. This skill never triggers reprocessing.
8. **No echoing secrets.** API keys, NS tokens — never repeat them back to the user.
9. **Customer-restrict, don't subsidiary-restrict, by default.** Skip the subsidiary field on proposed lookups unless the customer specifically operates per-subsidiary. Most customers don't.
10. **Confirm `isinactive = F`** on any existing lookup you found in Step 2 before suggesting it as a "the existing item is X" reference. An inactive lookup doesn't fire at runtime.

## Common gotchas

- **Customer multi-select is empty.** If the existing lookup has no customer restriction (`maptwo IS NULL`), it fires for every customer. Adding a customer-specific lookup will *not* override it — they coexist. If the existing global lookup points at the wrong item for this customer, you need to either inactivate the global lookup or add a customer-specific one (the connector prefers customer-specific). Tell the user.
- **Trailing whitespace / hidden chars in the lookup value.** If `UPPER(value) = UPPER(:value)` looks like it should match but doesn't, suspect non-printable characters. Tell the user to inspect the existing record's value field for whitespace.
- **Wrong subsidiary restriction.** If the customer's transaction is in subsidiary A but the lookup is restricted to subsidiary B, no match. Cross-check `custrecord_orderful_item_subsidiary` against the transaction's subsidiary.
- **Inactive item.** The proposed `ns_item_id` must be active (`item.isinactive = 'F'`). If it's inactive, the lookup will fire but the downstream sales-order creation will fail. Verify before proposing.

## Reference material

- [`reference/record-types.md`](../../reference/record-types.md) — full schema for `customrecord_orderful_item_lookup`, `customrecord_orderful_transaction`, and the related records this skill queries.
