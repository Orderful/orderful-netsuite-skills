# SuiteCloud Development Framework (SDF) — setup + non-obvious gotchas

Reference for contractors moving from "upload scripts via NetSuite UI" to "manage scripts as code via the SuiteCloud CLI." Captures the non-obvious mechanics most onboardings stumble on. Procedure (which scripts to build, JSONata vs custom, etc.) stays in the relevant skill — this is factual lookup material.

## What SDF is

Oracle's framework for managing NetSuite customizations as files. SuiteScripts, custom fields, scripts, deployments, saved searches all become XML files on a laptop, and a CLI (`suitecloud`) syncs them to a target NS account. The local project is the source of truth; deploys are the round trip.

Three concrete CLI capabilities the rest of this doc assumes:

| Command | What it does | Touches NS? |
|---|---|---|
| `suitecloud project:create` | Scaffold a local SDF project structure | No |
| `suitecloud account:setup` | Bind the local project to an NS account via browser OAuth | Creates an authorized-app entry only |
| `suitecloud object:import` | Pull metadata from NS into local files (script records, deployments, custom records, saved searches) | Read-only |
| `suitecloud file:import` | Pull File Cabinet files to local | Read-only |
| `suitecloud project:validate` | Server-side validation of the local project against NS | Read-only |
| `suitecloud project:deploy --dryrun` | Preview of what a real deploy would change | Read-only |
| `suitecloud project:deploy` | Apply the local project to NS | **Writes** |
| `suitecloud project:adddependencies` | Auto-populate `manifest.xml` with missing SuiteApp object refs | No (local file edit) |

## Auth model: two separate credentials per customer

SDF uses **different auth than the rest of this skills repo**, and the two cannot be combined.

| Use case | Auth | Where creds live |
|---|---|---|
| REST/SuiteQL calls (all other skills here: `netsuite-setup`, `run-poller`, `enable-customer`, etc.) | **TBA** (consumer key/secret + token ID/secret) | `~/orderful-onboarding/<slug>/.env` |
| SDF deploys (`suitecloud project:deploy`, `object:import`, etc.) | **OAuth 2.0 browser-based** (`suitecloud account:setup -i`) OR **OAuth 2.0 certificate-based** (`account:setup:ci` for headless/CI) | `~/.suitecloud-sdk/credentials` |

**Roles also split.** The TBA token is tied to whichever NS user + role generated it. The OAuth flow uses whatever role the user picks when logging into NS in the browser tab. These can be different roles for the same customer:

- TBA role needs: `Log in using Access Tokens`, `REST Web Services`, `SuiteScript`, `SuiteScript Scheduling`, `Custom Record Entries` (per `INTEGRATION-RECORD-SETUP.md`).
- OAuth role needs: `SuiteCloud Development Framework` (Setup tab, Full). Administrator has this by default; custom roles often don't.

For SDF specifically, the v3.1+ CLI's `account:setup:ci` (non-interactive) accepts **certificate-based** auth only — there's no flag to feed it the TBA token. The interactive `account:setup -i` is required for browser-based OAuth. Plan accordingly: SDF setup is a one-time interactive step that can't be fully automated unless you're using cert auth.

## NS-side prerequisites

Three features need to be enabled in the target account before SDF will work. Setup → Company → Enable Features → **SuiteCloud** tab:

| Feature | Why |
|---|---|
| `Token-Based Authentication` | TBA for the `.env` REST/SuiteQL workflow |
| `REST Web Services` | Same |
| `SuiteCloud Development Framework` | The SDF deploy gate. Easy to miss — not enabled by default on all account types. |

Without the SDF feature, browser OAuth completes but every `project:validate` / `project:deploy` returns `INSUFFICIENT_PERMISSION`. If `account:setup` succeeded but validate fails this way, check this feature first.

## Manifest essentials

Every SDF project has a `src/manifest.xml`. The default from `project:create` is bare; real projects need feature dependencies and (almost always) SuiteApp object dependencies.

### Feature dependencies

If the project contains any MapReduce or other server-side script:

```xml
<dependencies>
  <features>
    <feature required="true">SERVERSIDESCRIPTING</feature>
    <feature required="false">CREATESUITEBUNDLES</feature>
  </features>
</dependencies>
```

Without `SERVERSIDESCRIPTING`, local validation fails with `When the SuiteCloud project contains a "mapreducescript", the manifest must define the "SERVERSIDESCRIPTING" feature as required`. The `CREATESUITEBUNDLES` feature suppresses warnings about `bundleable` / `hideinbundle` XML attributes that the CLI emits during `object:import`.

### Object dependencies (SuiteApp refs)

Scripts and saved searches that reference SuiteApp-owned records (e.g., `customrecord_orderful_transaction`, `customlist_orderful_transaction_status`) need those references declared in the manifest under `<applications>`. The CLI auto-resolves them:

```sh
suitecloud project:adddependencies
```

This scans the project, finds every unresolved cross-application reference, and inserts entries like:

