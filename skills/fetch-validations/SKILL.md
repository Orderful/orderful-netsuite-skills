---
name: fetch-validations
description: Fetch structured per-transaction validation errors from Orderful (`dataPath`, `message`, `allowedValues`) instead of screenshotting the UI. Use when iterating on a partner-spec JSONata fix and a transaction is showing INVALID on Orderful, or when the user says "fetch validations", "what's wrong with that transaction", "/fetch-validations", "give me the errors for <txId>", "why is this 856/810/855 invalid", or asks to debug a partner-spec rejection without manual screenshots.
---

# Fetch Orderful Validation Errors

The Orderful UI exposes structured per-transaction validation errors via an internal API endpoint:

```
GET https://api.orderful.com/v2/organizations/{orgId}/transactions/{txId}/validations
```

Despite living under the UI's `/v2/` namespace, the endpoint accepts the plain public API key — `orderful-api-key: <key>` — no UI session needed (verified in production mid-2026, on X12 and EDIFACT transactions alike). A UI session JWT also works and remains the fallback for orgs where you don't hold an API key. This skill queries that endpoint to get a clean, machine-readable list of every validation issue on a transaction, replacing the click-around-the-rules-editor-and-screenshot-each-error workflow with a single command.

The response shape is:

```json
[
  {
    "dataPath": "transactionSets.0.currency.0.entityIdentifierCode",
    "dataPathDescription": "Code identifying an organizational entity, ...",
    "message": "\"SE\" is not a valid input",
    "allowedValues": [{ "value": "BY", "description": "Buying Party (Purchaser)" }],
    "grouping": "1-1-1",
    "validationErrorType": "codes"
  },
  ...
]
```

Loop iterations of the same error pattern are de-duplicated (so 6 copies of "productServiceIDQualifier UP invalid" across 6 IT1 lines become one entry with a count).

## When to use this skill

- "fetch validations for 909268655"
- "what's wrong with the latest 810?"
- "/fetch-validations 909223256 909223273"
- "the Sally 856 is INVALID — pull the errors"
- "I redeployed the JSONata, did the fixes land?"
- Any iteration cycle on partner-spec JSONata where you'd otherwise be screenshotting the Orderful UI

## Inputs the skill needs

- **One or more Orderful transaction IDs** — the numeric ID Orderful assigns (e.g. `909268655`), visible in the UI URL (`https://ui.orderful.com/transactions/{id}`) and on the NS Orderful Transaction record under `custrecord_ord_tran_orderful_id`.
- **The org's Orderful API key** — via `ORDERFUL_API_KEY` env var or a per-customer `.env` at `~/orderful-onboarding/<slug>/.env`. This is the primary auth path.
- *(Fallback)* **A UI session JWT** — only needed when you don't hold an API key for the org. Captured from a HAR export or pasted as `ORDERFUL_UI_JWT` (details in Step 1).

The customer slug is *not* required — validations are scoped per organization, not per customer's NetSuite. The script defaults to `~/orderful-onboarding/<slug>/.env` to find an `ORG_ID` if one is configured there, but can also be set inline.

## The recipe

### Step 1 — Resolve auth

**Primary: the org's API key.** Set `ORDERFUL_API_KEY`, or have it in the customer `.env` (the script picks up the most recently modified one under `~/orderful-onboarding/*/.env`). It's sent as the `orderful-api-key` header. No capture step, no expiry.

**Fallback: a UI session JWT** (one-time per ~24 hours) — for orgs where you don't hold an API key. The simplest way to capture one:

1. Log into `https://ui.orderful.com` in Chrome.
2. Open any transaction (e.g. one of the failing ones you want to debug).
3. Open DevTools (`Cmd+Opt+I`), go to the **Network** tab, click **Fetch/XHR**.
4. Click into the transaction's **Errors** tab — this fires a `validations` request.
5. Right-click anywhere in the Network panel → **Save all as HAR with content** → save to `~/Desktop/ui.orderful.com.har` (or wherever).

