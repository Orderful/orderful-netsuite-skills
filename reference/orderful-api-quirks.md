# Orderful API quirks

Reference notes on non-obvious behavior of the Orderful Public API. These are gotchas worth knowing before you build anything against `api.orderful.com`.

> **Single endpoint.** Orderful has one global host: `https://api.orderful.com`. There is no `api-sandbox.orderful.com`. The same API key works for live and test traffic — the `stream` field on the transaction tells you which is which.

## v3 vs v2 — the filter-params trap

The biggest gotcha: **`/v3/transactions` does not accept any filter query parameters.** Every filter you might intuitively try (`type`, `documentType`, `transactionTypeId`, `partnerEdiAccountId`, `pageSize`, `limit`, `filter[type]`, `type.name`, etc.) returns:

```json
{
  "type": "argumentError",
  "ref": "user",
  "message": "There were errors with your request",
  "errors": [
    { "type": "argumentError", "ref": "<paramName>", "message": "property <paramName> should not exist" }
  ]
}
```

The only exceptions on v3 that work:
- `nextCursor=<opaque>` — pagination
- `businessNumber=<value>` — single PO# lookup (returns 0 or 1 hit)

**For filtered list queries, use the `/v2/transactions` endpoint instead.** It accepts:

| Param | Type | Notes |
|---|---|---|
| `partnerEdiAccountId` | int | Partner EDI account ID. Find it in the Orderful UI URL when you filter by partner: `https://ui.orderful.com/transactions?...&partnerEdiAccountId=<n>&...` |
| `transactionTypeId` | int | Numeric doc type ID. See [edi-codes-and-mappings.md](edi-codes-and-mappings.md) for the table. |
| `stream` | `live` \| `test` | Which traffic stream. |
| `limit` | int | Page size. Default 100, observed working up to 200. |
| `offset` | int | Offset-based pagination (v2 returns `pagination.total`, `pagination.limit`, `pagination.offset`). |

Working example — list all live 860s for a specific partner:

```
GET https://api.orderful.com/v2/transactions?partnerEdiAccountId=<n>&stream=live&transactionTypeId=23&limit=200
Headers:
  orderful-api-key: <orderful-api-key>
```

Response shape:

```json
{
  "query": { "partnerEdiAccountId": [<n>], "transactionTypeId": [23], "stream": ["live"], "ownerId": <ownerId>, "offset": 0, "limit": 100 },
  "pagination": { "limit": 100, "offset": 0, "total": <int>, "links": { "next": null, "prev": null } },
  "data": [
    {
      "id": <int>,
      "from": { "idType": "isaId", "id": "<sender-isa-id>" },
      "to":   { "idType": "isaId", "id": "<receiver-isa-id>" },
      "stream": "live",
      "businessNumber": "<po-number>",
      "type": "<doc-type-name>",
      "validationStatus": "VALID",
      "deliveryStatus": "DELIVERED",
      "acknowledgmentStatus": "ACCEPTED",
      "status": "ACCEPTED",
      "message": { /* parsed EDI structure */ },
      "createdAt": "<iso8601>",
      "latestRevisionAt": "<iso8601>"
    }
  ]
}
```

Note that v2 returns numeric `id` (e.g. `896557727`) while v3 returns string `id` (e.g. `"896557727"`). Cast appropriately.

## v3 list endpoint — pagination shape

When you DO use `/v3/transactions` (e.g. to crawl recent traffic without filters), the response is:

```json
{
  "metadata": {
    "pagination": {
      "links": {
        "next": "https://api.orderful.com/v3/transactions?nextCursor=<base64>",
        "prev": null
      }
    }
  },
  "data": [ /* transactions */ ]
}
```

Cursor-based, oldest-to-newest *within the page* but the page itself starts at the most-recent transaction. Items per page is fixed at 100. There's no `total` count.

Don't confuse with the v2 shape — v3 uses `metadata.pagination.links`, v2 uses `pagination.total` + offset/limit.

## Single-transaction lookup

```
GET https://api.orderful.com/v3/transactions/{id}
GET https://api.orderful.com/v3/transactions/{id}?expand=message
```

`?expand=message` returns the full parsed EDI tree under `message`. Without it, you get headers only.

The `id` is the numeric Orderful Transaction ID (also returned as `name` on `customrecord_orderful_transaction` records and embedded in NS `mapped_data` as `metaData.orderfulId`).

## The `businessNumber` field

`businessNumber` is the partner-supplied business identifier — for 850/860 it's the purchase order number; for 855 it's the PO number being acknowledged; for 810 it's the invoice number, etc. It maps to `custrecord_orderful_po_number` on the NS `customrecord_orderful_transaction` record for 850/860 traffic. Useful for cross-referencing a NS SO's `otherrefnum` to Orderful traffic.

## Auth

```
Header: orderful-api-key: <orderful-api-key>
```

That's it. No OAuth. No bearer. The key is a single global token per Orderful org. If a request returns 401/403 with `"Application with key undefined not found"`, your env var didn't load (often a path-resolution issue when running scripts from a different working directory).

## What v3 *does* expose that v2 doesn't

- `referenceIdentifiers[]` — the parsed ISA/group/transaction control numbers, both sender- and receiver-owned.
- `acknowledgment.href` — direct link to the 997 ack object for this transaction.
- `delivery.href` + `delivery.approve.href` + `delivery.fail.href` — outbound delivery state machine endpoints. Use these to manually approve or fail a stuck outbound.

So a typical workflow when you need both filtered listing AND deep detail:
1. List with `/v2/transactions` to find the IDs you care about.
2. For each ID, fetch `/v3/transactions/{id}?expand=message` for the full content.
