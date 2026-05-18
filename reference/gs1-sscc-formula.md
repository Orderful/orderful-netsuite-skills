# GS1 SSCC18 Formula for NetSuite Analytics Datasets

Reference for emitting Mod-10-valid GS1-128 SSCC barcodes from a NetSuite Analytics Dataset (NSAD) — typically used with the Orderful SuiteApp's pkg-data-source feature to satisfy partner-spec requirements on outbound 856 Advance Ship Notices.

## What an SSCC18 looks like on the wire

Trading partners that mandate SSCCs (Ace Hardware, Walmart, Target, etc.) expect a 20-character all-numeric string at `marksAndNumbersInformation.marksAndNumbers` with `marksAndNumbersQualifier="GM"`:

```
 ┌─ 2-char EDI padding   (always "00")
 │ ┌─ 1-digit extension       (issuer chooses; typically "0" or "1")
 │ │ ┌─ 7- to 10-digit GS1 Company Prefix  (registered to the brand owner)
 │ │ │           ┌─ Serial Reference (fills out the remaining digits)
 │ │ │           │       ┌─ 1-digit Mod-10 check
 │ │ │           │       │
 0 0 0 PPPPPPPPPP NNNNNN C
 └────────────── 20 chars ──────────────┘
                └────── 18-digit SSCC18 ──────┘
                  └── 17-digit base ──┘
```

The 18-digit body always sums to 18 digits regardless of the prefix length — a longer prefix means a shorter serial, and vice versa. With a 10-digit prefix you get a 6-digit serial reference; with a 7-digit prefix you get a 9-digit serial.

## Mod-10 check digit algorithm (GS1 standard)

Per GS1 General Specifications: starting from the rightmost digit of the 17-digit base, multiply each digit alternately by `3` and `1` (rightmost = ×3), sum all products, and the check digit is `(10 - sum mod 10) mod 10`.