```xml
<applications>
  <application id="com.orderful.orderfulnetsuite">
    <objects>
      <object>customrecord_orderful_transaction</object>
      <object>customrecord_orderful_transaction.custrecord_ord_tran_status</object>
      <object>customlist_orderful_transaction_status</object>
      ...
    </objects>
  </application>
</applications>
```

Run `adddependencies` whenever validate complains about missing object references — typically after the first `object:import` of scripts that touch the SuiteApp's data model.

## `deploy.xml` — scoping the blast radius

By default `project:create` ships a `deploy.xml` with wildcards that include the whole project on every deploy:

```xml
<deploy>
  <files><path>~/FileCabinet/*</path></files>
  <objects><path>~/Objects/*</path></objects>
</deploy>
```

For broad migrations this is fine. For a targeted fix — e.g. updating one script parameter on one deployment — temporarily narrow it:

```xml
<deploy>
  <files>
    <path>~/FileCabinet/SuiteScripts/Orderful/&lt;prefix&gt;/&lt;script&gt;.js</path>
  </files>
  <objects>
    <path>~/Objects/customscript_&lt;prefix&gt;_&lt;doc&gt;.xml</path>
    <path>~/Objects/customsearch_&lt;prefix&gt;_&lt;doc&gt;.xml</path>
  </objects>
</deploy>
```

Pattern: back up the original (`cp src/deploy.xml src/deploy.xml.bak`), narrow it, dryrun, deploy, then restore. This keeps the local snapshot whole-project while limiting any single write to NS.

Note: if you narrow too far, validate fails with `The file reference ... is missing in the project and also not included in the dependencies list`. Include every file or object referenced by what you're deploying.

## Migration pattern — snapshot existing manual uploads under SDF

When a customer's scripts were uploaded to File Cabinet manually (no SDF history), bringing them under SDF management is a sequence of read-only imports:

1. **Inventory what's live in NS.** SuiteQL against `script`, `scriptdeployment`, and `customfield` (per-type) tables, filtered to the customer's namespace. Catches both scripts that have Script Records and stray .js files that don't.
2. **`object:import` the script records** (one CLI call can take multiple `--scriptid` values). For ACP projects the CLI auto-pulls the .js files declared as `scriptfile` on each script. Lib files referenced via runtime `require()` are NOT auto-pulled — they need a separate `file:import`.
3. **`file:import` for files without script records** — anything in File Cabinet that's not declared on a Script Record (libs, helper modules, JSON config). Use full File Cabinet paths.
4. **`object:import` for saved searches** the deployments reference, if those searches exist. Use `--type savedsearch`.
5. **`project:adddependencies`** to populate SuiteApp object refs in `manifest.xml`.
6. **`project:validate` + `project:deploy --dryrun`** to confirm the snapshot round-trips cleanly. Both being green proves the project mirrors NS — a real deploy from this state would be a no-op for everything you imported.

After this, future changes flow through: edit local → narrow `deploy.xml` → dryrun → deploy → verify by re-`object:import` and grep.

## Common gotchas

- **`INSUFFICIENT_PERMISSION` on the agent-write RESTlet** is more often a deployment-audience misconfig than a role-permission gap, even when the role is Administrator. See [`skills/netsuite-setup/SKILL.md`](../skills/netsuite-setup/SKILL.md) "If the RESTlet check fails" for the SuiteQL diagnostic.
- **Importing the same scriptid twice overwrites the local file.** No prompt, no `--no-clobber` flag. If you've hand-edited a local XML and want to compare it to NS, import to a separate `destinationfolder` and diff.
- **Custom record fields are imported piecewise.** `customrecord_X.custrecord_Y` shows up as its own dependency entry; if you only import the parent record and not its custom fields, validate may flag missing refs.
- **Saved-search XML is hard to hand-write** (formula fields, criteria expressions). Always import from a search that was created in NS UI; don't try to author from scratch.
- **`object:import` and `file:import` don't write to NS.** Safe to run anytime, including in prod accounts, including while another contractor is editing the same scripts in NS UI. Worst case the local snapshot is stale until the next import.
- **`project:deploy` writes to NS.** Always run `--dryrun` first. The dryrun's "DEPLOYMENT PREVIEW" lists every object that would be touched, even no-ops where local matches NS.
- **The `aidescription` validation warning** (CLI v3.1.x) is harmless — NS exposes an AI-description field that older CLI versions don't model. Goes away on CLI upgrade.

## Reference

- [SuiteCloud CLI for Node — Oracle docs](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157379087687.html) — full CLI command reference.
- [`skills/netsuite-setup/SKILL.md`](../skills/netsuite-setup/SKILL.md) — TBA credentials, the `.env` workflow, the RESTlet audience-trap diagnostic.
- [`skills/netsuite-setup/INTEGRATION-RECORD-SETUP.md`](../skills/netsuite-setup/INTEGRATION-RECORD-SETUP.md) — Integration Record + access token creation, required role permissions on the TBA side.
- [`skills/custom-process-transactions/SKILL.md`](../skills/custom-process-transactions/SKILL.md) — the canonical custom-process shape; rule #7 there says "don't auto-deploy" because the skill itself doesn't, but `suitecloud project:deploy` is the path when you're ready.
