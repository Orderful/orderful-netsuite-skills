---
name: enable-customer
description: Configure a NetSuite parent customer (and its subcustomers) for EDI via the Orderful SuiteApp. Audits existing Orderful Enabled Transaction records, N1 ship-to fields on subcustomers, and the parent's "subcustomers represent" setting; cross-references with Orderful partner relationships and historical 850 ship-to IDs; then guides the user through creates/updates to close any gaps. Use when the user says "enable <customer> for EDI", "set up <customer> transactions", "configure <customer> in Orderful", "add <customer> to Orderful", or is bringing a new trading partner online and needs the NetSuite side wired up. Does NOT create customers or subcustomers (the SuiteApp auto-creates subcustomers on first inbound ship-to). Does NOT delete records.
---

# Enable Customer: EDI Configuration for a NetSuite Customer

Guide the user through configuring a NetSuite **parent customer** and its **subcustomers** for EDI via Orderful. At the end, the parent should have:

- A complete set of `Orderful Enabled Transaction` records matching the transaction types enabled on the Orderful partner relationship.
- `custentity_orderful_subcust_rep` set to `stores` or `dcs`.
- Every subcustomer that the skill can match should have `custentity_orderful_shipto_n1_id` filled in.

## Scope

**In scope**:
- Create new Enabled Transaction records (`customrecord_orderful_edi_customer_trans`).
- Update existing Enabled Transaction records to match Orderful relationships.
- Set `custentity_orderful_subcust_rep` on the parent.
- Set `custentity_orderful_shipto_n1_id` on each subcustomer where a ship-to match can be inferred.
- Verify by reading back after writes.

**Out of scope** (do not attempt):
- Creating customers or subcustomers — the SuiteApp does **not** create either. If the inbound N1*ST doesn't match a subcustomer, the Sales Order falls back to the parent customer; no record is created automatically. Flag missing subcustomers in the report; don't create them.
- Deleting Enabled Transaction records or clearing fields.
- Configuring advanced flags: `isProcessAsCustom`, consolidation method, JSONata advanced mapping, 860 change rules, 810 source type. Leave defaults; the user tunes these later by hand. **Exception:** For P2P (Procure-to-Pay) flows where the customer sends outbound 850s, every ECT record must have `isProcessAsCustom = T` since the native SuiteApp logic does not handle P2P. See `reference/ndcinc-p2p.md`.

**P2P vendor entity gap:** The SuiteApp's `custentity_orderful_*` fields (ISA ID, subcust_rep, shipto_n1_id) only exist on **Customer** entity records in NetSuite. P2P customers where the trading partner is a **Vendor** (e.g., MARS buys from NDC) have a fundamentally different NS data model. This skill does not cover Vendor entity configuration. If the trading partner is a Vendor, flag this gap and note that custom fields on the Vendor record may need to be created manually. See `reference/ndcinc-p2p.md` lesson #9.

## Prerequisites

1. The `netsuite-setup` skill has already run for this customer. `~/orderful-onboarding/<slug>/.env` exists and both connections validate.
2. The parent NetSuite Customer record exists and has `custentity_orderful_isa_id` set — this is the join key between NS and Orderful. If it's blank, stop and ask the user to populate it in NetSuite before running the skill.
3. The `customrecord_orderful_edi_document_type` seed records exist in the target NetSuite account (installed with the SuiteApp). These are the FKs that `custrecord_edi_enab_trans_document_type` points at.

## Step 1 — Identify the parent customer

Ask the user for one of:
- NS Customer internal ID (fastest)
- NS Customer entity ID (business identifier)
- Company name (substring search)

Use the `.env` from `netsuite-setup` to query NetSuite (SuiteQL against `customer`). Confirm back with the user: `internalid`, `entityid`, `companyname`, `custentity_orderful_isa_id`. If the ISA ID is blank, stop — tell the user the skill requires it.

