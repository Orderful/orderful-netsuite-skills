---
name: run-poller
description: Trigger Orderful's inbound polling MapReduce in a NetSuite customer's account by calling the SuiteApp's run-poller RESTlet. Use when the user wants to manually pull pending inbound EDI transactions from Orderful into NetSuite without opening NetSuite to run the script deployment, or says things like "/run-poller", "run the poller for <customer>", "trigger inbound polling", "kick off the poller", "pull EDI transactions for <customer>", or "poll Orderful for <customer>".
---

# Run Inbound Poller

Triggers `customscript_orderful_inbound_mr` (the inbound polling MapReduce) in a customer's NetSuite by calling the SuiteApp's `customscript_orderful_run_poller_rl` RESTlet over TBA.

The polling MR pulls pending transactions from Orderful's polling bucket(s) into NetSuite. It runs on a 15-minute schedule by default; this skill is for ad-hoc triggers — after configuration changes, when debugging stuck transactions, during demos, or any time a contractor would otherwise open NetSuite to run the script deployment manually.

## When to use this skill

- "run the poller for cambridge-pavers"
- "I just changed the polling bucket — pull now"
- "trigger inbound polling for <customer>"
- "the customer says they're missing 850s — kick off the poller"
- "/run-poller"

## Inputs the skill needs

- **Customer slug** — which `~/orderful-onboarding/<slug>/` to use. Ask if not specified; list the available dirs.

That's it. The customer's `.env` (created by `/netsuite-setup`) supplies everything else.

## The recipe

### Step 1 — Pick the customer

List `~/orderful-onboarding/` and confirm which customer the user wants. If the dir has no `.env`, stop and direct the user to `/netsuite-setup`.

### Step 2 — Trigger the poller

Run the script:

```sh
node <path-to-this-skill>/run-poller.mjs ~/orderful-onboarding/<slug>
```

The script loads the customer's `.env`, picks `NS_SB_*` or `NS_PROD_*` based on `ENVIRONMENT`, TBA-signs a GET to the RESTlet URL, and prints the response.

### Step 3 — Read the result

A successful response looks like:

```json
{
  "status": "success",
  "taskId": "ABCDEF1234567",
  "mrStatus": "PENDING",
  "scriptId": "customscript_orderful_inbound_mr",
  "deploymentId": "customdeploy_orderful_inbound_mr"
}
```

- `taskId` is the NetSuite task scheduler ID for the running MapReduce
- `mrStatus` will be `PENDING`, `PROCESSING`, `COMPLETE`, or `FAILED` — `PENDING`/`PROCESSING` is normal; the task continues server-side after this skill returns

To verify execution, have the user check NetSuite: **Customization > Scripting > Script Deployments > "Orderful | Polling Inbound Transactions" > Execution Log**.

### Step 4 — Troubleshoot if needed

| Symptom | Likely cause | Fix |
|---|---|---|
| 4xx with `INVALID_LOGIN_INVALID_SCRIPT_ID` *or* `INVALID_LOGIN_ATTEMPT` on a `.env` already validated by `/netsuite-setup` | Customer's installed SuiteApp version is older than this RESTlet (most common cause for a brand-new endpoint). NetSuite returns either error code depending on the account. | Upgrade the SuiteApp via `My SuiteApps` to the version that includes [NS-926](https://orderful.atlassian.net/browse/NS-926); or fall back to running the MR manually (NetSuite UI: Customization > Scripting > Scheduled Script Status > New > pick `customscript_orderful_inbound_mr`) |
| `INVALID_LOGIN_ATTEMPT` *and* `/netsuite-setup` Step 5 also fails | Bad TBA credentials | Re-validate via `/netsuite-setup`; the Login Audit Trail diagnostic in that skill's Step 5 isolates which value is wrong |
| `INSUFFICIENT_PERMISSION` | Token's role can't trigger MapReduce tasks | Token role needs **REST Web Services** + script execution permissions; Administrator works out of the box |
| MR runs but processes 0 transactions | `custscript_orderful_polling_bucket` company-level script param is empty | Customization > Scripting > Scripts > "Orderful \| Polling Inbound Transactions" > Deployments > the deployment > script param values |

## Behaviour rules

1. **Never invoke the script without an explicit customer slug.** Ask the user which customer; don't pick one.
2. **Don't poll for completion in this skill.** The MR is asynchronous. Return the `taskId` and let the user check the Execution Log if they want completion confirmation.
3. **If the endpoint 404s, do not retry or guess.** Report the version-mismatch fix from Step 4 and stop. Don't fall back silently to a different deploy ID.
4. **Don't assume sandbox vs. production.** The script reads `ENVIRONMENT` from the `.env`. If the user expected production but the env says sandbox (or vice versa), ask before changing.
5. **One customer per invocation.** No batch mode. Each customer's TBA token is per-account; running across multiple customers needs multiple invocations and is the user's call to make sequentially.
6. **Don't paste TBA secrets into chat.** Everything stays in the `.env`; the script reads it locally.

## Reference material

- `customscript_orderful_inbound_mr` (the MR being triggered) — defined in `Objects/customscript_orderful_inbound_mr.xml` in the [netsuite-connector](https://github.com/Orderful/netsuite-connector) repo
- The `run-poller` RESTlet itself: [netsuite-connector#758](https://github.com/Orderful/netsuite-connector/pull/758) ([NS-926](https://orderful.atlassian.net/browse/NS-926))
- Polling docs: [docs.orderful.com — inbound poller](https://docs.orderful.com/docs/inbound-poller)
- NetSuite `N/task` module: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4623372451.html
