---
name: inspect-inbound-diagnostics
description: Read the Orderful SuiteApp's inbound diagnostic log (customrecord_orderful_diagnostic) to see the mapped Business Data Object (BDO) for an inbound transaction — what the SuiteApp parsed from the EDI and intended to write to NetSuite. Use when an inbound 850/860/etc. processed "Success" but the resulting Sales Order is missing data (ship-to address, location, item match, store/department), when the user says "check the inbound logs", "why is the SO missing X", "inspect the inbound diagnostics", "/inspect-inbound-diagnostics", or when inbound behavior is mysterious and you'd otherwise start guessing.
---

# Inspect Inbound Diagnostics

The SuiteApp writes a step-by-step trace of inbound mapping to `customrecord_orderful_diagnostic`. Each record holds a JSON `log_text` showing the **Business Data Object (BDO)** — the SuiteApp's internal representation of the parsed EDI right before it writes NetSuite records. Reading it is the fastest way to answer "did the SuiteApp parse this correctly, and what did it intend to write?" — which cleanly separates a **mapping** problem (BDO is wrong) from a **write** problem (BDO is right, the NS record came out wrong).

Reach for this **early** when inbound behavior is mysterious, instead of theorizing about config. It frequently turns a multi-hour guessing loop into a one-query answer.

## When to use this skill

- "The 850 came in Success but the SO has no ship-to address — check the inbound log"
- "Why didn't the location get assigned on this order?"
- "Inspect the inbound diagnostics for transaction 9xxxxxxxx"
- "/inspect-inbound-diagnostics"
- Any inbound 850/860 that processed without error but produced a record that's missing or wrong

Do NOT use this skill for:
- `ITEM_LOOKUP_MISSING` / item-matching failures — that's [`item-lookup`](../item-lookup/SKILL.md) (though the diagnostic's "found item" step is a useful cross-check).
- Outbound message debugging — read `custrecord_ord_tran_message` and use [`writing-outbound-jsonata`](../writing-outbound-jsonata/SKILL.md).

## Inputs the skill needs

1. **The Orderful transaction ID** of the inbound message (e.g. from `custrecord_ord_tran_orderful_id` on the `customrecord_orderful_transaction` row, or the SO's `custbody_orderful_document`).
2. **Customer slug** — for env loading (`~/orderful-onboarding/<slug>/.env`).

## The recipe

### Step 1 — Pull the diagnostic record(s)

The log is keyed by the Orderful transaction id (a string field, not the NS record id):

```sql
SELECT id,
       custrecord_orderful_diag_ns_record_type AS rectype,
       custrecord_orderful_diag_ns_record_id   AS recid,
       custrecord_orderful_diag_log_text        AS log
FROM customrecord_orderful_diagnostic
WHERE custrecord_orderful_diag_transaction_id = '<orderfulTxnId>'
ORDER BY id
```

`custrecord_orderful_diag_log_text` is a JSON array of `{ "step": ..., "data": [...] }` objects. The log can be large — pipe it through a JSON parser rather than reading raw.

### Step 2 — Walk the steps

Common steps in an inbound 850 trace:

| Step | What it shows | Use it to check |
|---|---|---|
| `PO to BDO Mapping` | each EDI line mapped to the SuiteApp's item/quantity/price shape | qualifiers parsed, UOM, price, line refs |
| `found item` | item-resolution results (`returnObj.itemId`, `unitTypeNS`) | item matching, case-pack qty |
| `Order Split` | the **full BDO** per resulting order: `transaction` (header), `transactionLines`, `customerConfig`, `customerSettings`, `splitKey` | the headline — see below |

The `Order Split` step's `transaction` object is the most useful: it carries `shippingAddress`, `billingAddress`, `shipToId`, `location`, `locationLookup`, `department`, `subsidiary`, `dcNumber`, `userDefinedFields`, plus `customerConfig` (the resolved parent/sub-customer, ISA, `subcust_rep`, ship-lookup config) and `customerSettings` (`packagingDataSourceId`, `sendAsnWithoutPack`, etc.).

### Step 3 — Separate "mapping wrong" from "write wrong"

Compare the BDO against the NetSuite record that was created:

- **BDO field is empty/wrong** → mapping/config problem. The EDI value didn't parse, or a lookup (item, location, customer/sub-customer) didn't resolve. Chase the relevant config.
- **BDO field is correct but the NS record is missing it** → a **write-step gap in the SuiteApp** (the BDO had the value but it wasn't persisted). This is not something customer config or JSONata can fix — capture the BDO-vs-record evidence and escalate to the SuiteApp devs.

Concrete example this skill was built from: an inbound 850 produced a Sales Order with an empty shipping address. The diagnostic's `Order Split` BDO had `transaction.shippingAddress` fully populated from `N1*ST` (addr1/city/state/zip), and `billingAddress` identically populated. On the resulting SO, the billing address persisted but the shipping address did not — proving the mapping was correct and the SO **write step drops `shippingAddress`**. That distinction (BDO right, write wrong) is the entire value of reading the log: it turned a config wild-goose-chase into a one-line dev escalation.

## Behaviour rules

1. **Read the log before theorizing.** When an inbound record is missing data, the diagnostic answers "mapped wrong vs. written wrong" directly. Guessing at config first (subcustomer setup, ship-to lookups, flags) wastes time the log would save.
2. **Key on the Orderful transaction id, not the NS record id.** `custrecord_orderful_diag_transaction_id` is the Orderful id as a string; don't confuse it with the diagnostic record's own internal id.
3. **State the mapping-vs-write conclusion explicitly.** "BDO has it, SO doesn't" is a SuiteApp write bug → escalate with the evidence; "BDO is missing it" is config → keep diagnosing. Don't blur the two.
4. **Don't paste raw customer EDI/PII into shared notes.** The log contains real addresses, item data, and identifiers. Quote only the field names and the structural finding when reporting or capturing a learning.
5. **Diagnostics are a read-only diagnostic surface.** Don't write to or delete `customrecord_orderful_diagnostic`.

## Reference material

- [`item-lookup`](../item-lookup/SKILL.md) — for `ITEM_LOOKUP_MISSING`; cross-check against the diagnostic "found item" step.
- [`enable-customer`](../enable-customer/SKILL.md) — ship-to / sub-customer / department resolution config that shows up in the BDO `customerConfig`.
- [`reprocess-transaction`](../reprocess-transaction/SKILL.md) — re-run an inbound transaction after a config fix to regenerate the diagnostic.
