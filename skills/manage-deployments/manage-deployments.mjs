#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.
//
// Read and retune the Orderful SuiteApp's own script deployments in a
// customer's NetSuite account.
//
// `list` works on every account with TBA, because it can fall back to plain
// SuiteQL when the installed SuiteApp predates the RESTlet actions. `describe`,
// `set` and `run` need the agent RESTlets: cadence (`recurrenceminutes`) and
// start time are not SuiteQL columns, and writes need a server-side
// record.load/save.

import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import OAuth from "oauth-1.0a";
import crypto from "node:crypto";
import { userInfo as osUserInfo } from "node:os";

const READ_SCRIPT = "customscript_orderful_agent_read_rl";
const READ_DEPLOY = "customdeploy_orderful_agent_read_rl";
const WRITE_SCRIPT = "customscript_orderful_agent_write_rl";
const WRITE_DEPLOY = "customdeploy_orderful_agent_write_rl";

const USAGE = `Usage:
  manage-deployments.mjs list     <customer-dir> [--all]
  manage-deployments.mjs describe <customer-dir> <scriptId> <deploymentId>
  manage-deployments.mjs set      <customer-dir> <scriptId> <deploymentId> [options]
  manage-deployments.mjs run      <customer-dir> <scriptId> <deploymentId>

set options (at least one required):
  --status=SCHEDULED|NOTSCHEDULED|TESTING   schedule the deployment, or stop it
  --repeat=<minutes>                        "Repeat" cadence; must be one of the
                                            values describe reports for it
  --start-time="7:00 am"                    Start Time
  --log-level=DEBUG|AUDIT|ERROR|EMERGENCY
  --deployed=true|false                     the Deployed checkbox

Both scriptId and deploymentId are required everywhere. Deployment script ids
are unique per script, not per account — 'customdeploy1' alone is ambiguous and
matches two different Orderful scripts.`;

const [command, customerDir, ...rest] = process.argv.slice(2);

if (!command || !customerDir) {
  console.error(USAGE);
  process.exit(2);
}
if (!["list", "describe", "set", "run"].includes(command)) {
  console.error(`Unknown command '${command}'.\n\n${USAGE}`);
  process.exit(2);
}

const envPath = resolve(customerDir, ".env");
if (!existsSync(envPath)) {
  console.error(`No .env found at ${envPath}. Run /netsuite-setup first.`);
  process.exit(2);
}
loadEnv({ path: envPath });

const envMode = (process.env.ENVIRONMENT || "sandbox").toLowerCase();
if (envMode !== "sandbox" && envMode !== "production") {
  console.error(
    `ENVIRONMENT must be "sandbox" or "production" (got "${envMode}")`,
  );
  process.exit(2);
}
const nsPrefix = envMode === "production" ? "NS_PROD" : "NS_SB";

const PLACEHOLDER = /^<\s*paste\s*here\s*>$/i;
const missing = [
  "ACCOUNT_ID",
  "CONSUMER_KEY",
  "CONSUMER_SECRET",
  "TOKEN_ID",
  "TOKEN_SECRET",
]
  .map((suffix) => `${nsPrefix}_${suffix}`)
  .filter((key) => {
    const value = process.env[key];
    return !value || value.trim() === "" || PLACEHOLDER.test(value.trim());
  });
if (missing.length > 0) {
  console.error(`Missing or unfilled env vars for ENVIRONMENT=${envMode}:`);
  missing.forEach((key) => console.error(`  - ${key}`));
  process.exit(2);
}

const accountId = process.env[`${nsPrefix}_ACCOUNT_ID`];
// Sandbox/RP account ids use underscores (1234567_SB1) but hyphens in hosts.
const urlHost = accountId.replace(/_/g, "-").toLowerCase();

const oauth = new OAuth({
  consumer: {
    key: process.env[`${nsPrefix}_CONSUMER_KEY`],
    secret: process.env[`${nsPrefix}_CONSUMER_SECRET`],
  },
  signature_method: "HMAC-SHA256",
  hash_function(baseString, key) {
    return crypto.createHmac("sha256", key).update(baseString).digest("base64");
  },
});
const token = {
  key: process.env[`${nsPrefix}_TOKEN_ID`],
  secret: process.env[`${nsPrefix}_TOKEN_SECRET`],
};

