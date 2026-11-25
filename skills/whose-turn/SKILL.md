---
name: whose-turn
description: Build a "whose turn is it" board for a customer's open trading partners from Orderful. For each partner it gives the stage, who holds the next step (our side, the partner, or waiting on cutover), how many days it has waited, and the evidence, so a stalled partner is caught in days instead of weeks. Read-only. Use when the user says "whose turn is it", "what's stuck for <customer>", "what am I waiting on", "which partners are stale", "who do I need to chase", "what's ours to do today", "give me a status board", "/whose-turn", or before a scrum or a weekly status update.
---

# Whose Turn Is It?

Onboarding time is mostly lost waiting, and the waiting is invisible: a test order sits unanswered, a partner never sends its test file, a trade request is never accepted, and nobody notices until someone chases. This skill reads Orderful and turns each open trading partner into one row that says who holds the next step and since when.

It does not trust the platform's task roles during testing. Orderful shows "Create test transaction" on an outbound 855, 856 or 810 as the customer's task even when no test order has arrived to answer. So for partners in testing, the holder is decided from the test traffic itself.

## When to use this skill

- "Whose turn is it on <customer>?"
- "What's stuck?" / "Which partners are stale?"
- "Who do I need to chase this week?"
- "What is ours to do today across my customers?"
- "Give me the status board for the scrum."
- Before writing a weekly customer update or a go-live forecast.

## Inputs the skill needs

- A customer slug with `~/orderful-onboarding/<slug>/.env` holding `ORDERFUL_API_KEY` (created by `netsuite-setup`). The org is read from the key, so `ORDERFUL_ORG_ID` is not needed.
- Nothing from NetSuite. It works the same for customers that do not use the SuiteApp.

## The recipe

### Step 1 — Run it

```bash
node skills/whose-turn/whose-turn.mjs <customer-slug>
node skills/whose-turn/whose-turn.mjs --all            # every customer that has a .env
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `--format=table\|md\|json\|csv` | `table` | `md` to paste into a canvas or doc, `json` or `csv` to feed a tracker |
| `--out=<file>` | none | also write the output to a file |
| `--days=<n>` | 120 | how far back to read test traffic |
| `--ours-days=<n>` | 3 | flag our side after this many quiet days |
| `--partner-days=<n>` | 5 | flag the partner after this many quiet days |
| `--cutover-days=<n>` | 14 | flag a Go-Live Ready partner waiting this long |

A customer whose key is rejected is skipped with a one-line message and the run exits with code 2; the other customers still print.

### Step 2 — Read the board

```
Acme Lighting (org 1234): 5 open partners: 2 ours (1 stale), 2 with the partner (2 to chase), 1 Go-Live Ready awaiting cutover. 3 fully live.

Flag        Partner            Stage           Held by  Waiting  Next step                                          Evidence
OURS-STALE  Northwind Supply   TEST            Ours     8 d      Send the test 856, 810 for the 850 received 11-16   850 PO4471 in; 3 test in, 1 test out in 120 d
            Contoso Retail     TEST            Ours     0 d      Fix the test 856: invalid                           tx 1000000042 sent 11-24; 3 test in, 21 test out in 120 d
