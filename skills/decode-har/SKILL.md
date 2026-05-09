---
name: decode-har
description: Decode a HAR file from any web app (Orderful UI, NetSuite UI, partner portals, anything) into a clean catalog of API endpoints called, with sample request/response shapes per endpoint. Use when the user wants to "reverse-engineer this UI", "find the API behind this page", "what endpoints did the UI call", "/decode-har", "parse my HAR", "I captured network traffic — show me what's there", or whenever they need to figure out a programmatic path to data they're currently clicking through a UI to see.
---

# Decode HAR

Web UIs almost always call structured JSON APIs that the contractor team can hit directly — but the endpoints are rarely documented externally, and figuring out which one returns the data you need by clicking around DevTools is slow.

This skill takes a HAR (HTTP Archive) export from a browser session and prints a clean, deduplicated catalog of every endpoint hit, grouped by URL pattern, with sample request headers and response previews. Once you can see the catalog, picking the right endpoint to replicate becomes obvious.

The output is intentionally short: filenames + URL templates + sample payloads. The full request/response bodies are written to disk so you can inspect them in detail without flooding the terminal.

## When to use this skill

- "I captured a HAR from the Orderful UI — what API did it call?"
- "Decode this HAR, I want to find the validation endpoint"
- "How do I get the rules data programmatically? I have a HAR open"
- "/decode-har"
- "We need to replicate this UI flow — show me what calls it makes"
- Any time the user has captured network traffic and wants a structured view

Do NOT use this skill for:
- Decoding HTTPS traffic without a HAR (use a real proxy like mitmproxy instead)
- Live-streaming endpoint discovery (HAR is a snapshot, not a stream)
- Anything where you don't actually have a HAR file to point at

## Inputs the skill needs

- **Path to the HAR file.** Default: `~/Desktop/<host>.har` (Chrome's default save location). If unspecified, the script will look there.
- **Optional: a focus filter.** A regex (or substring) to narrow the catalog to endpoints whose URL or path matches. Useful when the HAR captured a busy session and you only care about a subset.

## How to capture a HAR

1. Open the page you want to inspect in Chrome.
2. Open DevTools (`Cmd+Opt+I`), Network tab, **Fetch/XHR** filter, **Preserve log** checked.
3. Click around to exercise the UI flow you want to reverse-engineer.
4. Right-click anywhere in the Network panel → **Save all as HAR with content**.
5. Save to `~/Desktop/` (or wherever, then pass as a flag).

The "with content" variant is important — without it, request/response bodies are stripped.

## The recipe

### Step 1 — Run the parser

```sh
node <path-to-this-skill>/decode-har.mjs [<har-path>] [--filter=<regex>]
```

Defaults: HAR at `~/Desktop/*.har` (most recent), no filter.

The parser:
- Filters out static assets (`.js`, `.css`, fonts, images, source maps)
- Filters out 3rd-party tracking (Google Analytics, Datadog, Segment, hCaptcha, etc.)
- Groups remaining requests by `METHOD host/path` (with numeric and UUID-like ID segments collapsed to `{id}`)
- Sorts by call count

### Step 2 — Read the catalog

Each group shows:
- HTTP method + URL pattern
- Number of times the pattern was hit
- For successful responses: response size, content type, first-100-character preview, top-level JSON keys

Endpoints relevant to the partner-spec / validation work are flagged separately at the top: any URL containing `valid`, `rule`, `schema`, `guideline`, `error`, etc.

### Step 3 — Save the bodies you care about

For each group, the largest interesting response body is auto-saved as `har-<sanitized-path>.json` in the current directory. Open whichever ones look promising to inspect the full payload shape.

### Step 4 — Replicate the call

Once you've identified the endpoint:
1. Find one captured call in the HAR.
2. Note the auth header (`Authorization: Bearer <jwt>`, cookie, etc.) and any `X-*` custom headers.
3. Replicate via `fetch` or `curl`. The auth often expires — capture a fresh HAR when it does.

For Orderful UI specifically, see [`reference/orderful-internal-api.md`](../../reference/orderful-internal-api.md) — already cataloged from prior HAR analyses, so you may not need to re-decode.

## Behaviour rules

1. **Never commit HAR files.** They contain auth tokens, cookies, and arbitrary user data. Treat them as session secrets — keep on the local machine only. The skills repo's `.gitignore` should keep `*.har` out, but double-check before committing.
2. **Don't paste full HAR contents into chat.** Run the script locally and share only the cataloged output (which the parser intentionally strips of sensitive headers in its print summary).
3. **Auth tokens in HAR files are time-limited.** Most JWTs last 1–24h. If the user is sharing a HAR for active analysis, they should expect to recapture for any follow-up work.
4. **Don't over-filter.** The default static-asset filter already removes the noise. Adding a too-narrow `--filter` regex risks hiding the endpoint you actually want — start broad and tighten.
5. **The catalog is descriptive, not normative.** Just because the UI called an endpoint with a particular shape doesn't mean it's a stable, supported public API. Check whether the platform's public API docs cover it before depending on it long-term.

## Reference material

- [`reference/orderful-internal-api.md`](../../reference/orderful-internal-api.md) — pre-cataloged Orderful UI endpoints discovered via prior HAR analysis (validations, schemas, rules, examples, transaction-types, etc.).
- [`fetch-validations`](../fetch-validations/SKILL.md) — concrete example of using a HAR-discovered endpoint as a productive helper.