function signedHeaders(url, method) {
  const header = oauth.toHeader(oauth.authorize({ url, method }, token));
  header.Authorization += `, realm="${accountId}"`;
  return { ...header, "Content-Type": "application/json" };
}

// Both values land in NetSuite's audit trail. NetSuite's own audit attributes
// the call to the integration user, so these are what record which human
// actually asked for the change. The fallback is deliberately not a
// plausible-looking email — a guessed one would pin your writes on somebody
// else, permanently.
function agentAttribution(planLabel) {
  const authorizedBy =
    process.env.AGENT_AUTHORIZED_BY?.trim() || `cli:${osUserInfo().username}`;
  const customer = process.env.CUSTOMER_SLUG?.trim() || "unknown-customer";
  const agentPlanId =
    process.env.AGENT_PLAN_ID?.trim() ||
    `${planLabel}-${customer}-${new Date().toISOString().slice(0, 10)}`;
  return { authorizedBy, agentPlanId };
}

async function callRestlet(kind, payload) {
  const [script, deploy] =
    kind === "read" ? [READ_SCRIPT, READ_DEPLOY] : [WRITE_SCRIPT, WRITE_DEPLOY];
  const url = `https://${urlHost}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${script}&deploy=${deploy}`;

  const res = await fetch(url, {
    method: "POST",
    headers: signedHeaders(url, "POST"),
    body: JSON.stringify({ ...payload, ...agentAttribution(`deployments`) }),
  });
  const text = await res.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { res, body, url };
}