## Step 2 — Audit (read-only)

Do ALL reads before asking the user anything. The audit has two halves.

### NetSuite reads

Parent customer:
- Standard: `internalid`, `entityid`, `companyname`, `parent` (should be null — it's the root).
- `custentity_orderful_isa_id`
- `custentity_orderful_subcust_rep` (value: `stores` | `dcs` | unset)
- `custentity_orderful_shipto_use_entityid` (checkbox)

All subcustomers (SuiteQL: `SELECT ... FROM customer WHERE parent = <parent_internalid>`):
- Standard: `internalid`, `entityid`, `companyname`, primary shipping address.
- `custentity_orderful_shipto_n1_id`

All existing Enabled Transactions for this parent:
- Query `customrecord_orderful_edi_customer_trans WHERE custrecord_edi_enab_trans_customer = <parent_internalid>`.
- For each row, resolve the document type by joining to `customrecord_orderful_edi_document_type`.
- Capture: document type (human-readable), direction, linked transaction type, test mode flag, any ISA overrides.

Historical ship-to hints (to pair subcustomers):
- Query the SuiteApp's `customrecord_orderful_transaction` records for this customer, direction = inbound, document type = 850. Parse N1*ST identifiers from the stored payload or linked field. Build a de-duplicated list of seen N1 IDs.

### Orderful reads

Using the parent's ISA ID:
- Look up the partner organization in Orderful.
- List active relationships involving that partner. Each relationship names the counterparty partner and the list of enabled transaction types.
- Optionally, if ship-to inference from NS data was thin, pull recent inbound transactions from Orderful's API for this partner (last ~30 days) and extract N1*ST identifiers as a fallback.

### Audit output

Produce a concise report for the user. Include:

- Parent identification (internalid, entityId, companyname, ISA ID, whether it matched an Orderful partner).
- Current values of `custentity_orderful_subcust_rep` and `custentity_orderful_shipto_use_entityid` on the parent.
- List of subcustomers with their N1 IDs (or "unset").
- List of existing Enabled Transactions on the parent.
- List of Orderful-side enabled transaction types for this partner.
- **Gaps**: transaction types Orderful has but NS doesn't, subcustomers missing N1 IDs, `subcust_rep` unset.
- **Ship-to hints**: seen N1*ST IDs (from NS history + Orderful history), with suggested subcustomer matches where the name or entity ID contains the ID.
- **Orphans**: Enabled Transaction records in NS with no matching Orderful relationship (informational only — out of scope to delete).

## Step 3 — Decide

Prompt the user to fill the gaps, one category at a time.

### 3a. Subcustomer representation

If `custentity_orderful_subcust_rep` is unset:
- Look at subcustomer names for patterns (e.g., "DC" or "Store") and suggest a default.
- Ask: "Subcustomers look like **<stores | dcs>**. Confirm or override?"
- Only allowed values: `stores`, `dcs`. Anything else → ask again.

If already set, skip.

### 3b. Ship-to N1 IDs on subcustomers

For each subcustomer missing `custentity_orderful_shipto_n1_id`:
- If a seen N1*ST ID from the audit matches the subcustomer's name or entity ID, suggest it: "Assign N1 ID `555` to 'Northwind Store 555'? (y/n)"
- If no inference is possible, ask whether the user wants to provide one now or skip (skip is fine — SuiteApp can fall back via `custentity_orderful_shipto_use_entityid` if enabled).
- Never write automatically — always confirm.

Seen N1*ST IDs with no matching subcustomer: report but don't act. The SuiteApp will **not** auto-create a subcustomer; the inbound Sales Order will fall back to the parent customer instead. The user can manually create the subcustomer in NetSuite later if they want a subcustomer-level link, but the skill should not do it.

### 3c. Enabled Transactions

For each Orderful transaction type with no matching Enabled Transaction record:
- Resolve the correct `customrecord_orderful_edi_document_type` row.
- Ask **direction** (inbound, outbound, both). Suggest defaults: 850/875 → inbound; 855/856/810/846 → outbound.
- Ask **linked NS transaction type**. Suggest: 850/875 → Sales Order; 855 → Sales Order; 856 → Item Fulfillment; 810 → Invoice; 846 → (leave unset).
- Ask **test vs prod mode**. Default prod; flip to test if `.env`'s `ENVIRONMENT=sandbox`.
- Leave all advanced flags (`isProcessAsCustom`, consolidation, JSONata, 860 rules, 810 source) at defaults.

For each existing Enabled Transaction that **differs** from Orderful (direction mismatch, wrong linked type, wrong test-mode setting): report the diff and ask yes/no to update. If yes, update only the changed fields; don't touch anything else.

Skip orphans entirely (out of scope to delete).

## Step 4 — Configure

Before writing anything, summarize the full plan back to the user:

```
Plan:
  Parent (Northwind Retail Inc., internal 12345):
    - custentity_orderful_subcust_rep: unset → 'stores'

  Subcustomers:
    - Northwind Store 555 (internal 12346): shipto_n1_id: unset → '555'
    - Northwind Store 892 (internal 12347): shipto_n1_id: unset → '892'

  Enabled Transactions:
    - Create: 856 ASN — outbound, Item Fulfillment, prod
    - Create: 810 Invoice — outbound, Invoice, prod
    - Update: 855 PO Ack — direction: inbound → outbound

  No deletes.

Proceed? (y/n)
```

On `y`, execute writes in this order:
1. Parent fields (`custentity_orderful_subcust_rep`).
2. Subcustomer fields (`custentity_orderful_shipto_n1_id`) — one PATCH per subcustomer.
3. Enabled Transaction records — one POST per new record, one PATCH per update.

On any write error, **stop immediately**. Report which writes succeeded and which failed. Do NOT attempt rollback; the user re-runs the skill to finish.

## Step 5 — Verify

Re-read the same state as Step 2 (parent fields, subcustomer fields, Enabled Transactions for this parent). Produce a short pass/fail diff:

```
Verification:
  ✓ custentity_orderful_subcust_rep on parent = 'stores'
  ✓ shipto_n1_id on 'Northwind Store 555' = '555'
  ✓ shipto_n1_id on 'Northwind Store 892' = '892'
  ✓ Enabled Transaction 856 ASN — created (outbound, Item Fulfillment, prod)
  ✓ Enabled Transaction 810 Invoice — created (outbound, Invoice, prod)
  ✓ Enabled Transaction 855 PO Ack — direction updated to outbound

All writes verified.
```

If anything fails verification, surface which field/record and leave the user to decide: re-run the skill or inspect in the NetSuite UI.

## Troubleshooting

- **Parent has no ISA ID**: skill can't match to Orderful. Stop; ask the user to set `custentity_orderful_isa_id` on the Customer record (NetSuite UI) and re-run.
- **ISA ID doesn't resolve to an Orderful partner**: either the ID is wrong, or the Orderful API key in `.env` belongs to a different org than the partner is in. Check both.
- **Document Type FK resolution fails** — SuiteQL returns no row for "850" etc. in `customrecord_orderful_edi_document_type`: the SuiteApp install may be missing seed records. This is an install-level issue, not a skill issue. Stop and tell the user.
- **403 on Enabled Transaction create/update**: the access token's role lacks create/edit permission on `customrecord_orderful_edi_customer_trans`. Have the customer grant the role the right permissions and re-run.
- **"Parent is also a subcustomer"** edge case: if the customer the user named has a non-null `parent` field, ask whether they meant the parent instead. The skill operates on tree roots.

## Dry-run mode

If the user says "dry run" or "audit only", complete Steps 1, 2, and 3 (showing what would be written) but **skip Step 4**. Print the plan and stop. Useful for pre-change review or diffing two customers.
