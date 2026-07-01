# Orderful Rules Engine (`/v2/rules`)

Orderful's per-relationship transformation **rules** (`/v2/rules`) apply path-level expressions to a transaction at (re)processing time — a platform-side alternative to SuiteApp JSONata for shaping an outbound message to a partner's spec. Rules are scoped to a document relationship (owner org × partner × transaction type × direction) and are what the Orderful UI "Rules Editor" writes.

> **Rules vs SuiteApp JSONata.** JSONata runs inside the NetSuite SuiteApp (on the ECT record). Rules run on the Orderful platform (per relationship). Both can correct outbound mappings. Rules are handy when you don't want to touch NetSuite, or when the customer's NS token can't reach the SuiteApp records — but they live outside NetSuite, so document them (e.g. in the customer's onboarding notes) or they're invisible to the next person reading the SuiteApp config. For strict partners, also see the `audit-rules` skill: rules can *silently strip* segments.

## REST contract

| Action | Call |
|---|---|
| List | `GET /v2/rules?relationshipId=<id>` (or `?ownerId=&transactionTypeId=&direction=`) |
| Functions | `GET /v2/rules/functions` — lists the ~48 built-in functions with ids + argument specs |
| Create | `POST /v2/rules` — body is an **ARRAY** of rule objects |
| Delete | `DELETE /v2/rules/<id>` |

Auth: the public `orderful-api-key` header works for both read and write.

Create body — note the **stringified** expressions:

```json
[{
  "ownerId": <orgId>,
  "relationshipId": <relId>,
  "transactionTypeId": <internalTxTypeId>,
  "direction": "out",
  "path": "transactionSets.*.beginningSegmentForInventoryInquiryAdvice.*.reportTypeCode",
  "liveExpression": "{\"type\":\"Function\",\"value\":{\"id\":43,\"arguments\":[{\"type\":\"String\",\"value\":\"MM\"}]}}",
  "testExpression": "<same stringified expression>",
  "source": "MANUAL"
}]
```

- `liveExpression` / `testExpression` must be **JSON strings** (stringified), not nested objects — a raw object returns `400 … must be a json string`. (On `GET`, the API returns them as parsed objects — asymmetric.)
- **One rule per path per relationship.** POSTing a second rule on an existing path returns `400 A rule already exists on path …`. There's no update-in-place — to change a rule, **DELETE the old id, then POST** the new one.
- `transactionTypeId` is Orderful's **internal** type id, NOT the X12 number. Seen: `850`=15, `810`=12, `856`=17, `870`=25, `846`=67. (Read it off an existing rule or relationship rather than guessing.)

## Expression shape

Every expression is a node: `{"type":"Function","value":{"id":<fnId>,"arguments":[<node>,…]}}`. Argument nodes are typed: `{"type":"String"|"Number"|"Reference"|"Function","value":…}`. A `Reference` value is an Orderful path (same dotted `transactionSets.*.…` form as the rule `path`).

Common function ids (confirm against `GET /v2/rules/functions`):

| id | name | notes |
|----|------|-------|
| 43 | set | set a constant / referenced value |
| 38 | if | `if(test, pass, fail?)`; common guard `if(exists(x), <value>)` — `fail` omitted = leave unchanged |
| 31 | exists | true if the path exists / is non-empty |
| 2 | substring | `substring(text, from, to)` — 0-indexed, `to` exclusive |
| 4 | replace | `replace(text, from, to)` |
| 5 | concatenate | join all provided strings |
| 15 | formatDate | `formatDate(text, oldFormat, newFormat)` — **moment tokens** |
| 57 | delete | delete the element/loop/segment at the path (no args) |

## Gotchas (each cost real debugging time)

1. **`formatDate` uses moment.js tokens.** `MM` = **month**, `mm` = **minutes**, `ss` = seconds, `HH` = 24-hour hour. `"HHMM"` for a time is WRONG — it parses the minutes as a month, so it fails whenever minutes > 12, and only *appears* to work when minutes ≤ 12 (e.g. "05" is a valid month). Use lowercase `mm`/`ss`. Also, `formatDate` does not reliably pad missing seconds — to turn a 4-digit `HHmm` into a 6-digit `HHMMSS`, `concatenate(time, "00")` is more dependable than `formatDate`.
2. **Do NOT nest a function as another function's argument.** `formatDate(substring(x,0,4), …)` or `concatenate(substring(x,0,4), "00")` makes the **outer** function a no-op — it returns the inner result unchanged. Every built-in rule passes a `Reference` or literal as the value arg, not a nested function. Design each rule so a single function does the job (e.g. if the source field is already clean, drop the `substring`).
3. **Rules apply at (re)processing time; the message endpoint shows the last-processed state.** Creating/changing a rule via the API does **not** retroactively re-validate an already-processed transaction. It re-applies on the next generation, a reprocess, or when the transaction is reopened in the Orderful UI. So `GET /v3/transactions/<id>/message` reflects the *last* transform — **a freshly generated transaction is the reliable test**, not an old one.
4. **Validation status lags the message.** After a rule change the transformed message can update while the stored `validationStatus` still shows the prior error, until the transaction is actually re-validated. Verify on a fresh transaction, not a cached status.
5. **`delete` (id 57) works on nested loops**, e.g. `transactionSets.*.LIN_loop.*.QTY_loop.*.SCH_loop` with `delete()` drops that loop on every line item.

## Worked example

See [`aafes-dsco.md`](aafes-dsco.md) → "AAFES DSCO 846 rule set" for a full 9-rule set (set-constant, `concatenate` time pad, item-id qualifier remaps, `delete` of a segment and a nested loop) that takes the SuiteApp's default 846 output to a partner-valid message.
