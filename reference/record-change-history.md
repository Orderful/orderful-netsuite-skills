# Record change history — reading NetSuite System Notes via SuiteQL

How to answer "what changed on this record, when, and from what value?" over REST/SuiteQL only, with no NetSuite UI. This is the table behind the **System Notes** tab on a record.

Validated 2026-09-11 against a live production account while auditing the blast radius of a bulk transaction write.

> **Not the same thing as the execution log.** `systemnote` = *record* change history (a field went from X to Y). `scriptnote` = *script* execution log (what a script logged while it ran). If you want "did the Map/Reduce run and what did it print", you want `scriptnote` — see [`mapreduce-monitoring.md`](mapreduce-monitoring.md). If you want "did this order's total change", you want `systemnote`.

## TL;DR — the one gotcha that matters

**Always put `recordtypeid` in the predicate.** Without it the query hangs and times out, even when the rest of the filter looks highly selective.

```sql
-- times out (recordid alone is not enough)
SELECT * FROM systemnote WHERE recordid = 1234567

-- times out (date alone is not enough)
SELECT * FROM systemnote WHERE date > SYSDATE - 1

-- returns instantly
SELECT * FROM systemnote WHERE recordtypeid = -30 AND recordid = 1234567
```

`systemnote` is one of the largest tables in any NetSuite account. `recordtypeid` is what lets it use its index; the other columns on their own do not. Several 120s+ queries died before this was spotted — assume a hang means a missing `recordtypeid`, not a broken query.

`recordtypeid = -30` is **transactions** (verified). Other record types have their own ids; discover one by probing a record you know changed recently, rather than guessing.

## Column contract

| Column | Notes |
|---|---|
| `id` | Row id. Use with `date` for stable ordering — rows within one save share a timestamp to the second. |
| `recordtypeid` | **Required in every predicate.** `-30` = transaction. |
| `recordid` | Internal id of the record that changed. |
| `field` | What changed. See naming below. |
| `oldvalue` | Prior value, as display text. `NULL` on record creation. |
| `newvalue` | New value, as display text. |
| `date` | Change timestamp. Wrap in `TO_CHAR(date,'YYYY-MM-DD HH24:MI:SS')` — the bare column renders date-only. |
| `name` | Who made the change. |
| `type` | Change type code (`1` create, `2` set-on-create, `4` edit). |

Values are stored as **rendered text**, not ids — a List/Record field shows `Wholesale : Retail : Northwind Retail Inc.`, not `4`. Good for reading, useless for joining.

**Aggregates fail.** `GROUP BY` / `COUNT(*)` over `systemnote` returns HTTP 500 `UNEXPECTED_ERROR`, regardless of how tight the filter is. Pull the rows and aggregate client-side.

## Field naming

| Prefix | Meaning | Example |
|---|---|---|
| `TRANDOC.<COL>` | Transaction **header** field | `TRANDOC.MAMOUNTMAIN` |
| `TRANLINE.<COL>` | Transaction **line** field | `TRANLINE.MCOSTESTIMATE` |
| `CUSTBODY_*` | Custom body field, by script id | `CUSTBODY_ORDERFUL_READY_TO_PROCESS_ACK` |
| `CUSTCOL_*` | Custom column field, by script id | `CUSTCOL_ORDERFUL_STORE_NUMBER` |

Custom fields appear under their own script id with no `TRANDOC.`/`TRANLINE.` prefix, so a custom-field filter is just the script id uppercased.

Worth knowing by name:

| Field | What it tells you |
|---|---|
| `TRANDOC.MAMOUNTMAIN` | **Order total.** The single best "did the value really change" signal. |
| `TRANDOC.KSTATUS` | Status transitions (`Pending Approval` → `Cancelled`). |
| `TRANDOC.KLOCATION` | Header location — often stamped by a save side-effect. |
| `TRANDOC.SDOCNUM` | Document number assignment at creation. |
| `TRANLINE.MCOSTESTIMATE` | Line estimated cost — recalculated on save. |
| `TRANLINE.RQTYSHIPRECV` / `RQTYPICKED` / `RQTYPACKED` | Emitted as a triplet per line. |

## Canonical queries

**Full history for one record**

```sql
SELECT id, TO_CHAR(date,'YYYY-MM-DD HH24:MI:SS') AS ts, name, type, field, oldvalue, newvalue
FROM systemnote
WHERE recordtypeid = -30 AND recordid = 1234567
ORDER BY date, id
```

**Did the total change, across a batch of records**

```sql
SELECT recordid, TO_CHAR(date,'YYYY-MM-DD HH24:MI:SS') AS ts, oldvalue, newvalue
FROM systemnote
WHERE recordtypeid = -30
  AND recordid IN (1234567, 1234568, 1234569)
  AND field = 'TRANDOC.MAMOUNTMAIN'
ORDER BY recordid, date
```

An `IN` list of ~90 ids returns in a couple of seconds. Every record gets one row at creation (`oldvalue` NULL); anything beyond that is a genuine revision.

## Limits — state these plainly before relying on the data

- **Line rows do not say *which* line.** There is no line-number or line-id column. You can count line events and read old/new values, but you cannot attribute them to line 3 versus line 7. Correlate by value, or not at all.
- **Line deletions are not audited.** A removed sublist line leaves no `systemnote` row of any kind. Absence of evidence here is genuinely not evidence of absence — diff `transactionline` against a snapshot instead.
- **Creation is a burst.** Record creation emits dozens of rows in the same 1–2 seconds, all with `oldvalue` NULL. The number of `TRANLINE.RQTYSHIPRECV` rows in that burst is **how many lines the record was created with** — which is how you prove that extra lines appeared later rather than at creation.

## Practical use: verifying blast radius after a bulk write

Any REST write to a transaction fires User Events, which routinely touch far more than the field you set. After a bulk run, `systemnote` is how you separate real damage from save-side-effect noise:

1. Query `TRANDOC.MAMOUNTMAIN` across every record you touched, filtered to the run's date.
2. **Zero rows dated during the run = no value moved.** That is the signal that matters.
3. Expect, and ignore, derived churn: location stamping onto header and lines, previously-unset checkbox custom fields defaulting to `F`, `TRANLINE.MCOSTESTIMATE` recalculating. On non-posting records like Sales Orders none of this touches the GL.

Sales Orders are not posting transactions, so a changed **total** is the alarm — not the volume of audit rows a save produces.

## Reference material

- [`mapreduce-monitoring.md`](mapreduce-monitoring.md) — `scriptnote` and the script execution log
- [`record-types.md`](record-types.md) — Orderful SuiteApp custom records
