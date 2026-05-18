---
name: set-feature-flag
description: Read or set Orderful SuiteApp feature flags in a customer's NetSuite account. The SuiteApp gates opt-in behaviors (e.g., disabling the Sales Order reload+resave on inbound 850 creation, switching to the new invoice line item repository) on a singleton custom record `customrecord_orderful_feature_flags`. Use when the user wants to flip a SuiteApp feature flag without opening NetSuite, or says things like "/set-feature-flag", "set the <flag> feature flag for <customer>", "disable the SO resave for <customer>", "enable the new invoice line item repository for <customer>", "what feature flags are set on <customer>", or "turn on <flag> in <customer> prod".
---

# Set SuiteApp Feature Flag

The Orderful NetSuite SuiteApp gates a small number of opt-in behaviors behind feature flags stored in a single custom record per account: `customrecord_orderful_feature_flags`. The flags themselves live in one CLOBTEXT field (`custrecord_orderful_feature_flags`) as a JSON object of booleans. A user-event script enforces that only one record may exist per account.

This skill reads or replaces that JSON over TBA — no NetSuite UI required.

## When to use this skill

- "set the SO resave feature flag for <customer> in prod"
- "disable the Sales Order reload-and-resave on <customer>"
- "turn on the new invoice line item repository feature flag for <customer>"
- "what feature flags are set on <customer>?"
- "/set-feature-flag"

## Inputs the skill needs

- **Customer slug** — which `~/orderful-onboarding/<slug>/` to use. Ask if not specified; list the available dirs.
- **Flag name(s) and target value(s)** — confirm the exact key from the table below before writing. If the user gives a colloquial name ("the resave one"), repeat the canonical key back to them.
- **Sandbox vs. production** — the script reads `ENVIRONMENT` from the customer's `.env`. If the user named one but the env points to the other, ask before proceeding.

## Known feature flags

Source of truth: `Models/feature_flag.ts` in the [netsuite-connector](https://github.com/Orderful/netsuite-connector) repo (enum `FeatureFlagName`). If a flag the user names isn't in this table, re-check the enum before assuming it doesn't exist.

| Key | What it does |
|---|---|
| `isSalesOrderReloadAndResaveDisabled` | Opt-in to skip the post-create reload+resave step on Sales Orders generated from inbound 850s. Useful when downstream automations (workflows, third-party scripts) misbehave on the second save. |
| `isInvoiceLineItemRepositoryEnabled` | Opt-in to the new invoice line item repository implementation for outbound 810/880 generation. |

Unset keys default to `false` via `FeatureFlags.isEnabled()` — only flags explicitly set to `true` in the JSON are enabled.

## The recipe

### Step 1 — Pick the customer and confirm the target environment

List `~/orderful-onboarding/` and confirm which customer the user wants. If the dir has no `.env`, stop and direct the user to `/netsuite-setup`. Read the `.env`'s `ENVIRONMENT` value and confirm it matches what the user expects (sandbox vs. production).

### Step 2 — Read current flags first

Always read before writing — it shows whether a record already exists, what flags are already set, and confirms the TBA credentials work:

```sh
node <path-to-this-skill>/set-feature-flag.mjs ~/orderful-onboarding/<slug>
```

Output:

```
Account: 1234567 (production)
Current: id=1 flags={"isSalesOrderReloadAndResaveDisabled":true}
```

…or `Current: no record` if the account has never had a feature flag set.

### Step 3 — Confirm the desired full JSON with the user

The write is a full replacement of the JSON blob, not a partial merge. Show the user the exact JSON you intend to write — including any keys you're preserving from the current state — and get explicit confirmation before running with `--set`. Production confirmations are mandatory; sandbox is also worth confirming for anything other than experimentation.

### Step 4 — Write

```sh
node <path-to-this-skill>/set-feature-flag.mjs ~/orderful-onboarding/<slug> --set '{"isSalesOrderReloadAndResaveDisabled":true}'
```

The script:
1. Reads existing record via SuiteQL.
2. PATCHes the row if one exists; POSTs a new row otherwise.
3. Re-queries and prints the post-write state.

Successful write returns HTTP 204 (PATCH) or 204 with a `Location` header pointing to `.../customrecord_orderful_feature_flags/<id>` (POST).

### Step 5 — Verify

Confirm the script's "After:" line matches your intended JSON. Optionally cross-check in NetSuite: **Customization > Lists, Records, & Fields > Record Types > "Orderful Feature Flags" > List** — there should be exactly one row with the JSON in the Feature Flags field.

### Required role permissions

The token's role needs:

- **Log in using Access Tokens** = Full
- **REST Web Services** = Full
- **Custom Record Entries** with at least Edit on the `Orderful Feature Flags` record type (Administrator has this by default)

If the role doesn't, the PATCH/POST returns `INSUFFICIENT_PERMISSION`.

### Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `Only one Orderful Feature Flags record allowed.` on POST | A record already exists; the user-event script blocks creating a second | The script handles this automatically — it PATCHes when a record is present. If you see this error, you bypassed the helper or hit a race condition; re-run via the helper. |
| `Could not parse JSON in feature flags field` on PATCH/POST | The JSON you passed to `--set` isn't a valid JSON object | The helper validates locally before sending. If NetSuite rejects, re-check that the value is an object (e.g., `{"foo":true}`), not a string or array. |
| `INSUFFICIENT_PERMISSION` | Token's role can't edit the record type | Add Edit permission on the `Orderful Feature Flags` custom record (Administrator already has it). |
| Unknown flag key has no effect | Keys outside `FeatureFlagName` enum are filtered out at read time by the SuiteApp | Confirm the key exists in `Models/feature_flag.ts`; typos silently no-op. |
| Read returns `no record` after a successful write | NetSuite indexer lag on SuiteQL | Wait ~5 seconds and re-run the read; the record exists (the POST returned 204 with a Location). If still missing after a minute, check the UI to confirm. |

## Behaviour rules

1. **Always read before writing.** Never skip Step 2 — it surfaces existing flags you'd otherwise overwrite to `false` by omission.
2. **Confirm the full JSON with the user before writing.** The write replaces the entire blob; if the user only mentions one flag but another is already set, ask whether to preserve it or clear it. Show the literal JSON you'll send.
3. **Confirm prod writes explicitly.** Even if the user said "in prod" earlier, repeat the account ID and target JSON back before running with `--set`.
4. **Don't invent flag names.** If the user names a flag not in the table above, check `Models/feature_flag.ts` in the netsuite-connector repo. If still missing, stop — typos silently no-op at runtime, which masks the bug.
5. **One customer per invocation.** The `.env` is per-account; no batch mode.
6. **Don't paste TBA secrets into chat.** Everything stays in the customer's `.env`.
7. **Don't edit the record in the NetSuite UI in parallel with this helper.** The user-event script's singleton check is enforced at create-time only; concurrent edits to the JSON field can race.

## Reference material

- Flag definitions: `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/Models/feature_flag.ts` in the [netsuite-connector](https://github.com/Orderful/netsuite-connector) repo
- Custom record definition: `Objects/customrecord_orderful_feature_flags.xml`
- Singleton-enforcing user event script: `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/TransactionHandling/orderful_feature_flag_UE.ts`
- Repository (read path): `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/Repositories/feature_flag.repository.ts`