Alternatively, copy the `Authorization: Bearer ...` header value out of any single API call and set it as `ORDERFUL_UI_JWT` in your environment.

JWT lifetime is roughly 24 hours. When it expires, recapture.

### Step 2 — Run the script

```sh
node <path-to-this-skill>/fetch-validations.mjs <txId> [<txId>...]
```

Auth order of precedence:
1. `ORDERFUL_API_KEY` env var, or the most recent customer `.env` under `~/orderful-onboarding/*/.env` — sent as `orderful-api-key`
2. `ORDERFUL_UI_JWT` env var — sent as `Authorization: Bearer`
3. Most recent HAR file at `~/Desktop/ui.orderful.com.har` (Bearer token extracted automatically)

If the API key gets a 401/403 (e.g. it belongs to a different org than the transaction), the script automatically retries with the JWT when one is available.

The script also auto-detects the organization ID from a customer `.env` file (`ORDERFUL_ORG_ID` env var), or falls back to a flag (`--org=<id>`).

### Step 3 — Read the deduplicated output

The script groups identical errors that fire across loop iterations. For example, if every one of 6 IT1 lines fires the same `productServiceIDQualifier "UP" is not a valid input` error, you see one entry with `(6x)` instead of six near-identical lines.

Each error includes:
- `dataPath` — the JSON path in the emitted message that's failing
- `message` — what's wrong
- `dataPathDescription` — the X12 element's purpose
- `allowedValues` — codes the validator accepts (when applicable)

### Step 4 — Use the errors to drive the next JSONata iteration

The deduplicated structured output makes it straightforward to:
- Identify which segments need transforms (`dataPath` shows the exact path)
- Pick correct values (`allowedValues` enumerates acceptable codes)
- Confirm fixes landed (re-run after re-firing — errors should disappear)

## Related /v3 gotchas

You'll often pair this skill with the public `/v3` transaction endpoints while iterating. Two traps:

- **`GET /v3/transactions` rejects a `limit` query param** — 400 `"property limit should not exist"`. Drop it and page instead.
- **The `message` field on a `/v3` transaction object is an href, not the payload.** Fetch the actual payload from `GET /v3/transactions/{id}/message`.

## Behaviour rules

1. **Do not commit the API key or JWT to the repo or paste them in chat.** Treat them like session cookies. Keep them in env vars / local `.env` files; never check them in.
2. **Auth is per-organization.** The API key must belong to the org that owns the transaction (the `{orgId}` in the URL). Likewise, a JWT captured from one user's UI session won't fetch validations for another organization unless that user has access; the `X-ActingOrgId` header is set from the JWT context.
3. **The plain API key works for both `/v3/transactions` listing AND `/v2/.../validations`.** Earlier versions of this skill claimed validations required the UI JWT — that's wrong (verified in production mid-2026). Reach for the JWT only when no org API key is available.
4. **If the API returns 401/403 on /validations**, the API key belongs to a different org than the transaction, or the fallback JWT has expired. Check the key/org pairing first; recapture the JWT if that's what you're relying on (Step 1).
5. **If the API returns an empty array**, the transaction has no validation errors — i.e., it is `validationStatus: VALID`. Treat this as success.
6. **The endpoint is undocumented and could change.** If the response shape shifts, update this skill. The endpoint was working as of mid-2026 in production.
7. **For multi-transaction batches** (passing several IDs in one call), expect one HTTP request per transaction. Don't try to bulk-pass IDs in a single query parameter — that's not supported.

## Reference material

- [`reference/orderful-internal-api.md`](../../reference/orderful-internal-api.md) — catalog of UI endpoints (validations, schemas, element-codes, rules, etc.) discovered via HAR analysis. Useful as a starting point for any future tooling that wants to introspect the Orderful platform.
- The Orderful public API docs cover only the `/v3/...` endpoints. The `/v2/...` endpoints used here are not documented externally, but accept the same API key.
