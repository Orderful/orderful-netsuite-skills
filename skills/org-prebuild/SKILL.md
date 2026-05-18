---
name: org-prebuild
description: Pre-build a customer's Orderful organization using data from SPS/DSCO recon — set up trading partnerships, assign guidelines, configure relationships, and verify readiness before kickoff. Use when the user has completed recon (sps-recon and/or dsco-recon) and wants to configure the customer's Orderful org, says "prebuild the org", "set up Orderful", "configure partnerships", or is preparing for a customer kickoff call.
---

# Org Prebuild: Configure Orderful Organization from Recon Data

Pre-build a customer's Orderful organization so that when the kickoff call happens, the platform is ready and the conversation is about fine-tuning, not discovery. This skill takes the output of `sps-recon` and/or `dsco-recon` and translates it into Orderful platform configuration.

## When to use

- Recon is complete (SPS and/or DSCO data has been extracted)
- The customer's Orderful org is provisioned (org ID and ISA exist)
- User says "prebuild the org", "set up their Orderful", "configure partnerships", "get the org ready"
- Preparing for a kickoff call and want everything pre-configured

## Prerequisites

1. **Orderful org provisioned** — org ID and ISA ID exist. Confirm via:
   ```
   GET https://api.orderful.com/v2/organizations/search?name=<customer_name>
   ```
2. **Recon data available** — either SPS recon, DSCO recon, or both have been completed and documented in the onboarding tracker.
3. **Trading partner(s) identified** — which Orderful orgs the customer will trade with, and which EDI account per partner (especially important for DSCO paths where the partner has multiple EDI accounts).
4. **Orderful API access** — API key (from Settings > API Credentials in Orderful UI) for v3 API, or Bearer JWT token for v2 API reads. **For creating transactions, always use the v3 API** (see Step 7).

## Inputs