CHASE       Fabrikam           TEST            Partner  46 d     Send a test 850 (or inject one ourselves)           no test document received; 0 test in, 0 test out in 120 d
CHASE       Tailspin Depot     REQUEST         Partner  92 d     Accept the trade request                            Trade request not accepted yet
CUTOVER?    Wingtip Stores     READY           Cutover  55 d     Send first live transaction                         Go-Live Ready; waiting on the customer
```

- **Held by** is one of:
  - **Ours**: our side has the next move. That means us or the customer; Orderful cannot tell the two apart.
  - **Partner**: the trading partner, its VAN, or an Orderful admin acting for a partner that has not claimed its org.
  - **Cutover**: every relationship is Go-Live Ready and the first live document has not flowed.
- **Waiting** is the number of days since the step last moved: the latest test document either way, or the date the stage was entered when there is no traffic.
- **Stage** shows the mix when relationships differ, for example `4 TEST, 2 READY`.
- Rows are sorted with ours first, then the partner's, then cutover, oldest first within each group. Live partners are counted in the headline and left out of the table.

Flags:

| Flag | Meaning | What to do |
|---|---|---|
| `OURS-STALE` | ours, and quiet for 3 days or more | do the step today, or say on the thread when it will happen |
| `CHASE` | the partner's, and quiet for 5 days or more | follow up, or remove the dependency (see Step 4) |
| `CUTOVER?` | Go-Live Ready for 14 days or more | confirm the cutover date with the customer |

### Step 3 — How the holder is decided

| Situation | Held by | Next step shown |
|---|---|---|
| No relationships yet, request waiting on the partner | Partner | Accept the trade request |
| No relationships yet, request sent back or cancelled | Ours | the platform's reason, such as "Resend trade request" |
| Request cancelled and another partnership with the same partner has relationships | hidden | counted as a cancelled request |
| Setup, pending or blocked relationships, none in test | by the platform's next task (the blocking side when blocked) | the platform's task name |
| Testing: the latest outbound test document is invalid, rejected or failed | Ours | Fix the test `<doc>` |
| Testing: a test document came in and some outbound documents have not answered it | Ours | Send the test `<docs>` for the `<doc>` received `<date>` |
| Testing: every outbound document was sent after the latest inbound one | Partner | Review the test `<docs>` sent by `<date>` |
| Testing: an inbound document is expected and none has arrived | Partner | Send a test `<doc>` (or inject one ourselves) |
| Testing: outbound documents only, nothing sent | Ours | Send the first test `<doc>` |
| Testing: inbound documents only, one received | Ours | Confirm it processed, then mark it tested |
| Every open relationship is READY | Cutover | Send first live transaction |

A relationship that lags behind the headline stage (for example an 824 still blocked while the 850 is in test) is added to the evidence as a note.

### Step 4 — Act on it

- **Ours, a test order is waiting.** Answer it without waiting for the customer to ship: `build-mock-fulfillments` for the 856, `bill-and-fire-810` for the 810, then `fetch-validations`.
- **Ours, a test document is invalid.** `fetch-validations <txId>` with the transaction id from the evidence, then `writing-outbound-jsonata` or `audit-outbound-rules`.
- **Partner, no test order has arrived.** Chase once with the date from the board. If the partner will not send one, `inject-test-transaction` or `submit-test-transaction` removes the dependency.
- **Partner, reviewing our documents.** Follow up quoting the transaction dates in the evidence.
- **Partner, trade request not accepted.** Follow up with the partner. If the partner org is unclaimed, ask an Orderful admin to accept it.
- **Cutover.** Ask the customer for a cutover date and record it as the partnership's go-live target.

Read the email or Slack thread before chasing anyone. The board sees Orderful only, so a reply that arrived by email yesterday does not show.

### Step 5 — Share it or feed a tracker

- `--format=md` produces a table for a canvas, a doc or a pull request.
- `--format=csv` or `--format=json` carries every field per partner: `partnershipId`, `stage`, `holder`, `waitingDays`, `since`, `nextStep`, `flag`, `statuses`, `docsIn`, `docsOut`, `targetDate`, `openDays`, `evidence`, `notes`.
- Run `--all --format=json --out=board.json` on a schedule to keep a tracker current without anyone typing status.

## Behaviour rules

1. **Read-only.** The script sends GET requests only. Never change a relationship status, a trade request or a checklist as part of this skill; propose that separately and get a yes.
2. **Show the evidence with the verdict.** Every row carries the reason it was classified that way. Quote it when you tell someone it is their turn.
3. **"Ours" is not blame.** It means our side holds the step. Find out whether it is us or the customer before telling the customer they are late.
4. **Do not send a chase from the board alone.** Check the thread first, then draft the follow-up for the user to send.
5. **If Orderful lags reality, say so.** When a partner is agreed as Go-Live Ready but its relationships still read TEST, report the mismatch instead of hiding the row.
6. **Never print the API key.** The script redacts it; do not echo `.env` contents or raw error bodies.

## Limits

- It sees Orderful only: not email, Slack or partner portals. Testing that runs entirely inside a portal without documents on the Orderful test stream shows as "no test document received".
- Test traffic is read for the last 120 days by default. Older documents are ignored unless you raise `--days`.
- A partner that splits documents across several ISA IDs has several partnerships and so several rows. Rows that share a partner name carry the partnership id.
- A cancelled trade request that nothing replaced shows as ours ("Resend trade request"). Decide whether it is still wanted.
- Sandbox and demo partners (organization type `test` or `demo`) are left out and counted in the headline.
- The flags are thresholds, not service levels. Tune them per team with the options above.

## Reference material

Endpoints used, all with the `orderful-api-key` header:

| Call | Used for |
|---|---|
| `GET /v3/organizations/me` | the org behind the key |
| `GET /v2/trading-partnerships` | partnerships, partner accounts, go-live target |
| `GET /v2/document-relationships?ownerId=<org>` | status, stage dates and the platform's next task per relationship |
| `GET /v2/trading-partnerships/<id>/tasks` | trade request state while a partnership has no relationships |
| `GET /v2/transactions?ownerId=<org>&partnerEdiAccountId=<id>&stream=test&withOrgId=true` | test traffic per partner |

Notes for anyone extending the script:

- `document-relationships` includes the next task by default and rejects an explicit `includeNextTask` parameter, which its own pagination link adds. Page by `offset` instead.
- `pagination.total` is the page size, not the full count. Keep reading while a page comes back full.
- A 401 or 403 body repeats the API key. Never print it.

Tests for the classification rules: `node --test skills/whose-turn/whose-turn.test.mjs`.
