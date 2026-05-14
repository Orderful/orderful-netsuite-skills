# Orderful internal/UI API endpoints (HAR-derived)

The `/v3/transactions` listing endpoint is the only Orderful API endpoint with public-API-key auth and external documentation. The Orderful UI itself uses a much richer set of `/v2/...` endpoints, authed via a session JWT (Bearer token from the logged-in user's session).

This doc catalogs the UI endpoints discovered via HAR captures of `https://ui.orderful.com`. They are **undocumented** and could change without notice — but they're the only practical path to schema and validation data programmatically.

## Auth

- **`Authorization: Bearer <JWT>`** — UI session JWT. Captured from any HAR export of a logged-in UI session. Lifetime ~24h.
- **`X-Orderful-Client: ui`** — required header.
- **`X-ActingOrgId: <orgId>`** — required header; identifies the org context.

The `orderful-api-key` header is **not** used by UI endpoints.

## Endpoint catalog

### Validation errors (per transaction)

```
GET /v2/organizations/{orgId}/transactions/{txId}/validations
```

Returns an array of structured errors:

```json
[
  {
    "dataPath": "transactionSets.0.currency.0.entityIdentifierCode",
    "dataPathDescription": "Code identifying an organizational entity, ...",
    "message": "\"SE\" is not a valid input",
    "allowedValues": [{ "value": "BY", "description": "Buying Party (Purchaser)" }],
    "grouping": "1-1-1",
    "validationErrorType": "codes"
  }
]
```

`?dataFormat=X12&version=004030` returns the same errors with X12-style paths (`CUR.CUR01`) instead of Mosaic paths.

See the `fetch-validations` skill for an end-to-end helper.

### Transaction details

```
GET /v2/transactions/{txId}
GET /v2/organizations/{orgId}/transactions/{txId}
GET /v2/organizations/{orgId}/transactions/{txId}/revisions/latest
GET /v2/organizations/{orgId}/transactions/{txId}/revisions/{revId}
```

Richer than `/v3/transactions/{id}` — includes additional metadata around revisions, attachments, notifications.

### Transaction message body (parsed)

```
GET /v3/transactions/{txId}/message
```

Returns the parsed Mosaic JSON of the transaction's message (same as `custrecord_ord_tran_message` on the NS side, but already deserialized).

### Schemas

```
GET /v2/transaction-types
```

All 184 X12 transaction types Orderful knows about. Use this to map `friendlyName` (e.g., "856 Ship Notice/Manifest") to `id` (17). The IDs are referenced by other endpoints.

Common ids:
- `12` — 810 Invoice
- `15` — 850 Purchase Order
- `16` — 855 Purchase Order Acknowledgment
- `17` — 856 Ship Notice/Manifest
- `28` — 880 Grocery Products Invoice

```
GET /v2/schemas
GET /v2/schemas/{schemaId}?withVersionMap=true
GET /v2/schemas/{schemaId}/element-codes
```

The `schemas` listing returns all 1,620+ schemas across transaction types and X12 versions. `schemas/{id}` returns the full Mosaic schema — segment hierarchies, field types, syntax rules. `element-codes` returns the master code lists (every `entityIdentifierCode`, `productServiceIDQualifier`, etc. with all valid values).

### Partner-specific overlay rules

```
GET /v2/rules?ownerId={orgId}&relationshipId={partnerId}&transactionTypeId={typeId}
GET /v2/rules?dataFormat=X12&ownerId={orgId}&relationshipId={partnerId}&transactionTypeId={typeId}&version={schemaVersion}
GET /v2/rules?direction=out&ownerId={orgId}&relationshipId={partnerId}&transactionTypeId={typeId}
GET /v2/rules?ownerId={orgId}&relationshipId={partnerId}
GET /v2/rules/functions
```

This is where partner specs (the things you'd otherwise read from a vendor's PDF guidelines) are encoded. Each rule has:

```json
{
  "id": "...",
  "ownerId": "<orgId>",
  "relationshipId": "<partnerId>",
  "transactionTypeId": "<typeId>",
  "direction": "out",
  "path": "transactionSets.*.referenceInformation.*",
  "liveExpression": { /* JSON expression: validation/override logic */ },
  "testExpression": { /* mirrored test-stream version */ },
  "source": "...",
  "createdAt": "...", "updatedAt": "..."
}
```

`/v2/rules/functions` lists 48 rule-engine functions available inside `liveExpression` (built-in primitives like `equals`, `oneOf`, `regex`, etc.).

### Examples (sample messages)

```
GET /v2/examples?transactionTypeId={id}
GET /v2/examples?dataFormat=JSON&dataVersion=1&transactionTypeId={id}
GET /v2/examples?dataFormat=X12&dataVersion=004030&transactionTypeId={id}
```

Returns example messages for a transaction type — useful as a starting reference when writing a new outbound message.

### Trading partnerships

```
GET /v2/trading-partnerships/{relationshipId}
GET /v2/trading-partners
```

Resolves `relationshipId` (used in `/v2/rules`) to a partner identity.

### Other endpoints seen in HAR

```
GET /v2/organizations/{orgId}
GET /v2/users/me
GET /v2/users/me/roles
GET /v2/permissions
GET /v2/transactions/{txId}/notifications
GET /v2/transactions/{txId}/attachments
GET /v2/order-fulfillment-workflows
GET /v2/document-relationships
GET /v2/document-relationships/{id}
GET /v2/guideline-sets/{id}
GET /v2/guideline-sets/{id}/guidelines
GET /v2/scenario-checklist
GET /v2/health/check
POST /v3/validate     -- ad-hoc validation of a draft message payload
```

## Practical use cases for this catalog

1. **`fetch-validations` skill** uses the validation endpoint instead of UI screenshots.
2. **Pre-validate before firing.** `POST /v3/validate` with a draft message payload returns the same errors `/transactions/{id}/validations` would return after the fact. Useful as a JSONata sanity check before committing to a re-fire.
3. **Auto-generate JSONata patches.** With `/v2/schemas/{id}` (base schema) + `/v2/rules?...` (partner overlay) + the emitted Mosaic message, you can mechanically diff what's expected vs. what's emitted and propose corrective transforms. Not yet built.
4. **Decode partner specs without PDFs.** `liveExpression` in `/v2/rules?...` is the JSON encoding of what a partner-spec PDF says. For partners onboarded via Orderful's spec library, this is the source of truth.

## Capturing a HAR

1. Log into `https://ui.orderful.com` in Chrome.
2. Open DevTools (`Cmd+Opt+I`), Network tab, **Fetch/XHR** filter, **Preserve log** checked.
3. Click around the UI to exercise whichever endpoints you need (transaction Errors tab, etc.).
4. Right-click in the Network panel → **Save all as HAR with content**.

The skills repo's `fetch-validations.mjs` reads the most recent HAR at `~/Desktop/ui.orderful.com.har` by default; override with `$ORDERFUL_HAR_PATH`.