From the onboarding tracker and recon reports:
1. **Customer Orderful Org ID** and **ISA ID**
2. **Trading partner Org ID(s)** and **EDI Account ID(s)**
3. **Transaction types per partner** (from recon)
4. **Guideline IDs** (from cross-reference in recon)
5. **Direction per TX type** (inbound/outbound from customer's perspective)

## Step 0 — Audit /v2/rules (BEFORE testing)

**Run the `audit-rules` skill before any outbound testing.** Per-relationship rules at `/v2/rules` can silently strip required segments from outbound messages even when the NS-stored message is correct and `/v3/validate` passes. This was learned the hard way on Sherwood Lumber (May 2026) — 3 rules had narrow allowlists that stripped required CN/SF/BM segments, costing hours of debugging.

See [`audit-rules`](../audit-rules/SKILL.md) for the full procedure.

## Step 1 — Verify org state

Before configuring anything, audit the current state of the customer's Orderful org:

### Check org exists and ISA is correct
```
GET https://api.orderful.com/v2/organizations/<org_id>
```
Confirm: name, ISA ID matches what we expect, org is claimed.

### Check for existing partnerships
```
GET https://api.orderful.com/v2/trading-partnerships?followerOrganizationId=<org_id>
```
If partnerships already exist, document them. Don't create duplicates.

### Check for existing relationships (document-level config)
```
GET https://api.orderful.com/v2/document-relationships?ownerId=<org_id>&limit=500
```
If relationships exist, note which TX types and partners are already configured.

Document the current org state in the tracker under a "Prebuild Audit" section.

## Step 2 — Plan partnerships and relationships

Based on recon data, build the configuration plan. For each trading partner:

```
Partner: [Name] (Org [ID], EDI Account [ID], ISA [ISA_ID])
Path: [Direct / DSCO / Other intermediary]

Relationships to create:
| TX Type | Direction (customer POV) | Guideline ID | Notes |
|---------|--------------------------|--------------|-------|
| 850     | Receive (inbound)        | [ID]         | PO from partner |
| 856     | Send (outbound)          | [ID]         | ASN to partner |
| 810     | Send (outbound)          | [ID]         | Invoice to partner |
| 846     | Send (outbound)          | [ID]         | Inventory (if DSCO) |
| 870     | Send (outbound)          | [ID]         | Order status (if DSCO) |

Already exists:
| TX Type | Relationship ID | Status |
```

### Guideline selection logic

For each TX type + partner combination, select the correct guideline:

1. **Check for partner-specific guidelines first.** Many large partners publish their own:
   ```
   GET https://api.orderful.com/v2/guideline-sets?organizationName=<partner>&transactionSetIdentifierCode=<TX>&status=PUBLISHED
   ```

2. **For DSCO paths, check for retailer-specific DSCO guidelines.** These are published under the retailer's name with "DSCO" or "Rithum" in the guideline name:
   ```
   GET https://api.orderful.com/v2/guideline-sets?organizationName=<retailer>&status=PUBLISHED&limit=100
   ```
   Filter results for names containing "DSCO" or "Rithum".

3. **Fall back to generic DSCO guidelines** if no retailer-specific one exists:
   ```
   GET https://api.orderful.com/v2/guideline-sets?organizationName=DSCO&status=PUBLISHED
   ```

4. **If multiple versions exist** (e.g., 4010 and 5010), check what version the recon data shows the partner using. Match it. When in doubt, use the latest version.

Present the full plan to the user before any writes.

## Step 3 — Create trade requests

Trade requests are created through the Orderful UI — there is no public API endpoint for this.

For each partnership that doesn't already exist, instruct the user:

1. Log into `app.orderful.com` as the customer's org (or with admin access).
2. Navigate to **Trading Partners** → **Send Trade Request**.
3. Search for the partner by name or ISA ID.
4. **Critical for DSCO**: Select the correct EDI account on the partner side. DSCO partners have multiple EDI accounts (e.g., AAFES has direct, DSCO, and VendorNet accounts). Select the DSCO-specific account.
5. Select transaction types and directions.
6. Submit the trade request.

Provide the exact values for each field so the user can fill them in without guessing.

After the trade request is accepted (may require partner-side approval or Orderful admin action), proceed to relationship configuration.

## Step 4 — Configure document relationships

Once partnerships are active, configure document relationships. For each TX type:

### Via Orderful UI
1. Navigate to the partnership → **Documents** tab.
2. For each TX type, click **Configure** (or **Add Document**).
3. Assign the correct guideline (from Step 2).
4. Set direction (Send or Receive from customer's perspective).
5. Set stream (Test initially, Live when ready for go-live).

### Verify via API
After configuration:
```
GET https://api.orderful.com/v2/document-relationships?ownerId=<customer_org_id>&limit=500
```
Confirm each expected relationship exists with the correct:
- `transactionSetIdentifierCode` (850, 856, etc.)
- `guidelineSetId` (matches selected guideline)
- `senderEdiAccount` / `receiverEdiAccount` (correct sides)
- `isActive` and `isLive` status

## Step 4b — Configure communication channels on outbound relationships

**Every outbound relationship MUST have a communication channel assigned, or delivery will fail silently.** Transactions will pass validation (VALID) but show `deliveryStatus: FAILED` because Orderful has nowhere to send them.

### For testing: "Keep In Orderful" channel

Every Orderful org is provisioned with a "Keep In Orderful" communication channel (`destinationTypeName: "nowhere"`). Find it:

```
GET https://api.orderful.com/v2/communication-channels?ownerId=<customer_org_id>
```

Look for the channel with `"destinationTypeName": "nowhere"`. Note its `id`.

### Assign to all outbound relationships

For each outbound relationship (856, 810, 846, 870, etc.), PATCH the communication channel settings:

```
PATCH https://api.orderful.com/v2/document-relationships/<rel_id>
Content-Type: application/json

{
  "config": {
    "communicationChannelSettings": [
      {"stream": "test", "communicationChannelId": <keep_in_orderful_channel_id>},
      {"stream": "live", "communicationChannelId": <keep_in_orderful_channel_id>}
    ]
  }
}
```

**API gotcha (learned on RuffleButts May 2026):** Do NOT use top-level `testCommunicationChannelId` / `prodCommunicationChannelId` fields in the PATCH — the API returns `property should not exist`. The correct path is `config.communicationChannelSettings`.

### For production: replace with real partner delivery channel

At go-live, replace the "Keep In Orderful" channel with the partner's actual delivery endpoint (SFTP, AS2, etc.) configured by the partner or intermediary (e.g., Rithum for DSCO).

### Resending failed transactions

If transactions already failed delivery before the channel was configured, resend them:

```
POST https://api.orderful.com/v2/transactions/<tx_id>/send
Content-Type: application/json

{"requesterId": <customer_org_id>}
```

Returns `201` on success. The transaction status updates from FAILED to SENT.

## Step 5 — Verify readiness

Run a checklist against the configured org:

```
## Prebuild Verification — [Customer Name]

### Org Configuration
- [ ] Org exists and is claimed
- [ ] ISA ID is correct
- [ ] Contact email is set

### Partnerships (per partner)
- [ ] Trade request sent and accepted
- [ ] Partnership is active
- [ ] Correct EDI account selected (especially for DSCO)

### Document Relationships (per partner × TX type)
- [ ] Relationship created
- [ ] Correct guideline assigned
- [ ] Direction correct (Send/Receive)
- [ ] Stream set to Test (pre-go-live)
- [ ] **Communication channel assigned on ALL outbound relationships** (see Step 4b)

### Ready for Kickoff
- [ ] All partnerships active
- [ ] All document relationships configured
- [ ] Guidelines match recon data (version, format)
- [ ] No orphaned or duplicate relationships
- [ ] Onboarding tracker updated with prebuild results
```

## Step 6 — Update the tracker

Append prebuild results to the onboarding tracker:

```
## Orderful Org Prebuild — [Date]

### Org State
- Org ID: [id]
- ISA: [isa]
- Partnerships: [count] active

### Configured Relationships
| Partner | TX Type | Direction | Guideline | Stream | Status |
|---------|---------|-----------|-----------|--------|--------|

### Pending Actions
- [ ] [any items that couldn't be completed]

### Ready for Kickoff: [Yes/No]
```

## Step 7 — Submit a test transaction

Once partnerships and relationships are configured, submit a test transaction to verify the pipeline. Use the **v3 API** (NOT v2) with the `orderful-api-key` header.

### v3 API — Create Transaction (the only reliable path)

```
POST https://api.orderful.com/v3/transactions
Header: orderful-api-key: <API_KEY>
Header: Content-Type: application/json
```

**Request body:**
```json
{
    "sender": {
        "isaId": "SENDER_ISA_ID"
    },
    "receiver": {
        "isaId": "RECEIVER_ISA_ID"
    },
    "type": {
        "name": "850_PURCHASE_ORDER"
    },
    "stream": "test",
    "message": {
        "interchangeControlHeader": [...],
        "functionalGroupHeader": [...],
        "transactionSets": [...]
    }
}
```

### Critical API rules (learned the hard way)

1. **Always use v3 (`/v3/transactions`), not v2 (`/v2/transactions`).** v2 enforces that the message format matches the sender relationship's configured data format (X12 vs JSON). DSCO relationships are configured for X12 — sending JSON via v2 returns 422 "data format mismatch." v3 handles the conversion automatically.

2. **Use `orderful-api-key` header, not Bearer token.** The API key is in Orderful Settings > API Credentials. Bearer JWT tokens (from Auth0) work with v2 reads but not v3.

3. **Transaction type names are system names.** `850` alone doesn't exist. Must use `850_PURCHASE_ORDER`, `856_SHIP_NOTICE`, `810_INVOICE`, etc. Discoverable via `GET /v2/transaction-types`.

4. **`sender`/`receiver`, not `from`/`to`.** v3: `{sender: {isaId: "..."}, receiver: {isaId: "..."}}`. v2 used `{from: {id, idType}, to: {id, idType}}`.

5. **Message must be wrapped in an envelope.** The ISA/GS/transactionSets JSON goes in the `message` field. Top-level fields are `sender`, `receiver`, `type`, `stream`, `message`.

6. **Orderful UI upload also requires the envelope** (or a raw X12/EDI file). Uploading raw JSON ISA/GS content via the UI gives 400.

### Building a test transaction from scratch

When there's no historical data for a new relationship:
1. Pull a live reference transaction from another vendor on the same path (e.g., another DSCO vendor's 850)
2. Substitute the customer's item data (from SPS recon or NS item records)
3. Update ISA sender/receiver IDs to match the customer's partnership
4. Set `interchangeUsageIndicatorCode` to `T` (test)
5. Use placeholder values for items you don't have yet (mark clearly as `TODO_GET_FROM_NETSUITE`)
6. Submit via v3 API with `stream: "test"`

See the `submit-test-transaction` skill for the full procedure.

## Behaviour rules

1. **Read before write.** Always audit existing state before proposing changes. Never create duplicate partnerships or relationships.
2. **Plan before execute.** Present the full configuration plan to the user. Get confirmation before any UI actions.
3. **DSCO EDI account selection is critical.** The #1 mistake in DSCO onboarding is selecting the wrong EDI account on the partner side. Always confirm: "Is this the DSCO account (ISA: DSCO<RETAILER>) or the direct account (ISA: <direct_ISA>)?"
4. **Start in Test stream.** All new relationships should be set to Test until go-live. Never configure a new relationship as Live without explicit user direction.
5. **Guideline version matters.** A 4010 guideline applied to a 5010 transaction will cause validation failures. Match the version from recon data.
6. **Track everything.** Every configuration change goes into the onboarding tracker with date, what was done, and current state.

## Common gotchas

- **Trade requests need partner-side acceptance.** For large partners (AAFES, Target, Walmart), this may require Orderful admin intervention or the partner's implementation team to accept. Don't assume it's instant.
- **DSCO partner setup is a separate step.** Even after Orderful relationships are configured, Rithum needs to be told that Orderful is now the customer's EDI provider. Email `dscopartnersetup@rithum.com`. This is often forgotten.
- **Multiple guideline versions.** Partners like AAFES may have legacy guidelines (2009) and current ones (2024). Always use the latest unless recon data shows the partner is still on an older version.
- **ISA collision between test and live.** Verify the partnership has distinct test and live ISAs. If `liveIsaId === testIsaId`, flag it — test transactions will look like live ones.
- **Org not claimed.** If the customer hasn't logged into Orderful and claimed their org, some configuration options may be limited. Confirm claimed status early.
