---
name: customer-kickoff-prep
description: Generate an internal pre-call prep doc (.docx) for an Orderful customer kickoff call. Pulls context from the AE handoff doc, Salesforce, Orderful's network, and the Customer Kick-Off SOP, then synthesizes it into a structured 30-minute call prep doc with agenda, decisions to lock, expected Q&A, exit criteria, and post-call action items. Use this skill whenever an AM is preparing for a kickoff call with a new Orderful customer. Trigger on "build kickoff prep for [customer]", "prep me for [customer] kickoff", "I'm running [customer] through the kickoff SOP", "[customer] kickoff prep doc", "kickoff prep [customer]", "AM prep for [customer]", or any request to produce a pre-call prep document for a new customer onboarding to Orderful. ALWAYS use this skill when the user mentions kickoff prep, kickoff prep doc, or pre-call prep for a customer.
---

# Customer Kickoff Prep Doc

Produces an internal-only `.docx` prep doc the AM uses live during the kickoff call. The doc is decision-focused (not discovery-focused) and bakes in Orderful's working-model expectations: 30-minute call, async-first afterward, no recurring meetings.

## When to use

Trigger as soon as an AM mentions they're prepping for a kickoff with a new customer — even before they ask explicitly. The whole point is to walk into the call with the snapshot already replayed, partner data already pulled, and decisions teed up.

## Workflow

### 1. Gather inputs (ask once, then research)

Required from the user (ask via AskUserQuestion if missing):

- **Customer name** — e.g., "Framar"
- **AE handoff doc** — Google Doc link OR the customer's Salesforce opportunity ID. The handoff doc is the highest-density source; do not skip it.

Optional but useful:

- **Customer's Orderful org ID** (if already provisioned) — speeds up the network lookup
- **Anything the user already knows** that should override the handoff (e.g., "Isaiah already deployed the Suite App")

If the user hasn't provided either of the required inputs, ask before researching. Do not invent a customer or speculate from a name alone.

### 1b. Get credentials BEFORE the kickoff (critical)

**Do not wait for the kickoff call to ask for credentials.** Send a credential collection email as soon as the deal closes / kickoff is scheduled. Request:

- **SPS Commerce credentials** (if migrating from SPS) — to pull historical transactions and item catalogs
- **DSCO/Rithum credentials** (if dropship) — to understand retailer connections
- **NetSuite access** (sandbox + production) — to install SuiteApp and analyze field usage. Ask whether the customer has a sandbox — smaller customers on lower NS tiers may be prod-only (see `reference/ndcinc-p2p.md`).
- **Current EDI provider details** — ISA IDs, partner list, known issues
- **Flow direction** — Is this Order-to-Cash (customer receives inbound POs) or Procure-to-Pay (customer sends outbound POs to suppliers)? P2P is not native to the SuiteApp and requires custom SuiteScript per transaction type. If P2P, flag immediately: (a) custom script work required, (b) ~2-4 hours per TX type, (c) who builds it (Lysi, Orderful, customer). See `reference/ndcinc-p2p.md` for the full breakdown.

**Why this matters (validated on RuffleButts 2026-05-08):** By getting SPS + DSCO + NS access before the kickoff, we arrived with a pre-built partnership, confirmed the correct AAFES EDI path, and had a test 850 ready. AE feedback: "That was extremely productive and very slick!" VP Sales: "Big fan of the kickoff." Compare this to showing up and spending 30 minutes discovering basics.

**If P2P is identified**, two additional questions are critical at kickoff:
1. **What % of POs are drop-ship vs stock?** This is THE design question — it determines the entire 856 inbound implementation (Item Fulfillment vs Item Receipt, two completely different NS paths). MARS Medical was 87% drop-ship, discovered May 12 after scripts were already in flight. Ask this during kickoff, not after. See `reference/ndcinc-p2p.md` lesson #8.
2. **Does the trading partner define the EDI guidelines (leader), or does the customer?** This determines who owns the spec. On Orderful, the leader publishes guidelines and Orderful maps between. Don't assume traditional spec exchange is needed. See `reference/ndcinc-p2p.md` lesson #15.