async function runSuiteQL(q) {
  const url = `https://${urlHost}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...signedHeaders(url, "POST"), Prefer: "transient" },
    body: JSON.stringify({ q }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `SuiteQL failed (HTTP ${res.status}): ${
        body["o:errorDetails"]?.[0]?.detail ??
        JSON.stringify(body).slice(0, 300)
      }`,
    );
  }
  return body.items ?? [];
}

const bodyText = (body) =>
  typeof body === "string" ? body : JSON.stringify(body);

const isMissingEndpoint = (res, body) =>
  res.status === 404 ||
  bodyText(body).includes("SSS_INVALID_SCRIPTLET_ID") ||
  bodyText(body).includes("INVALID_LOGIN_INVALID_SCRIPT_ID");

const isUnknownAction = (body) =>
  typeof body === "object" && body?.message === "Unknown action";

function fail(message, detail) {
  console.error(`FAIL: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const customerLabel =
  process.env.CUSTOMER_NAME || process.env.CUSTOMER_SLUG || customerDir;
console.log(
  `${customerLabel} (ENVIRONMENT=${envMode}, account ${accountId})\n`,
);

// ---------------------------------------------------------------- list ----

/**
 * SuiteQL fallback for accounts whose SuiteApp predates listScriptDeployments.
 *
 * Deliberately matches on `s.scriptid LIKE 'customscript_orderful%'` rather
 * than an allowlist the CLI carries: a hardcoded list here would drift from
 * whatever version the customer actually has installed, and the prefix is what
 * the SuiteApp's own object ids use. Cadence is absent because
 * `recurrenceminutes` is not a column on this table at all — that is a NetSuite
 * limit, not a shortcut.
 */
async function listViaSuiteQL(all) {
  const scheduleFilter = all
    ? ""
    : "AND s.scripttype IN ('MAPREDUCE', 'SCHEDULED')";

  const rows = await runSuiteQL(`
    SELECT
      s.scriptid AS script_id,
      s.scripttype,
      sd.scriptid AS deployment_id,
      sd.title,
      BUILTIN.DF(sd.status) AS status,
      sd.isdeployed,
      sd.loglevel,
      sd.concurrencylimit
    FROM scriptdeployment sd
    JOIN script s ON s.id = sd.script
    WHERE LOWER(s.scriptid) LIKE 'customscript_orderful%' ${scheduleFilter}
    ORDER BY s.scriptid, sd.scriptid
  `);

  console.log(
    "(via SuiteQL — the SuiteApp has no listScriptDeployments action)",
  );
  console.log(
    "Cadence is not shown: recurrenceminutes is not a SuiteQL column.",
  );
  // The RESTlet path is scoped by CustomScriptConfigs, which has no restlet
  // entries; this one matches on the scriptid prefix, so it also surfaces the
  // agent RESTlets themselves. That is a feature on a read — it tells you
  // whether the endpoint you just failed to reach is even installed.
  console.log(
    "Scope differs from the RESTlet path: this matches on the scriptid prefix,\n" +
      "so it also shows the agent RESTlets (which the write surface cannot touch).\n",
  );

  for (const row of rows) {
    console.log(
      `${row.script_id}/${row.deployment_id}\n` +
        `    ${row.title ?? "(untitled)"}  [${row.scripttype}]\n` +
        `    status=${row.status}  deployed=${row.isdeployed}  log=${row.loglevel ?? "-"}  concurrency=${row.concurrencylimit ?? "-"}`,
    );
  }
  console.log(
    `\n${rows.length} Orderful deployment(s)${all ? "" : " with a schedule (pass --all for the rest)"}.`,
  );
}

async function doList() {
  const all = rest.includes("--all");
  const { res, body } = await callRestlet("read", {
    action: "listScriptDeployments",
    schedulableOnly: !all,
  });

  if (isMissingEndpoint(res, body) || isUnknownAction(body)) {
    await listViaSuiteQL(all);
    return;
  }
  if (body?.status !== "success") {
    fail("listScriptDeployments failed", bodyText(body).slice(0, 1000));
  }

  const { deployments, missing: absent } = body.data;

  for (const d of deployments) {
    console.log(
      `${d.scriptId}/${d.deploymentId}\n` +
        `    ${d.title ?? "(untitled)"}  [${d.scriptType}]\n` +
        `    status=${d.status}  deployed=${d.isDeployed}  log=${d.logLevel ?? "-"}` +
        `  concurrency=${d.concurrencyLimit ?? "-"}  yield=${d.yieldAfterMins ?? "-"}m`,
    );
  }

  console.log(
    `\n${deployments.length} deployment(s)${all ? "" : " with a schedule (pass --all for the rest)"}.`,
  );
  console.log(
    "Cadence is per-deployment: run `describe` for Repeat / Start Time.",
  );

  if (absent.length > 0) {
    console.log(
      `\n${absent.length} deployment(s) the SuiteApp ships but this account does NOT have —` +
        " an older SuiteApp version, or a partial install:",
    );
    absent.forEach((d) => console.log(`  - ${d.scriptId}/${d.deploymentId}`));
  }
}

// ------------------------------------------------------------ describe ----

async function doDescribe() {
  const [scriptId, deploymentId] = rest.filter((a) => !a.startsWith("--"));
  if (!scriptId || !deploymentId) {
    console.error(USAGE);
    process.exit(2);
  }

  const { res, body } = await callRestlet("read", {
    action: "describeScriptDeployment",
    scriptId,
    deploymentId,
  });

  if (isMissingEndpoint(res, body) || isUnknownAction(body)) {
    fail(
      "This account has no describeScriptDeployment action.",
      "The customer's SuiteApp predates the deployment-management feature. `list` still works via SuiteQL; cadence does not.",
    );
  }
  if (body?.status !== "success") {
    fail("describeScriptDeployment failed", bodyText(body).slice(0, 1000));
  }

  const { deployment, fields, selectOptions, writableFields, recentRuns } =
    body.data;

  console.log(`${deployment.scriptId}/${deployment.deploymentId}`);
  console.log(
    `  ${deployment.title ?? "(untitled)"}  [${deployment.scriptType}]`,
  );
  console.log(`  internal id ${deployment.primaryKey}\n`);

  console.log("Current:");
  for (const [key, value] of Object.entries(fields)) {
    console.log(`  ${key.padEnd(20)} ${value ?? "(empty)"}`);
  }

  console.log(`\nWritable here: ${writableFields.join(", ")}`);

  for (const [field, options] of Object.entries(selectOptions)) {
    if (!options || options.length === 0) continue;
    console.log(
      `\n${field} accepts: ${options.map((o) => `${o.value} (${o.text})`).join(", ")}`,
    );
  }
  if (selectOptions.recurrenceminutes === null) {
    console.log(
      "\nNote: NetSuite would not enumerate the Repeat options from a server-side load." +
        "\nRead the legal values off the deployment's Schedule tab in the UI before setting --repeat.",
    );
  }

  if (recentRuns.length > 0) {
    console.log("\nRecent runs (newest first):");
    for (const run of recentRuns) {
      console.log(
        `  ${(run.startDate ?? "?").padEnd(22)} ${(run.status ?? "?").padEnd(12)}` +
          `${run.percentComplete != null ? ` ${run.percentComplete}%` : ""}` +
          `${run.endDate ? `  ended ${run.endDate}` : ""}` +
          `${run.queue ? `  queue ${run.queue}` : ""}`,
      );
    }
  } else {
    console.log(
      "\nNo run history for this deployment." +
        `${fields.status === "SCHEDULED" ? " It is SCHEDULED but has never run — check the queue and the Deployed flag." : ""}`,
    );
  }
}

// ----------------------------------------------------------------- set ----

function parseSetChanges(args) {
  const changes = {};
  const flagMap = {
    "--status": "status",
    "--repeat": "recurrenceminutes",
    "--start-time": "starttime",
    "--log-level": "loglevel",
    "--deployed": "isdeployed",
  };

  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      throw new Error(`Option ${arg} needs a value, e.g. ${arg}=<value>`);
    }
    const flag = arg.slice(0, eq);
    const raw = arg.slice(eq + 1);
    const field = flagMap[flag];
    if (!field) {
      throw new Error(`Unknown option ${flag}.\n\n${USAGE}`);
    }
    changes[field] =
      field === "isdeployed"
        ? raw === "true"
        : field === "status" || field === "loglevel"
          ? raw.toUpperCase()
          : raw;
  }

  if (Object.keys(changes).length === 0) {
    throw new Error(`No changes given.\n\n${USAGE}`);
  }
  return changes;
}

