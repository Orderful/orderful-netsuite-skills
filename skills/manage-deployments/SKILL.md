---
name: manage-deployments
description: Inspect and retune the Orderful SuiteApp's own script deployments in a customer's NetSuite — schedule status, Repeat cadence, Start Time, Log Level, Deployed — and submit a deployment for an immediate run. Use when the poller or a map/reduce isn't running, when a cadence needs changing for a backfill or a demo, when checking whether a customer's install is complete, or when the user says "/manage-deployments", "is the poller scheduled for <customer>", "set the poller to every 5 minutes", "turn off the outbound sending MR", "what script deployments does <customer> have", "why isn't the consolidation MR running", or "schedule the transaction processor".
---

# Manage Script Deployments

Reads and changes the scheduling state of the deployments the Orderful SuiteApp ships, through the agent RESTlets (`customscript_orderful_agent_read_rl` / `_write_rl`) over TBA. Four commands: `list`, `describe`, `set`, `run`.

This is the lever behind every conversation that used to end with "open their NetSuite and go to Customization > Scripting > Script Deployments".

## What NetSuite lets you change, and what it doesn't

This is the part to internalise before promising a customer anything. The SuiteScript `scriptdeployment` record exposes 21 fields — a strict subset of what SDF's `<recurrence>` block can express. Verified against the Records Browser (2025.1) and by probing the `scriptdeployment` analytics table on a live account:

| Lever                                               | This skill         | SuiteQL can read it | Why                                                                        |
| --------------------------------------------------- | ------------------ | ------------------- | -------------------------------------------------------------------------- |
| `status` — Scheduled / Not Scheduled / Testing      | yes                | yes                 | on the record                                                              |
| `recurrenceminutes` — the "Repeat" cadence          | yes                | **no**              | on the record, absent from the analytics table                             |
| `starttime` — Start Time                            | yes                | **no**              | same                                                                       |
| `isdeployed` — the Deployed checkbox                | yes                | yes                 | on the record                                                              |
| `loglevel`                                          | yes                | yes                 | on the record                                                              |
| Start Date, every-N-days, weekly/monthly patterns   | **no**             | no                  | SDF/UI only — not on the SuiteScript record at all                         |
| Concurrency limit, buffer size, yield-after-minutes | **no** (read-only) | yes                 | readable via SuiteQL, not writable from script                             |
| Script parameter values (`custscript_*`)            | **no**             | —                   | most Orderful params are company-level; use the SPA or `/set-feature-flag` |

Two consequences that shape how you use this:

1. **`list` cannot show cadence.** `recurrenceminutes` is not a column on the `scriptdeployment` table. Only `describe`, which loads the record server-side, can report Repeat and Start Time. So: `list` to find the deployment, `describe` to see its schedule.
2. **"Run every 15 minutes starting Tuesday" is two different asks.** The interval is yours; the start date is not. If someone needs the calendar pattern changed, that is an SDF change in the SuiteApp or a manual edit in their NetSuite UI — say so rather than half-doing it.

## Script IDs are not unique — always pass both

Every command takes `<scriptId> <deploymentId>`, and both are required. Deployment script ids are unique **per script**, not per account. A probe of one live account found `customdeploy1` on 25 different scripts, two of them Orderful's (`customscript_orderful_bulk_unpack_mr` and `customscript_orderful_outboundrunctrl_mr`). A deployment id on its own does not identify anything.

## The recipe

### Step 1 — Pick the customer

List `~/orderful-onboarding/` and confirm which customer. If the dir has no `.env`, stop and direct the user to `/netsuite-setup`.

Check `ENVIRONMENT` in that `.env` before any `set` or `run`. Changing a schedule in production is a production change.

### Step 2 — List what's there

```bash
node skills/manage-deployments/manage-deployments.mjs list ~/orderful-onboarding/<slug>
```

Shows the deployments with a schedule. `--all` widens to user event, workflow action, client and suitelet deployments (useful when auditing an install, useless for scheduling).