**Requirements baseline document pattern (validated May 2026):** When a P2P or complex onboarding surfaces detailed requirements questions, use Isaiah's structured requirements baseline doc format: why / what's different / the #1 design decision / status snapshot / doc-by-doc requirements / testing strategy / what we need / timeline / appendix. This pattern got a customer (Logan Watson, MARS Medical) to deliver detailed, implementable answers for all 7 TX types in under 12 hours. Thin questions produce thin answers; structured frameworks produce structured answers. See `reference/ndcinc-p2p.md` lessons #10-11.

**Credential sharing:** Use 1Password links or the platform's future secret store, not email or Zoom chat. For urgency, accept what the customer sends but flag for rotation.

### 2. Research in parallel

Hit these sources concurrently. Tools may be named differently in the user's MCP setup; use what's available:

- **Confluence** — search for "Customer Kick-Off SOP" and read the latest version. Treat the SOP as ground truth on agenda structure, follow-up SLAs, and roles. Flag any drift between SOP and this skill in your output.
- **Google Drive / handoff doc** — read the AE handoff in full. Pull: contact list, ERP/WMS, current EDI state, partners, document set, comms protocols, technical contacts, SI involvement, signed terms, open questions/risks the AE flagged.
- **Salesforce** — pull the account context, opportunity stage, ARR, signed contract, AE name, last activity. Cross-check against the handoff for inconsistencies.
- **Orderful network** — for each named trading partner in the handoff, run `search_organizations`. Capture: in-network status, ISA ID, org/EDI account ID, number of EDI accounts (multiple often means multiple programs/regions).
- **Slack** (if available) — quick search for the customer name in #sales and #rnd-updates to surface anything verbal that didn't make the handoff.

Skip a source only if the connector isn't available — don't skip it because the handoff "looks complete."

### 3. Synthesize into the doc structure

The doc has a **fixed section structure** — do not add or reorder sections. Variables are content within sections.