For a 17-digit base where character index 1 is the leftmost (1-based, like Oracle's `SUBSTR`):
- Position from right = `18 - i`
- Multiplier = `3` if `(18 - i)` is odd, else `1`
- Since `18` is even, `(18 - i)` is odd ⇔ `i` is odd → **odd 1-based positions ×3, even ×1**

In a worked example: base `61414100000000001` (the [GS1 reference example](https://www.gs1.org/services/check-digit-calculator)) →
- Position 1 (`6`) ×3 = 18, position 2 (`1`) ×1 = 1, position 3 (`4`) ×3 = 12, ... → sum = 48
- Check digit = `(10 - 48 mod 10) mod 10 = 2`
- Full SSCC18 = `614141000000000012`; padded to 20 chars = `00614141000000000012`

## NSAD formula columns: the constraints

The Orderful SuiteApp's pkg-data-source reads a column labeled exactly `"SSCC"` from the dataset (along with `Carton`, `IsPallet`, `Parent`, etc. — see the carton model in the SuiteApp source for the full label list). To populate that column in NSAD you write a formula. Two constraints to remember:

1. **NSAD formula columns can't reference other formula columns.** You can't define an intermediate `Base17` formula and reference `{Base17}` from a downstream `CheckDigit` formula. The SSCC has to be expressed inline in the single `SSCC` column.
2. **No subqueries.** Constructs like `(SELECT ... FROM dual CONNECT BY LEVEL <= 17)` aren't supported in formula columns — at least in the NSAD versions current in 2026.

So the formula has to inline-iterate over the digits of the variable serial portion. With 17 SUBSTR calls (one per digit of the base), this gets unwieldy. The optimization below cuts that to 6.

## The optimization: precompute the fixed-prefix weighted sum

The 11 leftmost characters of the base (1 extension + 10 prefix, or however the prefix is sized) are constant across every row in the dataset. Their contribution to the Mod-10 weighted sum is a constant. Compute it once, hardcode it, and only iterate over the variable serial digits.

For a 17-digit base = ext (1) + prefix (10) + serial (6):
- Positions 1–11 are fixed (ext + prefix). Their weighted-sum contribution = `K`.
- Positions 12–17 are the variable serial (6 digits). Multipliers from left within the serial: `1, 3, 1, 3, 1, 3` (pos 12 even → ×1, pos 13 odd → ×3, ...).

The total weighted sum is `K + (variable contribution)`, and the check digit is `(10 - (K + var) mod 10) mod 10`.

### Computing the constant K for any prefix

JavaScript reference (run once when picking up a new customer):

```javascript
function fixedPrefixSum(extDigit, prefix) {
  // base17 starts with ext + prefix; iterate positions 1..(1 + prefix.length).
  const fixed = String(extDigit) + prefix;
  let sum = 0;
  for (let i = 1; i <= fixed.length; i++) {
    const d = parseInt(fixed[i - 1]);
    const mult = (i % 2 === 1) ? 3 : 1;  // odd 1-based position ×3, even ×1
    sum += d * mult;
  }
  return sum;
}

// Example: ext='0', prefix='1234567890' (the example values used below)
fixedPrefixSum('0', '1234567890');  // → 85
fixedPrefixSum('1', '1234567890');  // → 88  (extension digit '1' adds 3 over '0')
```

## The formula (for a 10-digit GS1 Company Prefix)

Substitute your customer's prefix in `<PREFIX>` and the precomputed constant in `<K>`. The example uses placeholder `<PREFIX>=1234567890` (use the customer's actual GS1 Company Prefix; look it up in the [GS1 GEPIR registry](https://gepir.gs1.org/) by company name) and `<K>=85` (for ext digit `0`); for a Tare-row variant with ext digit `1`, swap to `<EXT>=1` and `<K>=88`.

```sql
'00' || '<EXT>' || '<PREFIX>' || LPAD(TO_CHAR({transactionlines.inventoryassignment.id}), 6, '0') || TO_CHAR(MOD(10 - MOD(<K> +
  TO_NUMBER(SUBSTR(LPAD(TO_CHAR({transactionlines.inventoryassignment.id}), 6, '0'), 1, 1)) * 1 +
  TO_NUMBER(SUBSTR(LPAD(TO_CHAR({transactionlines.inventoryassignment.id}), 6, '0'), 2, 1)) * 3 +
  TO_NUMBER(SUBSTR(LPAD(TO_CHAR({transactionlines.inventoryassignment.id}), 6, '0'), 3, 1)) * 1 +
  TO_NUMBER(SUBSTR(LPAD(TO_CHAR({transactionlines.inventoryassignment.id}), 6, '0'), 4, 1)) * 3 +
  TO_NUMBER(SUBSTR(LPAD(TO_CHAR({transactionlines.inventoryassignment.id}), 6, '0'), 5, 1)) * 1 +
  TO_NUMBER(SUBSTR(LPAD(TO_CHAR({transactionlines.inventoryassignment.id}), 6, '0'), 6, 1)) * 3
, 10), 10))
```

Six `SUBSTR + TO_NUMBER` calls instead of seventeen.

## NSAD column reference syntax

When the dataset is rooted on `transaction` (the standard shape — root transaction, joined down through `transactionlines` to `inventoryassignment` and `inventorynumber`):

| Use case | Reference |
|---|---|
| Pack-row serial seed (one row per inventory assignment / lot) | `{transactionlines.inventoryassignment.id}` |
| Tare-row serial seed (one row per IF / parent transaction) | `{id}` (the root transaction's id) |
| Per-line column (e.g., line item id) | `{transactionlines.id}` or `{transactionlines.item}` |

If your dataset is rooted differently, walk the column picker in the NSAD UI to find the right path; the syntax follows the join chain literally.

## Pack-vs-Tare namespacing via the extension digit

Most 856-mandating partners require both Pack-level (HL P) and Tare-level (HL T) SSCCs in the message. To keep the two row types in distinct serial namespaces (so a Pack SSCC and a Tare SSCC can never collide for a given customer), use the extension digit slot:

- **Pack rows**: ext digit `0`, serial = `LPAD(inventoryassignment.id, 6, '0')`. Constant `K = fixedPrefixSum('0', prefix)`.
- **Tare rows**: ext digit `1`, serial = `LPAD(transaction.id, 6, '0')`. Constant `K = fixedPrefixSum('1', prefix)`.

Same prefix; different extension digit; different serial source. The extension digit is the issuer's freely-assignable namespace per GS1 spec, so this isn't violating anything.

## Handling the Tare row when no native pallet record exists

Most NetSuite installations don't have a record that natively models a pallet/Tare per Item Fulfillment. Two ways to satisfy partner specs that mandate HL T:

1. **Dataset-emit a Tare row per IF**. Modify the dataset criteria to include the body row of each Item Fulfillment (`Transaction Line: Main Line is true`) in addition to the existing IA-bearing rows. Then conditionally compute the SSCC in a single `CASE WHEN {transactionlines.mainline} = 'T' THEN <Tare formula> ELSE <Pack formula> END` column. **Caveat for ItemFulfillment specifically**: NS does not synthesize a separate body row on IF records — `mainline=T` lands on the first item line. So the trick that works for SO/PO doesn't cleanly produce a separate Tare row on IF. Workaround: have the SuiteApp emit a body-level pallet column from a separate per-IF custom field; recent SuiteApp versions support this directly.
2. **Inject the Tare HL in JSONata**. After the SuiteApp emits Pack rows from the dataset, JSONata wraps them with one Tare HL per IF whose SSCC is computed from `itemFulfillments[0].id` using the same Mod-10 formula (with ext digit `1`). The GS1 prefix becomes a partner-spec constant in the JSONata, in the same category as `"BM"` / `"CB"` / `"SA"` (it's a customer identifier, not a per-record data mock — see the no-hardcoded-mocks rule in [`writing-outbound-jsonata`](../skills/writing-outbound-jsonata/SKILL.md)).

Option 1 is cleaner when the SuiteApp version supports it; option 2 is the fallback when it doesn't.

## Limits and when to graduate to a custom record

The formula above generates SSCCs deterministically from `inventoryassignment.id` (or `transaction.id`). That's fine for testing and small-scale prod, but has two limitations:

1. **Serial range cap.** A 6-digit serial caps at 999,999. Sandbox IA / IF ids are typically far below this; mature prod accounts can exceed it. Once an id crosses the cap, `LPAD(id, 6, '0')` truncates silently (Oracle returns the original string, not zero-padded — but the resulting base will be longer than 17 digits, breaking the formula). Solution: use a longer serial, which means using a shorter GS1 prefix slot (e.g., 7-digit prefix, 9-digit serial = 999,999,999 max). GS1 issues prefixes of various lengths — pick one sized for your customer's expected lifetime SSCC volume.

2. **Recomputes on every dataset query.** SSCCs derived from `inventoryassignment.id` produce the same value every time the dataset is queried for that IA. That's fine for re-firing the same 856 idempotently, but it means a cancelled-and-reshipped IF (with new IAs) will get *new* SSCCs — the originally-issued SSCC is not reused, but is also not retired. GS1 best practice is to issue each SSCC once and never reuse it; a formula-derived approach satisfies the "never reuse" property but doesn't track issued-ness explicitly.

When either of these become real concerns (production-grade SSCC issuance for high-volume customers), graduate to a custom-record-based issuance counter:

- Define `customrecord_<customer>_sscc` with autonumber on the `name` field (so each new record gets a globally-unique sequential number).
- On IF Save, a User Event script creates one carton record per pack and one tare record per IF, each with a freshly-issued SSCC pulled from the autonumber'd custom record.
- The dataset reads SSCCs from the carton/tare records instead of computing them from formulas.

This shifts the failure mode from "silently truncated when ids exceed the serial range" to "explicit autonumber sequence with no cap", and makes issued-ness queryable.

## Validation

After deploying the formula, sample 5–10 rows from the dataset and verify:

```javascript
function ssccCheck(base17) {
  let sum = 0;
  for (let i = 1; i <= 17; i++) {
    sum += parseInt(base17[i - 1]) * (i % 2 === 1 ? 3 : 1);
  }
  return (10 - sum % 10) % 10;
}
function isValidSscc20(sscc) {
  if (sscc.length !== 20) return false;
  if (!/^[0-9]+$/.test(sscc)) return false;
  if (!sscc.startsWith('00')) return false;
  const base17 = sscc.slice(2, 19);
  const claimed = parseInt(sscc[19]);
  return ssccCheck(base17) === claimed;
}
```

Partners with strict implementations check the Mod-10 digit; partners with looser implementations only check length + numeric. Either way, computing it correctly costs nothing and prevents a silent rejection class.

## Reference material

- [`writing-outbound-jsonata`](../skills/writing-outbound-jsonata/SKILL.md) — covers the no-hardcoded-mocks rule (item 12 in Behaviour rules) and the lambda-body / path-update / formula-column gotchas
- [`alternative-packing-source`](../skills/alternative-packing-source/SKILL.md) — covers the dataset → SuiteApp wiring (the column contract the SuiteApp expects, validation flow, SDF roundtrip)
- [GS1 General Specifications](https://www.gs1.org/standards/barcodes/gs1-general-specifications) — the SSCC18 spec source of truth (free download from GS1)
- [GS1 Check Digit Calculator](https://www.gs1.org/services/check-digit-calculator) — verify the Mod-10 algorithm against any sample SSCC