async function doSet() {
  const [scriptId, deploymentId] = rest.filter((a) => !a.startsWith("--"));
  if (!scriptId || !deploymentId) {
    console.error(USAGE);
    process.exit(2);
  }

  let changes;
  try {
    changes = parseSetChanges(rest);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  console.log(`Setting on ${scriptId}/${deploymentId}:`);
  for (const [key, value] of Object.entries(changes)) {
    console.log(`  ${key} = ${value}`);
  }
  console.log("");

  const { res, body } = await callRestlet("write", {
    action: "setScriptDeployment",
    scriptId,
    deploymentId,
    changes,
  });

  if (isMissingEndpoint(res, body) || isUnknownAction(body)) {
    fail(
      "This account has no setScriptDeployment action.",
      "The customer's SuiteApp predates the deployment-management feature. Change the deployment in the NetSuite UI: Customization > Scripting > Script Deployments.",
    );
  }
  if (body?.status !== "success") {
    fail("setScriptDeployment refused", bodyText(body).slice(0, 1000));
  }

  console.log("SAVED");
  for (const [field, { before, after }] of Object.entries(body.applied)) {
    console.log(
      `  ${field.padEnd(20)} ${before ?? "(empty)"} -> ${after ?? "(empty)"}`,
    );
  }

  // A publisher-locked deployment can accept the save and keep the old value.
  // The RESTlet re-reads after saving precisely so this is visible.
  if (body.unchanged?.length > 0) {
    console.log("");
    console.error(
      `WARNING: NetSuite kept the prior value for: ${body.unchanged.join(", ")}.`,
    );
    console.error(
      "The save succeeded but the field did not persist — the deployment is likely publisher-locked for it.",
    );
    console.error(
      "Change it in the NetSuite UI, or ship the change via SDF in the SuiteApp.",
    );
    process.exit(1);
  }
}

// ----------------------------------------------------------------- run ----

async function doRun() {
  const [scriptId, deploymentId] = rest.filter((a) => !a.startsWith("--"));
  if (!scriptId || !deploymentId) {
    console.error(USAGE);
    process.exit(2);
  }

  const { res, body } = await callRestlet("write", {
    action: "runScriptDeployment",
    scriptId,
    deploymentId,
  });

  if (isMissingEndpoint(res, body) || isUnknownAction(body)) {
    fail(
      "This account has no runScriptDeployment action.",
      "For the inbound poller specifically, `run-poller` uses the older triggerInboundPolling action and still works.",
    );
  }
  if (body?.status !== "success") {
    fail("runScriptDeployment refused", bodyText(body).slice(0, 1000));
  }

  console.log(`SUBMITTED  task ${body.taskId}`);
  console.log(JSON.stringify(body.taskStatus, null, 2));
  console.log(
    `\nWatch it: node skills/monitor-mr/monitor-mr.mjs ${customerDir} watch --task ${body.taskId}`,
  );
}

// --------------------------------------------------------------- main ----

try {
  if (command === "list") await doList();
  else if (command === "describe") await doDescribe();
  else if (command === "set") await doSet();
  else if (command === "run") await doRun();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
