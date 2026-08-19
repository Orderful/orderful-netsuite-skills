# Lot costing & the async inventory costing engine

Reference doc for how NetSuite actually costs lot-numbered ("Lot Numbered" / specific
lot costing) inventory, and how to observe it without being lied to. Every claim below
was proven by create → readback → post-settle re-read round-trips across two
independent test benches (a lot-return flow and a dedicated settle sentinel).

> **Provenance & scope:** observed on a **v25.1 Test Drive account** (`TDxxxxxxx`).
> The engine's **cadence is account-specific** (this account ran exactly one costing
> pass ~3 minutes after transaction creation, then nothing across a 20-hour watch —
> accounts with deep costing queues or period-end revaluations can differ). The
> **end-states are semantic** — which cost a transaction settles at is engine logic,
> not timing — so treat the values as portable and the timing as illustrative.

## 1. The provisional-GL trap: never conclude costing from immediate GL

With delayed costing (`INV_COSTING_DELAYED_START` accounting preference true), the GL
amounts written at save time are **provisional**, and the async costing engine silently
**restates them in place** (same `transactionaccountingline` rows, amounts rewritten —
in the extreme case to NULL/zero).

- The provisional layer is **average cost for every non-overridden inventory posting —
  issues included**. A fulfillment of a $10-lot booked at the item's $13.33 average
  immediately, then was rewritten to lot cost by the engine pass minutes later.
- This is invisible if average cost happens to equal the relevant lot cost — diverge
  them (e.g. bring in a decoy lot at a different cost) before trusting any observation.
- Observed settle outcomes for **lot-costed** items:
  - Issues / fulfillments / transfers → rewritten to the **source lot's cost**.
  - Customer-return receipts into the **same original lot** → the lot's own cost
    (original cost preserved; no blending — the lot's unit cost is stable through
    sell/return cycles).
  - Customer-return receipts into a **NEW lot** with no cost control → restated to
    **$0.00** (not average — zero-value inventory and a $0 COGS reversal). Linked-to-
    invoice vs standalone RA makes no difference. The interim average-cost posting is
    restated away.

**Verification rule:** any costing claim needs (a) an immediate read AND (b) a
post-settle re-read, with the pass-detection instruments below proving whether the
engine ran between them.

## 2. `unitcostoverride` on item receipts: dynamic-mode-only, and engine-EXEMPT

The receipt line field `unitcostoverride` (the UI's "Override Rate" for returns) is the
working cost control for return receipts — with two sharp edges:

- **Dynamic mode only.** `record.transform(..., {isDynamic: true})` +
  `setCurrentSublistValue` persists it and it drives the GL. In **standard mode the
  identical write silently reverts** (green save, field empty on readback, GL at
  average). REST record API can't reach it at all.
- **Override receipts are exempt from the costing engine, not merely tolerated by
  it.** The engine's pass skips them entirely (no engine systemnotes, no GL-line
  touches — ever). The override value is **final from the moment of creation**. This
  held for receipts created both before and after an engine pass, linked and
  standalone alike.
- Related dead ends, verified: the `RETURNCOSTDEFAULT` accounting preference's full
  enum is `{LOCALAVG, GLOBALAVG}` — both averages, no "original cost" option (the
  docs' exact-cost mode is a NetSuite-Support-activated switch, not self-service);
  the item-level "Default Return Cost" field from the docs did not exist on this
  account's item records (writes silently revert).

## 3. Lot costing's dual representation: FIFO on write, LOT on read

On a lot-numbered item, the account offers exactly two costing methods — `AVG`
("Average") and one **displayed as "Lot Numbered" whose stored select value is
`FIFO`**. Once saved:

| Surface | Value |
|---|---|
| SuiteScript select option / REST write | `FIFO` (display text "Lot Numbered") |
| SuiteQL `item.costingmethod` readback | `LOT` |
| REST record readback | `FIFO` |
| REST metadata catalog enum | lists `LOT` — **rejected live** ("Invalid Field Value LOT") |

Write `costingMethod: {id: "FIFO"}`; treat `LOT` in SuiteQL results and `FIFO` in REST
results as the same stored fact; never trust the metadata catalog's enum for this field.

## 4. Observation instruments (the ones that actually work)

- **Per-lot on-hand:** `inventorybalance` — grain is item × location × status × lot via
  its `inventorynumber` column (`quantityonhand`, `quantityavailable`). The
  `inventorynumber` record itself has **no quantity or cost columns**. (Caveat from
  elsewhere: `inventorybalance.quantityavailable` is per-status availability, not
  onhand−committed — use `aggregateitemlocation` for allocation-aware available.)
- **Per-lot valuation:** not exposed directly. When each transaction touches exactly
  one lot, lot value = sum of that lot's transactions' inventory-account GL deltas —
  design test benches single-lot-per-transaction to keep this computable.
- **Engine-pass detection (per transaction):**
  - `transactionaccountingline.lastmodifieddate` — per-GL-line, with time of day. A
    line modified after creation time = the engine touched it.
  - `systemnote` with `recordtypeid < 0` (transactions) and **`context IS NULL`** —
    engine rewrites stamp null-context notes on `TRANLINE.RUNITPRICE` / `MAMOUNT` /
    `DEBIT` / `CREDIT` / `TRANDOC.IMPACT`; your own API writes stamp a real context
    (e.g. `RST` for RESTlets). Filter `recordid IN (...)` and include the `record`
    label column to guard against cross-type id collisions.
  - Two agreeing reads are conclusive only if these instruments show a pass fired
    between them (or the values already match the engine-final state).
- **Record-API blind spot:** custom fields on `inventorynumber` records are writable
  via `record.load` + `setValue`, but `getFields()`/`getValue()` do **not** surface
  them — verify via SuiteQL, where they appear as columns in both query engines.