The output also names any deployment the SuiteApp ships that **this account does not have**. That is a real signal: the customer is on an older SuiteApp version, or an install failed partway. Cross-check against [`project_suiteapp_failed_installs`](https://github.com/Orderful/netsuite-connector) history before assuming it's benign.

**Fallback behaviour:** if the account's SuiteApp predates this feature, `list` automatically falls back to plain SuiteQL and says so. The fallback is scoped by scriptid prefix rather than by the SuiteApp's generated config, so it also shows the agent RESTlets themselves — handy for confirming whether the endpoint is installed at all. `describe`, `set` and `run` have no fallback and will tell you to use the NetSuite UI.

### Step 3 — Describe the one you care about

```bash
node skills/manage-deployments/manage-deployments.mjs describe ~/orderful-onboarding/<slug> \
  customscript_orderful_inbound_mr customdeploy_orderful_inbound_mr
```

Returns current `status` / `recurrenceminutes` / `starttime` / `isdeployed` / `loglevel`, the **select options NetSuite will accept for each in that account**, and the last five runs from `scheduledscriptinstance`.

Read the select options before setting `--repeat`. They are read at runtime rather than hardcoded, because the menu varies by account — and if NetSuite refuses to enumerate them from a server-side load, the output says so explicitly instead of offering a guessed list.

The run history answers the question `status = SCHEDULED` does not: _is this thing actually running?_ A deployment can be Scheduled and have no instance in weeks.

### Step 4 — Change it

```bash
# Schedule the poller every 15 minutes
node skills/manage-deployments/manage-deployments.mjs set ~/orderful-onboarding/<slug> \
  customscript_orderful_inbound_mr customdeploy_orderful_inbound_mr \
  --status=SCHEDULED --repeat=15

# Stop a map/reduce
node skills/manage-deployments/manage-deployments.mjs set ~/orderful-onboarding/<slug> \
  customscript_orderful_outbound_sending customdeploy_orderful_status_send_deploy \
  --status=NOTSCHEDULED
```

Options: `--status`, `--repeat=<minutes>`, `--start-time="7:00 am"`, `--log-level`, `--deployed=true|false`.

The RESTlet re-reads the record after saving and reports a before/after for every field. **If a field comes back unchanged, the command exits non-zero and says so.** That case is real: a publisher-locked deployment can accept the `setValue`, accept the `save`, and keep the prior value. Without the re-read you would report success on a change that never happened.

### Step 5 — Run one on demand

```bash
node skills/manage-deployments/manage-deployments.mjs run ~/orderful-onboarding/<slug> \
  customscript_orderful_transaction_mr customdeploy_orderful_transaction_mr
```

Only map/reduce and scheduled deployments can be submitted; anything else is refused with the reason. Returns a `taskId` — hand it to [monitor-mr](../monitor-mr/SKILL.md) rather than polling here.

For the inbound poller specifically, [run-poller](../run-poller/SKILL.md) still works on older SuiteApp versions, because it uses the long-standing `triggerInboundPolling` action instead.

### Required role permissions

Same as [run-poller](../run-poller/SKILL.md): on **Setup > Users/Roles > Manage Roles > [role] > Permissions > Setup**, the token's role needs **Log in using Access Tokens** = Full, **REST Web Services** = Full, **SuiteScript** = Full, and **SuiteScript Scheduling** (row only, no level) for `run`.

On SuiteApp versions before 1.25.0 the agent RESTlets reject Administrator outright — their audience is `customrole_orderful_agent_writer` only, and you get `INSUFFICIENT_PERMISSION` from the platform before the script runs. Bind the token to that role.

### Troubleshooting

| Symptom                                          | Cause                                                        | Fix                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `list` prints "(via SuiteQL …)"                  | The account's SuiteApp has no `listScriptDeployments` action | Expected on older versions. `describe`/`set`/`run` are unavailable; use the NetSuite UI or upgrade |
| `describe`/`set`/`run` fail with "no ... action" | Same version gap                                             | NetSuite UI: Customization > Scripting > Script Deployments                                        |
| `INSUFFICIENT_PERMISSION` before any of our JSON | Platform-level rejection — the call never reached our code   | Role audience (see above), not attribution                                                         |
| "is not an Orderful SuiteApp deployment"         | The pair isn't in the SuiteApp's generated script config     | This surface only manages deployments the SuiteApp ships. Run `list` for the inventory             |
| "Unsupported field(s): concurrencylimit"         | Asking for an SDF/UI-only field                              | See the table at the top — those need an SDF deploy or a UI edit                                   |
| "has no schedule"                                | Targeting a user event / workflow action / client deployment | Only map/reduce and scheduled deployments have a Schedule tab                                      |
| WARNING: NetSuite kept the prior value           | Publisher-locked field                                       | Change it in the NetSuite UI, or ship it via SDF in the SuiteApp                                   |
| "is not installed in this account"               | Deployment exists in the SuiteApp but not in this account    | Older SuiteApp version, or a partial install — check `list`'s missing section                      |

## Behaviour rules

1. **Never run `set` or `run` without an explicit customer slug.** Ask; don't pick one.
2. **`describe` before `set`.** You need the current value to say what you changed, and the select options to pick a legal `--repeat`.
3. **Confirm before any `set` against `ENVIRONMENT=production`.** Turning off a scheduled deployment stops EDI processing for that customer; state exactly which deployment and which field, and wait for a yes.
4. **`--deployed=false` is not a pause button.** It un-deploys the script entirely, which for a user event deployment silently stops SuiteApp processing on that record type. Use `--status=NOTSCHEDULED` to stop a schedule.
5. **Report `unchanged` fields as a failure, not a footnote.** If the save didn't persist, the customer's schedule is still whatever it was.
6. **Don't poll for completion after `run`.** Return the `taskId` and follow through with [monitor-mr](../monitor-mr/SKILL.md).
7. **Don't paste TBA secrets into chat.** Everything stays in the customer's `.env`.

## Reference material

- Agent RESTlets: `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/ConfigAndUISupport/orderful_agentRead_RL.ts` and `orderful_agentWrite_RL.ts` in [netsuite-connector](https://github.com/Orderful/netsuite-connector). Actions used here: `listScriptDeployments`, `describeScriptDeployment`, `setScriptDeployment`, `runScriptDeployment`
- Handler module: `TransactionHandling/common/deployment.handlers.ts` — the allowlist, the field table, and the post-save verification live there
- NetSuite Records Browser, Script Deployment: the authoritative field list (21 fields) — https://system.netsuite.com/help/helpcenter/en_US/srbrowser/Browser2025_1/script/record/scriptdeployment.html
- [reference/mapreduce-monitoring.md](../../reference/mapreduce-monitoring.md) — reading what a run actually did
- [reference/script-execution-map.md](../../reference/script-execution-map.md) — which script owns which part of the flow
