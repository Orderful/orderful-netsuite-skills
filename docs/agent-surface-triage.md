# Agent surface triage

Every skill in this repo is a procedure a human runs with an AI assistant, against a
customer's NetSuite account and Orderful org. Some of those procedures would be better
as *tools* — callable, schema'd, permission-scoped — and some would be worse. This
document decides which is which, skill by skill.

The trigger is NetSuite's [AI Connector Service][ns-mcp]: as of 2026.1 a SuiteApp can
ship custom MCP tools, deployed via SDF, hosted and authenticated by NetSuite itself.
That is a genuinely new destination for a chunk of this library, and it is the first one
that puts these capabilities in *customers'* hands rather than only in ours.

**Scope note.** This triage deliberately stays at the level of surfaces that are shipped
or publicly documented — the SuiteApp's own RESTlets, NetSuite's AI Connector, and
Orderful's MCP as a product. Sequencing, ticket breakdown, and service-internal design
belong in internal planning, not here.

## The five destinations

| # | Destination | Who invokes it | How it authenticates | Can reach Orderful's API |
|---|---|---|---|---|
| **A** | NetSuite custom tool (AI Connector) | the customer, in their own AI client, as themselves | OAuth 2.0 auth-code + PKCE, role-scoped | no — async via Map/Reduce only |
| **B** | SuiteApp agent RESTlet action | Orderful's agent, post-approval | M2M, service identity | yes |
| **C** | Orderful MCP tool | Orderful employees, across customers | platform auth | yes |
| **P** | Agent prose skill | the model itself, inlined as a system prompt | n/a | n/a |
| **D** | Stays a Claude Code skill | a human contractor, with judgment | per-customer credentials | yes |

`D` is not a consolation prize. A procedure that needs a person to weigh partner
behaviour, read a portal, or decide what "correct" means is a worse tool than it is a
skill, and shipping it as a tool just moves the judgement somewhere it can't be applied.

## Constraints that decide the split

Four properties of the AI Connector do most of the classifying work. All are from
Oracle's own documentation ([overview][ns-mcp], [custom tools][ns-tools], [FAQ][ns-faq]).

1. **Custom tools cannot call external APIs.** Any procedure whose value is correlating
   NetSuite state with Orderful platform state cannot be an `A`. This is the single
   biggest sorter in the table below. The SuiteApp's own Orderful-bound work escapes it
   by submitting a Map/Reduce task and returning a task id rather than calling out
   inline — the pattern `triggerInboundPolling` already uses.
2. **Administrator roles are unsupported**, as a stated security requirement, and
   role-based permissions are enforced. Every `A` has to work inside a non-admin role.
   Much of this library currently assumes admin-level reach.
3. **Concurrency is shared** with the account's other integrations, and overruns surface
   as `Too Many Requests`. Agent traffic competes with the customer's live polling and
   outbound sends — i.e. with their actual EDI throughput.
4. **The tool surface is expensive to change.** Files are SDF-only, so tool definitions
   ride the SuiteApp release train; and a SuiteApp-distributed tool can only be removed
   by uninstalling the SuiteApp. Ship few, stable, well-named tools.

A fifth, softer constraint: NetSuite already ships a free MCP Standard Tools SuiteApp
covering generic record CRUD, saved searches, and read-only SuiteQL. We should not
rebuild any of that. Every `A` we ship should be *Orderful-specific* — Enabled
Transaction Types, Orderful Transaction diagnostics, generate-and-send, polling.

## Triage