1. **Title block** — INTERNAL — PRE-CALL PREP / [Customer] × Orderful — Kickoff Call / one-line subtitle
2. **Goal of this call** — frame as decision/sequencing, not fact-finding. Always include "Three things must come out of this 30-minute call".
3. **Attendees** — Customer side + Orderful side, with role and what they own
4. **What we already know** — replay this in first 3 min (bullet list, ~6–10 items)
5. **Orderful network intel** — pre-pulled (table: partner, status in network, ISA/org ID, implication)
6. **Agenda** — 30 minutes (table: time, topic, what good looks like)
7. **Decisions to lock on the call** (table: decision, owner, why now)
8. **Expected questions & prepared answers** (table: if they ask, you say)
9. **Risks to flag** (verbally — don't solution) — bullet list
10. **Exit criteria** — don't end the call without (checklist)
11. **Post-call action items** (within 1 business day) — bullet list

### 4. Bake in Orderful's working model (always)

These principles are non-negotiable and must show up in the agenda, decisions, Q&A, exit criteria, and action items:

- **30-minute call**, not 60
- **Async-first** afterward — NO recurring meetings on the calendar
- **Same-business-day email responsiveness** expected from the customer
- **30-min sync available on demand**, not standing
- **Escalate after >2 business days** of no customer response
- **SPS pricing comparison** — never bring it up; redirect to time-saved if raised

If the SOP in Confluence has been updated and contradicts these principles, flag the conflict at the top of the doc with a clear note for the user.

### 5. Generate and validate

If a build script is available (`scripts/build_prep_doc.js`), use it. Otherwise, produce the doc content directly in markdown format that can be converted.

Validate:

- Section order matches the template
- All seven Orderful working-model principles appear somewhere in the doc
- No mention of weekly standups or recurring meetings
- All trading partners from the handoff appear in section 5
- The "three things" in section 2 match the actual decisions in section 7

### 6. Deliver

Save to `/outputs/[CustomerName]_Kickoff_PrepDoc.docx` (or `.md` if docx generation not available). Briefly summarize what changed vs. boilerplate — e.g., "Network shows Sally Beauty in-network but BSG missing standalone — flagged that BSG likely shares SALLYBEAUTY ISA."

## Tone of the doc

This is a doc the AM reads while on the call. Keep it scannable, not prosy.

- Use bullets and tables, not paragraphs
- Each Q&A answer should be ≤2 sentences — long enough to actually answer the question, short enough to glance at
- Risks should be one line each — flag the issue, not solution it
- Decisions table: prescribe a recommendation when there's a sensible default (e.g., "First partner: Sally / BSG (recommended)"), don't just list options

## The New Onboarding Model (validated May 2026)

The RuffleButts and Sherwood onboardings proved a fundamentally different approach. Apply this model to every kickoff.

### People (Old → New)

| Old | New |
|-----|-----|
| Contractors (Lysi/N2), OAs, AM/Sales handoff | Product team (Mike, Ashwath, Isaiah) + AM/Sales handoff |

### Process (Old → New)

| Old | New |
|-----|-----|
| Wait for customer to commit trade requests | Create and approve trade requests FOR the customer |
| Non-technical kickoff and early training | Decision-focused kickoff — arrive with partnerships pre-built |
| Wait for customer to install app | Gain access quickly to NS + legacy EDI, install and configure on customer's behalf |
| Wait for outreach and customer to collect historical data | Get credentials BEFORE kickoff, pull historical data yourself |
| Requirements gathering with customer, rely on their internal resources | Make assumptions and verify, build valid transactions quickly |
| Wait for customer to process return transactions | Mock NS transactions from historical examples, send outbound transactions without waiting for customer |

### Systems (Old → New)

| Old | New |
|-----|-----|
| Manual setup, testing, rule writing, JSONata writing, validation | NetSuite skills library for onboarding, setup, and outbound transaction validation |

### Key Principle

**Don't wait. Don't discover. Arrive prepared.**

Get credentials early → pull historical data → pre-build partnerships → mock real transactions → walk into kickoff with a working demo, not a blank canvas. The customer's first impression should be "this is already running" not "let's talk about what we need."

## Customer Communication Rules

**Don't expose NetSuite internals to customers.** When sending questions to customers, translate technical NS details into business language they can answer:

| Internal (DON'T send) | Customer-facing (DO send) |
|----------------------|--------------------------|
| `custbody1=1` (Retail) hardcoded via JSONata | Should AAFES dropship orders use your existing "Retail" order type? |
| `cseg=8` Wholesale Dropship | Do you want a separate sales channel for AAFES reporting? |
| `custbody_so_rb_status=5` puts SO on hold | Your NetSuite has logic that puts EDI orders on hold — intentional? |
| IT1.basisOfUnitPriceCode WE→QT | Should invoices carry EDI wholesale or NS retail pricing? |

**Learned on RuffleButts (May 2026):** First email draft included raw NS field names. Customer wouldn't know what `custbody1=1` means. Rewrite in business terms they can answer without NS expertise.

## What this skill is NOT

- It does **NOT** generate a customer-facing kickoff deck. We've moved away from those — the kickoff is a 30-min decision call, not a presentation. If the user asks for a deck, push back: "we've stopped using kickoff decks — the prep doc is what you walk into the room with, and the working model after the call is async."
- It does **NOT** do customer research from scratch. If there's no AE handoff, ask the user to point you to it before proceeding. Don't fabricate.
- It does **NOT** replace reading the SOP. The skill bakes in current Orderful expectations, but the SOP is the source of truth — pull it every run.

## Example invocation flow

1. User: "I'm running customer Acme through the kickoff SOP next week, prep me"
2. AskUserQuestion: handoff doc link (required), Orderful org ID (optional)
3. Pull SOP from Confluence, handoff from Drive, account from SFDC, partners from Orderful network — in parallel
4. Build doc content keyed on what was found
5. Write doc to `/outputs/Acme_Kickoff_PrepDoc.docx`
6. Reply with the link + 3-bullet summary of what's notable in the prep
