# Creating a NetSuite Integration Record + Access Token

Your customer needs a NetSuite Integration record and an Access Token before the `netsuite-setup` skill can validate access. The Orderful SuiteApp does not currently ship with a pre-configured integration, so this needs to be done once per customer account.

Any user with admin-level access to the customer's NetSuite can do this. It takes ~5 minutes.

## Prerequisite — enable features

In the customer's NetSuite:

1. **Setup > Company > Enable Features > SuiteCloud**
2. Check both:
   - **Token-Based Authentication**
   - **REST Web Services**
3. Save. Accept the terms if prompted.

## Step 1 — Create the Integration record

1. **Setup > Integration > Manage Integrations > New**
2. Fill in:
   - **Name**: `Orderful Onboarding - <Your Name or Team>` — make it clear who owns the integration so the customer can see it in the list later.
   - **State**: Enabled
   - **Description** (optional): "Used by Orderful onboarding tooling for configuration validation and testing."
3. Under **Authentication**:
   - Check **Token-Based Authentication**.
   - Uncheck **TBA: Authorization Flow** (we're not using the OAuth consumer-based flow).
   - Uncheck **OAuth 2.0** and anything else that's checked by default — keep this minimal.
   - Leave **User Credentials** unchecked.
4. **Save**.
5. NetSuite will show you the **Consumer Key** and **Consumer Secret** at the bottom of the page **once**. Copy both into the `.env` file immediately — use `NS_SB_CONSUMER_KEY` / `NS_SB_CONSUMER_SECRET` for a sandbox account, or `NS_PROD_*` for production. If you navigate away without copying, you'll need to click **Reset Credentials** to get new values — the old ones become invalid.

## Step 2 — Create the Access Token

1. **Setup > Users/Roles > Access Tokens > New**
2. Fill in:
   - **Application Name**: select the integration record you just created.
   - **User**: the NetSuite user whose permissions the token will use. For onboarding, this is typically an admin user or a dedicated onboarding user.
   - **Role**: a role on that user that has sufficient permissions (see [Required role permissions](#required-role-permissions) below). Administrator works out of the box and is fine for short-term onboarding access. A custom role is preferred for ongoing/production use.
   - **Token Name**: auto-generated is fine, or customize.
3. **Save**.
4. NetSuite will show you the **Token ID** and **Token Secret** **once**. Copy both into the `.env` file immediately — use `NS_SB_TOKEN_ID` / `NS_SB_TOKEN_SECRET` for a sandbox account, or `NS_PROD_*` for production.

## Required role permissions

The role on the access token needs all of these. Set on **Setup > Users/Roles > Manage Roles > [role] > Permissions**:

| Tab | Permission | Level | Why |
|---|---|---|---|
| Setup | Log in using Access Tokens | Full | Required for any TBA call |
| Setup | REST Web Services | Full | Required to hit `/services/rest/*` (SuiteQL, RESTlets, record API) |
| Setup | SuiteScript | Full | Required to execute the SuiteApp's RESTlets (e.g., agent-write) |
| Setup | SuiteScript Scheduling | (no level — just add the row) | Required for skills that submit MapReduce jobs via `task.create()` (`/run-poller`, `/reprocess-transaction`). Without this, the RESTlet returns `INSUFFICIENT_PERMISSION` |
| **Lists** | **Custom Record Entries** | **Edit** | **Required to load/save the SuiteApp's custom records** (e.g., `customrecord_orderful_transaction`). Their access type is `CUSTRECORDENTRYPERM`, which checks this generic Lists permission — *not* the per-record-type entries on the Custom Record subtab, *not* the custom record's own Permissions tab. **Most-commonly-missed permission.** Failure manifests as `INSUFFICIENT_PERMISSION ... custom record type Orderful Transaction` |
| Lists | Documents and Files | Full | The SuiteApp reads/writes EDI payloads to the File Cabinet |

Plus any record-level read/write permissions the customer's onboarding scope requires (Transactions, Items, Customers, etc.). When in doubt, copy permissions from a working customer's role or start from Administrator and prune.

If the access token already exists and you only need to update permissions, edit the role directly — the token doesn't need to be regenerated. Permission changes typically take effect immediately, but allow ~5 minutes if a retest still fails.

### Why the Custom Record Entries gotcha

NetSuite custom records have an **Access Type** setting that controls how permissions are evaluated. The Orderful SuiteApp's records ship with `Require Custom Record Entries Permission` (SDF: `CUSTRECORDENTRYPERM`). Under this mode:

- ✅ The role's generic **Custom Record Entries** permission (Lists tab) is checked
- ❌ Per-record-type entries on the role's **Custom Record** subtab are ignored
- ❌ The custom record's own **Permissions** tab is ignored

It's a quirk of NetSuite's permission model. The natural place to grant access — adding "Custom Record: Orderful Transaction" with Edit on the role's Custom Record subtab — is exactly the wrong place. Always use the Lists subtab's "Custom Record Entries" entry instead.

## Step 3 — Verify

Run the `netsuite-setup` skill's validation step (`node test-connections.mjs <customer-dir>`). If it fails, see the troubleshooting notes in `SKILL.md` Step 5.

## Deprovisioning

When onboarding work is complete, or the resource leaves the engagement:

1. **Setup > Users/Roles > Access Tokens** → find the token → **Revoke**.
2. If no other tokens use the integration, **Setup > Integration > Manage Integrations** → set state to **Blocked** or delete.

Leaving unused tokens active is a security risk. Build this into the handoff.