| Skill | → | Rationale |
|---|---|---|
| `945-fulfillment-debugging` | **A** | NetSuite-only reads across the 945 → IF → 856/810 chain. High customer value, no writes. |
| `adjust-inventory` | **D** | Sandbox/dev stock scaffolding. Never customer-facing. |
| `alternative-packing-source` | **D** | Dataset design is a judgement engagement; the save step is already a `B` action. |
| `audit-outbound-rules` | **C** | Reads `/v2/rules`. External API — cannot be an `A`. |
| `bill-and-fire-810` | **D** | Test-cycle scaffolding. The fire half maps to an existing `B` generate handler. |
| `bill-test-invoice` | **D** | Test scaffolding — customers bill invoices in their own UI. |
| `build-mock-fulfillments` | **D** | As above; the 856 generate half is an existing `B` handler. |
| `bulk-jsonata-update` | **B** | Single-record ETT write already exists. Bulk needs a loop plus an approval gate — too sharp for customer self-serve. |
| `cleanup-orderful-transactions` | **B** | Deletes records. Highest-risk item in the library; wants a server-side human-approval gate, not a self-serve tool. |
| `custom-process-transactions` | **D** | Authoring SuiteScript. Developer documentation, not a tool. |
| `customer-kickoff-prep` | **D** | Salesforce, AE handoff docs, `.docx` output. Outside both NetSuite and Orderful. |
| `dsco-portal-onboarding` | **D** | Browser portal walkthrough. |
| `dsco-recon` | **D** | Third-party portal credentials and extraction. |
| `dsco-wire-testing` | **D** | Multi-system test cycle with human checkpoints. |
| `enable-customer` | **A** | A customer configuring EDI in their own account. Strong fit; needs an ETT write action inside a non-admin role. |
| `fetch-validations` | **C** | Orderful validations API. |
| `inject-test-transaction` | **C** | Posts to Orderful `/v3/transactions`, plus the sandbox-routing guard. |
| `inspect-inbound-diagnostics` | **A** | Pure read of `customrecord_orderful_diagnostic`. Cheapest real win in the table. |
| `item-lookup` | **A** | The most common customer-facing failure we have. NetSuite reads plus one lookup-record write. |
| `migrate-dataset` | **D** | Cross-account SDF work from a CLI. |
| `monitor-mr` | **A** | Task status and execution logs — NetSuite-only reads. Needs a new read action. |
| `netsuite-setup` | **retire** | Exists to provision per-customer TBA credentials. Obsoleted by OAuth 2.0 + PKCE and the SuiteApp's own consent flow. |
| `o2c-discovery` | **D** | The SuiteQL half could be an `A`; the value is in the interview it frames. |
| `org-prebuild` | **C** | Builds the Orderful org — platform-side by definition. |
| `reconcile-860-with-so` | **C** | Correlates Orderful 860s against NetSuite Sales Orders. Cross-system. |
| `reprocess-transaction` | **B** ✅ / **A** | Action already ships. Also a strong customer-facing candidate. |
| `rithum-dsco-end-to-end` | **D** | Playbook spanning four systems. |
| `run-poller` | **B** ✅ / **A** | Action already ships, and already uses the async task pattern an `A` would need. |
| `seed-inbound-transaction` | **D** | Test scaffolding via the REST record API. |
| `set-feature-flag` | **A** | A customer toggling flags on their own SuiteApp install. Needs a write action. |
| `sps-recon` | **D** | SPS Commerce portal credentials. |
| `submit-test-transaction` | **C** | Orderful v3 API. |
| `update-skills` | **D** | Meta — this repo's own contribution workflow. |
| `upload-products` | **C** | Orderful v2 products API. |
| `which-script-ran` | **A** | SuiteQL over execution logs. Useful to customers and to us. |
| `writing-inbound-jsonata` | **P** | Mirrors the outbound prose skill that already exists. |
| `writing-outbound-jsonata` | **P** ✅ | Already migrated and rewritten from operator voice to agent voice. |

## What the tally says

| Destination | Count |
|---|---|
| **D** — stays a Claude Code skill | 16 |
| **A** — NetSuite custom tool | 7 (+2 shared with B) |
| **C** — Orderful MCP tool | 7 |
| **B** — SuiteApp agent RESTlet action | 4 (2 already shipped) |
| **P** — agent prose skill | 2 (1 already migrated) |
| **retire** | 1 |

Two conclusions worth stating plainly.

**The library mostly does not migrate.** Sixteen of thirty-seven skills are human
procedures whose value is judgement, third-party portals, or test scaffolding. They stay.
Any plan that reads as "port the skills library to MCP" is mis-scoped from the start.

**Only seven are genuine customer-facing tool candidates**, and they cluster tightly
around one theme: *reading why an EDI document failed in your own account*. That is a
coherent, shippable first tool set, and it is much smaller than the library's size
suggests.

## Already done

Some of this has already happened, which is worth knowing before anyone estimates it:

- `run-poller` and `reprocess-transaction` have shipping agent-RESTlet actions.
- `writing-outbound-jsonata` has been rewritten as an agent prose skill — the 301-line
  operator procedure became roughly 120 lines of agent instruction, wrapped in about
  1,250 lines of workflow code and tests. That ratio is the realistic per-skill cost for
  anything moving to `B` or `P`.
- The SuiteApp's shared action layer is already factored out from its RESTlets, and
  several handlers are exported but not yet exposed on any agent surface — including the
  generate paths for 855, 856, 810, and 940. Those shorten the `B` column materially.

## Open questions

1. **Exact scope of the external-API restriction.** It decides the `A`/`C` boundary for
   the whole table and should be confirmed first-hand against the current release notes,
   not from summary.
2. **Release spread across the install base.** 2026.1 introduced a new `toolset` SDF
   object; Oracle's samples are explicitly 2026.1-and-not-2025.2, and execution-log
   visibility requires the newer spec. We already ship version-gated fallbacks for
   endpoints not present in older SuiteApp installs; tool availability will vary the same
   way.
3. **Manifest features.** A `required="true"` feature the customer lacks blocks SuiteApp
   installation *and upgrade*. Any AI Connector prerequisite has to go in as optional
   with graceful degradation, or it gates the entire connector.
4. **Who owns the `A` column.** `B` and `C` have owners. A customer-facing NetSuite tool
   set is a product decision, and currently unowned.

[ns-mcp]: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_7200233106.html
[ns-tools]: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_162020236.html
[ns-faq]: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_4160616848.html
