---
name: netsuite-setup
description: Set up credentials for an Orderful NetSuite SuiteApp customer. Creates a per-customer `.env` file with NetSuite Token-Based Auth (account ID, consumer key/secret, token ID/secret) and an Orderful API key, then validates both connections work. Use when the user is starting work with a new NetSuite customer, needs to configure access to a customer's NetSuite and Orderful, is onboarding a customer, or says things like "/netsuite-setup", "set up a new customer", "create customer credentials", "onboard <customer>", or "I need access to <customer>'s NetSuite".
---

# Setup: Orderful NetSuite Customer Credentials

Guide the user through bootstrapping credentials for an Orderful NetSuite SuiteApp customer. At the end, the user should have a working `.env` at `~/orderful-onboarding/<customer-slug>/.env` that any other skill in this repo can read.

## Step 0 — Verify the repo install

Before doing anything else, confirm the user has cloned `orderful-netsuite-skills` and run `./install.sh`. Quick checks:

- `~/.claude/skills/netsuite-setup` should be a symlink (`ls -l ~/.claude/skills/netsuite-setup`). If it's missing, the user hasn't run `install.sh` — point them at `SETUP.md` and stop.
- `~/orderful-onboarding/` should exist (created by `install.sh`). If missing, same fix.
- `node_modules/` should exist in the repo root (also created by `install.sh`). If missing, `test-connections.mjs` in Step 5 will fail.

If any of these are missing, instruct the user to:

```sh
cd <path-to-orderful-netsuite-skills>
./install.sh
```

…and re-invoke `/netsuite-setup` after it completes. Don't try to work around a missing install — the validation step depends on it.

## Step 1 — Identify the customer

Check `~/orderful-onboarding/` for existing customer directories using `ls`. If the directory doesn't exist, that's fine — we'll create it.

Ask the user:

- **Which customer?** If existing dirs were found, list them and ask if they want to reuse one or create a new one. If creating new, ask for a slug (kebab-case, e.g., `acme-foods`, `widgetco`).

**Assume sandbox.** Onboarding always starts in sandbox. The template defaults `ENVIRONMENT=sandbox` and has separate blocks for sandbox (`NS_SB_*`) and production (`NS_PROD_*`) NetSuite credentials — only prompt about production if the user explicitly says they're skipping sandbox.

Do NOT ask for credential values in chat yet. We'll have the user fill them into the file directly.

## Step 2 — Scaffold the customer directory

Create `~/orderful-onboarding/<customer-slug>/` if it doesn't exist. Copy the env template from this skill's directory to `<customer-dir>/.env`:

```sh
mkdir -p ~/orderful-onboarding/<slug>
cp <path-to-this-skill>/env-template.env ~/orderful-onboarding/<slug>/.env
```

Then pre-fill `CUSTOMER_SLUG` and `CUSTOMER_NAME` in the new `.env` with the values you already know — the user shouldn't have to retype them. Leave `ENVIRONMENT=sandbox` alone.

If the `.env` already exists, do not overwrite — ask whether to edit it, scrap it, or abort.

## Step 3 — Verify the customer has what they need on the NetSuite side

Before the user starts filling in values, confirm (ask if unsure):

- **Features enabled** in the customer's NetSuite: Setup > Company > Enable Features > SuiteCloud — "Token-Based Authentication" and "REST Web Services" must both be checked.
- **Integration record** exists or will be created. If the user hasn't created one yet, point them to `INTEGRATION-RECORD-SETUP.md` in this skill's directory for the step-by-step.
- **Access token** exists or will be created for a user/role with sufficient permissions. Required role permissions are listed in `INTEGRATION-RECORD-SETUP.md` ("Required role permissions" section) — note that skills that trigger MapReduce scripts (e.g. `run-poller`) need both `SuiteScript = Full` and `SuiteScript Scheduling` on the role, which Administrator has by default but custom roles often don't.

Orderful's SuiteApp does not currently ship a pre-configured integration record, so the customer must create their own.

## Step 4 — Have the user fill the template

Tell the user the full path to their new `.env` (e.g., `~/orderful-onboarding/acme-foods/.env`). Offer to open it for them (`open -t <path>` on macOS).

The template marks every required field with `<PASTE HERE>`. For sandbox onboarding, the user only needs to fill:
- The five `NS_SB_*` NetSuite sandbox fields
- `ORDERFUL_API_KEY`

