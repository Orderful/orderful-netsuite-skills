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
   - **Role**: a role on that user that has sufficient permissions. Administrator works but is often overkill; a custom role with "REST Web Services" and "Log in using Access Tokens" permissions plus read access to transactions/items/customers is ideal. Orderful does not ship a recommended role — use Administrator if you're unsure and it's for short-term onboarding access.
   - **Token Name**: auto-generated is fine, or customize.
3. **Save**.
4. NetSuite will show you the **Token ID** and **Token Secret** **once**. Copy both into the `.env` file immediately — use `NS_SB_TOKEN_ID` / `NS_SB_TOKEN_SECRET` for a sandbox account, or `NS_PROD_*` for production.

## Step 3 — Verify

Run the `netsuite-setup` skill's validation step (`node test-connections.mjs <customer-dir>`). If it fails, see the troubleshooting notes in `SKILL.md` Step 5.

## Deprovisioning

When onboarding work is complete, or the resource leaves the engagement:

1. **Setup > Users/Roles > Access Tokens** → find the token → **Revoke**.
2. If no other tokens use the integration, **Setup > Integration > Manage Integrations** → set state to **Blocked** or delete.

Leaving unused tokens active is a security risk. Build this into the handoff.
