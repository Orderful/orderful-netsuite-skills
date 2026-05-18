---
name: audit-rules
description: Audit a customer's Orderful /v2/rules before any outbound testing. Rules can silently strip required EDI segments even when NS messages are correct and /v3/validate passes. Run this as Step 0 of every onboarding to avoid hours of confused debugging. Trigger on "audit rules for [customer]", "check rules", "why are segments missing from sent transactions", or before first outbound test.
---

# Audit Orderful Rules (/v2/rules) — Step 0 of Every Onboarding

Orderful's per-relationship transformation rules (`/v2/rules`) can silently strip required segments from outbound messages. This audit catches narrow allowlists before they waste hours of debugging.

## When to use

- **Before the first outbound test** for any customer — this is Step 0
- When outbound transactions show segments missing on the sent transaction but present in the NS-stored message
- When `/v3/validate` accepts a message but partner-side validation reports missing fields
- When the user says "segments are disappearing", "the CN/SF/BM ref is missing on the sent side", or "audit rules"

## Why this exists

**Learned the hard way on Sherwood Lumber (May 2026):** 3 of Sherwood's per-relationship outbound rules had allowlists narrower than the partner spec. They silently stripped required CN, SF, and BM segments at send time. This cost hours of confused debugging because:

1. NS-stored messages (`custrecord_ord_tran_message`) had the right segments
2. Orderful's `/v3/validate` accepted the message
3. But post-fact validations on the **actual sent transaction** reported segments missing

The rules sit between NS send and partner delivery — they filter the message AFTER the SuiteApp sends it but BEFORE Orderful forwards it to the trading partner. They are invisible unless you explicitly audit them.

## The Audit

### Step 1 — List all rules for the customer's relationships

```
GET https://api.orderful.com/v2/rules
Header: Authorization: Bearer <JWT>
Header: X-ActingOrgId: <customer_org_id>
```

Or filter by relationship:
```
GET https://api.orderful.com/v2/rules?relationshipId=<rel_id>
```

### Step 2 — For each rule, check the allowlist

Rules can have:
- **Segment allowlists** — only these segments pass through (everything else is stripped)
- **Segment blocklists** — these segments are removed
- **Field-level transforms** — values are rewritten

**Red flags:**
- Allowlists that don't include all segments the partner spec requires
- Rules that were copied from another relationship/partner and not updated
- Rules created by a previous implementation team that are too restrictive

### Step 3 — Cross-reference against partner spec

For each outbound document type (856, 810, 855, etc.):

1. Get the partner's published guideline for that document type
2. List every required segment from the guideline
3. Verify every required segment is either:
   - Not mentioned in any rule (passes through by default), OR
   - Explicitly included in the rule's allowlist

### Step 4 — Fix or remove narrow rules

Options:
- **Widen the allowlist** to include all required segments
- **Remove the rule** if it's no longer needed (common with rules from old implementations)
- **Convert allowlist to blocklist** — if only 1-2 segments need blocking, a blocklist is safer than an allowlist (new required segments won't get silently stripped)

### Step 5 — Document findings

Record in the onboarding tracker:

```
## /v2/rules Audit — [Date]

| Relationship | Partner | Rule ID | Type | Issue | Action |
|-------------|---------|---------|------|-------|--------|
| <rel_id> | <partner> | <rule_id> | Allowlist | Missing CN, SF, BM | Widened to include all 856 required segments |
```

## Behaviour rules

1. **Run this BEFORE any outbound testing.** Don't discover rule problems after spending hours debugging JSONata.
2. **Check every outbound relationship.** Rules are per-relationship, not per-customer. A customer with 5 TPs may have rules on some relationships but not others.
3. **Prefer blocklists over allowlists.** Allowlists are dangerous because new required segments (from guideline updates or spec changes) get silently stripped. Blocklists only remove what you explicitly name.
4. **Compare against the PARTNER spec, not just Orderful's schema.** Orderful's `/v3/validate` checks against Orderful's schema. Partner-side validation checks against the partner's published guideline. They are not the same — a message can be VALID per Orderful but INVALID per the partner if rules stripped required segments.
5. **Check rules from previous implementations.** When a customer migrates from another EDI provider, old rules may have been created during initial setup and never updated. These are the most likely to have narrow allowlists.

## Diagnostic Pattern

When a sent transaction is missing segments that the NS message has:

```
NS message has segment → /v3/validate says VALID → Sent to Orderful → /v2/rules strips it → Partner receives without segment → Partner validation FAILS
```

The telltale sign: the NS-stored message (`custrecord_ord_tran_message`) has the right data, but the transaction detail in the Orderful UI (which shows the post-rules version) is missing segments.

To confirm, compare:
1. `custrecord_ord_tran_message` from NS (pre-rules)
2. The sent message from `GET /v3/transactions/<id>/message` (post-rules)

If they differ, a rule is the cause.