The `NS_PROD_*` block can stay blank — we'll come back to it at go-live.

**Do not ask the user to paste secrets into this chat.** They should edit the file locally, save, and reply "done" or equivalent.

While waiting, you can remind them:
- NetSuite shows Consumer Key/Secret and Token ID/Secret **only once** — if they missed them, they'll need to reset and get new values.
- Orderful API keys come from the Orderful organization (`ui.orderful.com` > Organization Logo > Settings > API Credentials)

## Step 5 — Validate

Once the user confirms they've filled the file, run the validation script:

```sh
node <path-to-this-skill>/test-connections.mjs ~/orderful-onboarding/<slug>
```

The script reads `ENVIRONMENT` from the `.env` (defaults to sandbox) and picks the matching `NS_SB_*` or `NS_PROD_*` NetSuite credentials. It runs three checks:

1. **NetSuite** — a harmless `SELECT TOP 1` SuiteQL query (validates TBA + REST Web Services + role's basic data access).
2. **RESTlet** — a probe POST to the SuiteApp's agent-write RESTlet with an unknown action (validates the SuiteApp version is current AND the role has `SuiteScript = Full`). This does *not* validate `SuiteScript Scheduling`; that perm only fails when an action like `triggerInboundPolling` actually calls `task.create()`, which `/run-poller` will surface clearly on first use.
3. **Orderful** — a small authenticated GET to `api.orderful.com` (Orderful has one global endpoint, not a separate sandbox URL).

It prints pass/fail per system.

### If NetSuite fails

Common causes, check in this order:

1. **`INVALID_LOGIN` + empty Login Audit Trail** — the request was rejected at OAuth signature validation before NetSuite ever looked up the user/token, so nothing logs. The most common cause is **realm/account-ID case mismatch**: the OAuth `realm` parameter has to match the account ID character-for-character including case. Check `Setup > Company > Company Information` for the exact case (letter-prefixed IDs like `TDxxxxxxx` are usually uppercase) and update `NS_SB_ACCOUNT_ID` / `NS_PROD_ACCOUNT_ID` to match. Other less common signature-stage failures: corrupted consumer secret (extra whitespace from copy-paste), or consumer key/secret from a different integration record than the token is bound to.
2. **`INVALID_LOGIN_ATTEMPT` / 401 + audit trail entry exists** — wrong consumer key/secret, wrong token ID/secret, or token is for the wrong integration. Open the audit trail entry; the Detail column will name the specific failure (*"Invalid token"*, *"Invalid signature"*, etc.). Re-check values and note NetSuite UI only shows them once.
3. **`INVALID_LOGIN` + audit trail says "Role does not have permission..."** — the user tied to the token doesn't have the role permissions needed. Have them check the role for "REST Web Services" and "Log in using Access Tokens" permissions.
4. **`TBA not enabled`** — feature not enabled (Step 3).
5. **Wrong account ID format** — sandbox accounts look like `1234567_SB1`; the SuiteQL URL uses `-` instead of `_` (i.e., `1234567-sb1.suitetalk.api.netsuite.com`). The test script handles this substitution automatically as long as `NS_SB_ACCOUNT_ID` (or `NS_PROD_ACCOUNT_ID`) uses underscores.

**Diagnostic shortcut:** Before digging through values, check **`Setup > Users/Roles > User Management > View Login Audit Trail`** — filter to the user the token is bound to, look for a recent failure. **Empty trail = signature/realm failure (#1).** **Trail with detail = follow the detail (#2 or #3).** This 30-second check eliminates most guessing.

### If the RESTlet check fails

1. **`404 — endpoint not found`** — the customer's installed SuiteApp version predates the agent-write RESTlet (NS-926). Have them upgrade via **My SuiteApps**. Until that's done, `/run-poller` and any other agent-write skill will not work, but the rest of onboarding is unblocked.
2. **`INSUFFICIENT_PERMISSION — missing SuiteScript permission`** — the role on the token doesn't have `SuiteScript = Full`. Add it on the role's **Setup tab** (and add `SuiteScript Scheduling` while you're there — see `INTEGRATION-RECORD-SETUP.md` "Required role permissions"). No need to regenerate the token after editing the role.
3. **Other failure** — the script prints the raw response. If the RESTlet returned anything other than the expected "Unknown action" rejection, treat it like any other RESTlet failure and check the script execution log (Customization > Scripting > Script Deployments > "Orderful Agent Write" > Execution Log).

### If Orderful fails

1. **401 / 403 "Application with key ... not found"** — the API key is wrong or hasn't been provisioned for this org. Orderful has one global endpoint (`api.orderful.com`) and one global key per org, so there's no "sandbox vs. prod key" to mix up — if it's failing, the key is either typo'd or not issued yet. Re-check the value in `app.orderful.com` > Settings > API Keys for the right org, or ask the Orderful team.
2. **403 (other message)** — API key is recognized but lacks permission for the test endpoint. Escalate to the Orderful team.

## Step 6 — Confirm and summarize

Once all three validations pass:

- Confirm the customer directory path to the user.
- Note which connections are working.
- Offer next steps: "Want me to run the audit/inventory skill against this customer now, or are we done for today?"

Keep the summary short — the user already knows what they did.

## ISA conventions and test-injection prerequisites (FYI)

The five NetSuite credentials and the Orderful API key are everything this skill needs to validate. But there are two pieces of customer-record state that come up later — once you start running test injections from sandbox via the `inject-test-transaction` skill — and they're worth flagging during onboarding so the eventual setup is straightforward.

### Live vs test ISAs

Every Orderful trading-partner relationship has both a `liveIsaId` and a `testIsaId` per side (sender and receiver). By convention, the test ISA is the live ISA with a `T` or `QT` suffix:

| Live | Test |
|---|---|
| `4166619606` | `4166619606T` |
| `4253138601CH` | `4253138601CHQT` |
| `5146366668` | `5146366668T` |

**ISA collision** is when `liveIsaId === testIsaId` on a relationship — i.e., the customer (or their counterparty) hasn't bothered to set up a distinct test ISA. When this happens, the SuiteApp can't tell from the ISA alone whether an inbound transaction is LIVE or TEST. It still works (the SuiteApp falls back to the `stream`/`testmode` flag in the payload), but you've removed a layer of defense and made routing audits harder. Surface ISA collisions to the user during onboarding if you spot them.

### Customer-record fields

In the customer's NetSuite, two fields on the Customer (Sub-Customer) record carry the ISAs:

- `custentity_orderful_isa_id` — the **live** ISA. Always set during onboarding; the SuiteApp uses it for normal LIVE-stream traffic.
- `custentity_orderful_isa_id_test` — the **test** ISA. Often left blank or copied from the live field (which causes problems during sandbox testing).

**For sandbox test injections to work end-to-end, `custentity_orderful_isa_id_test` must match the relationship's `sender.testIsaId`.** If the values differ, the SuiteApp polls the test transaction successfully but fails to resolve it back to a NS customer — and the test fails for the wrong reason, which is hard to diagnose.

This isn't something the `netsuite-setup` skill writes — it's part of customer-record EDI configuration, handled by the `enable-customer` skill or via the SuiteApp UI. Just know that if you're about to run a test injection and the customer's test_isa is wrong, the inject-test-transaction skill will catch it and propose a fix.

### Polling-bucket pairs

Each Artika-style customer with separate sandbox and prod NetSuite instances has **two polling buckets** in Orderful — one per environment. The sandbox NS polls bucket A; the prod NS polls bucket B. They must be distinct, and TEST-stream traffic must route to the sandbox bucket — otherwise a TEST injection meant for sandbox can land in the prod NS via the prod bucket.

Per-receiver-account settings in Orderful determine which bucket TEST traffic goes to. When a customer has multiple receiver accounts (multiple subsidiaries — e.g., `Artika 4166 CA`, `Artika 5146 US`), each one's poller assignment is configured separately. It's easy to fix one and forget the others.

The `.env` template now includes optional `ORDERFUL_POLLING_BUCKET_SANDBOX` and `ORDERFUL_POLLING_BUCKET_PROD` fields. Capture both during onboarding when known — the inject-test-transaction skill uses them as a tripwire to abort if the test transaction lands in the prod bucket.

### When this matters for onboarding

You don't need to fill any of this in to validate credentials in Step 5. But if the user's stated goal is "set up so we can do test injections," gather:

- The relationship's test ISA on the partner side (e.g., for Costco → Artika 850, the sender testIsaId)
- The customer's `custentity_orderful_isa_id_test` value (and confirm it matches the above)
- Both polling bucket ids

Hand off to `enable-customer` for the customer-record wiring and `inject-test-transaction` for the actual test runs.
