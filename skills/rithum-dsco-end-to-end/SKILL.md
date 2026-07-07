---
name: rithum-dsco-end-to-end
description: End-to-end playbook for onboarding a trading partner (retailer) via Rithum/DSCO dropship — from confirming the EDI path and recon, through Orderful org + partnership setup, internal Orderful↔NetSuite round-trip testing, the 15-step Rithum/DSCO portal, AS2 + automation jobs, production cutover, and the gated go-live / smoke-test sequence. Self-contained single guide with the watchouts that only bite in the field. Use when onboarding any customer that fulfills via Rithum/DSCO (formerly CommerceHub) dropship — e.g. AAFES, Chewy — or the user says "onboard <customer> on DSCO", "Rithum dropship end to end", "how do I work with Rithum for a trading partner", "DSCO onboarding playbook".
---

# Rithum / DSCO Dropship — End-to-End Onboarding

The one place to go to take a customer live with a retailer over **Rithum/DSCO dropship** (Rithum was DSCO, formerly CommerceHub). Follow the phases in order. Each phase lists the actions, then the **⚠ watchouts** that only surface in the field.

## The model (read this first)

Four parties, and you only talk to two of them:

```
Retailer (e.g. AAFES) ⇄ Rithum/DSCO network ⇄ Orderful ⇄ Customer's NetSuite
     (sends POs)          (the intermediary)     (EDI)      (the supplier)
```

- **You never EDI the retailer directly.** Orderful connects to Rithum/DSCO; Rithum routes to the retailer. Coordinate setup with Rithum (`dscopartnersetup@rithum.com`), not the retailer.
- **DSCO is order-first.** The retailer processes your documents *in order sequence*, not as they arrive. An 810 (invoice) can be received and 997-accepted but **silently not processed** until the order is fulfilled and the **856 (ASN) has succeeded**. Always send the **856 before the 810**, and confirm status in the **DSCO order history**, not just Orderful's delivery status. `997 / delivered / accepted = AS2 receipt only`, never business acceptance.

## Division of labor — who owns what

The single biggest source of stalls is ambiguity about who does the next step. Print this.

| Workstream | Customer (supplier) | Orderful | Rithum | Retailer |
|---|---|---|---|---|
| Retailer relationship + portal invite | **Owns** — initiates with their buyer; accepts the invite | — | Sends invite on retailer request | Approves vendor; triggers invite |
| Portal steps 1–7 (company, pricing, warehouses, catalog, inventory seed) | **Owns** — only they have this commercial data | Advises | Reviews catalog | Approves assortment |
| Portal steps 8–15 (test orders → returns) | Clicks alongside | **Drives** — runs the EDI legs | Reviews results (step 15) | — |
| Orderful org, partnership, guidelines, NetSuite integration | — | **Owns** | — | — |
| AS2 enablement + automation jobs | — | **Drives** (needs support call) | **Enables AS2** (not on by default) | — |
| Warehouse codes registered in DSCO | **Owns** (portal) | Verifies the EDI matches | — | — |
| Production carrier/ship-method list | **Owns** — gets it from the retailer | Maps it | — | Confirms codes |
| Smoke test + LIVE letter + return acceptance | **Owns the clock** (1-business-day windows) | Monitors EDI | — | Runs the gate |
| Steady state: current inventory, order SLAs | **Owns** | Monitors feed | — | Enforces (chargebacks) |

## When to use

- Customer fulfills for a retailer via Rithum/DSCO dropship (AAFES, Chewy, etc.)
- You're standing up a brand-new DSCO trading partner end to end
- You need the full arc: recon → Orderful setup → testing → portal → cutover → go-live

## What the customer must have ready (ask for ALL of this on day 1)

These are commercial/supply-chain inputs **only the customer can provide**. Every one of them has stalled a real onboarding. Collect them in the kickoff, not when the step blocks:

1. **An active vendor relationship with the retailer** — the retailer initiates the Rithum invite; Orderful cannot.
2. **Rithum/DSCO portal invite accepted** + working login (`app.dsco.io`), and Orderful added as a portal user so we can drive steps 8–15.
3. **A named EDI/ops contact** (one person, real inbox) for portal notifications and failure emails — not a shared alias.
4. **Billing contact + email-notification recipients** (portal step 2 asks for these).
5. **Pricing agreement decision** — someone authorized to accept the retailer's pricing terms (step 3 is a legal/commercial acceptance, not a technical step).
6. **Warehouse list**: every ship-from warehouse with full address, and the **short warehouse code** each will be known by (e.g. `DFW`). This exact code must be (a) registered as a warehouse in the DSCO portal AND (b) what the EDI emits in `REF*WS` — a descriptive name in either place breaks the inventory import.
7. **Product catalog in the retailer's template** — retailer-approved items, real UPCs, images if the retailer requires them. **Catalog upload gates everything** — test orders are generated from it.
8. **Inventory numbers** for the catalog items (seed quantities for testing; a real feed source for production).
9. **Their production ship methods** — every carrier/service their pack-ship tool uses (FedEx, USPS/Stamps.com, UPS…), so all of them get mapped before live orders.
10. **NetSuite access** (sandbox + production) if Orderful runs the ERP side.

**If the customer is migrating off another provider (e.g. SPS):** get those credentials too, and plan the Rithum re-pointing with `dscopartnersetup@rithum.com` — it is not instant.

## Transaction set (DSCO dropship)

| TX | Direction | Notes |
|----|-----------|-------|
| 850 Purchase Order | Inbound (retailer → you) | The order |
| 856 Ship Notice (ASN) | Outbound | **Send before the 810.** SKU in `LIN03`/`SK`; `LIN01` = short line-seq (≤20 chars) |
| 810 Invoice | Outbound | Strictest spec — send ONLY required fields |
| 846 Inventory | Outbound | **Production inventory is a real, scheduled EDI 846 feed** (all live AAFES DSCO vendors send one); the 2-col CSV/portal upload is only the portal-onboarding bootstrap (steps 6–7). See `reference/aafes-dsco.md` → "AAFES DSCO 846 Inventory Feed" |
| 870 Order Status | Outbound | Often not required — confirm with the retailer |

**855 is not used on the DSCO path** — acknowledgement is a platform status change, not a document.

---

## Phase 0 — Confirm the EDI path & recon

1. **Confirm the retailer's DSCO path.** Some retailers have multiple EDI accounts (e.g., AAFES has Direct, DSCO/Rithum, and Radial/VendorNet). Building a partnership on the wrong account means a full rebuild — confirm with the customer / retailer before building anything.
2. **Recon the customer's current setup** (needs their DSCO portal creds) — pull retailers, supplier IDs, transaction history, and item/pricing patterns. If migrating off SPS, recon SPS too.
3. **Get the customer invited to the Rithum/DSCO portal** by the retailer, and get yourself (Orderful) added so you can run the supplier checklist.

⚠ **Watchouts**
- Don't infer the path from old notes — *confirm* it. Wrong EDI account = rebuild.
- The customer, not Orderful, initiates the retailer relationship in Rithum.

## Phase 1 — Orderful org + partnership

1. Provision the customer's Orderful org. **ISA ID must be ≤ 15 characters.**
2. Build the partnership on the **correct DSCO EDI account** (from Phase 0).
3. Attach the retailer's published guidelines to each relationship.

⚠ **Watchouts**
- Check the inbound 850 guideline for schema gaps before relying on it — DSCO 850s carry ~15 REF segments of DSCO metadata; the default mapper may drop fields.

## Phase 2 — Internal round-trip (Orderful ↔ NetSuite)

Prove the full chain in sandbox **before** touching the portal:

1. Inject a test **850** → confirm a NetSuite **Sales Order** is created (watch for `ITEM_LOOKUP_MISSING`).
2. Fulfill → generate the **856**; bill → generate the **810**.
3. Author outbound JSONata: the DSCO **810 is strict** — drop reference info (PO/VN/CO), keep N1*ST only, no SAC/freight (retailer is often merchant of record). SKU goes in `LIN03` on the 856.
4. Confirm both the 856 and 810 validate **VALID** in Orderful.

⚠ **Watchouts**
- **Every outbound relationship needs a communication channel or delivery fails silently** (VALID but `deliveryStatus: FAILED`). For sandbox use the auto-provisioned **"Keep In Orderful"** channel; assign it to the `test` and `live` streams. Verify the outbound relationship points to the correct **DSCO/Rithum AS2** channel before real testing.
- NetSuite inventory allocation is **manual** for dropship — pre-create large quantities in sandbox so orders proceed.
- Audit the customer's existing NS workflows — SPS-era workflows can silently hold or reject EDI orders.

## Phase 3 — Rithum/DSCO portal (15-step supplier checklist, in painful detail)

Portal: `https://app.dsco.io`. **Steps 1–7 are the customer's** (commercial data only they have — this is the most common long pole; send them these steps in the kickoff follow-up email and chase weekly). **Steps 8–15 are Orderful-driven** with the customer alongside.

**Golden rule for every step:** before following the generic DSCO instructions, look for a **"Download <Retailer> Specific Template"** link or a retailer note box — the retailer's own template/notes override the instructions (AAFES's note literally says "USE THIS TEMPLATE NOT WHAT IS LISTED IN THE INSTRUCTIONS SECTION").

| # | Step | Owner | Exactly what to do | Done when |
|---|------|-------|--------------------|-----------|
| 1 | How to Get Started | Customer | Read intro, click Next | Step shows complete |
| 2 | Configure Initial Settings | **Customer** | Company info, billing contact, email-notification recipients | Saved without validation errors |
| 3 | Pricing Agreement | **Customer** | Someone *authorized* accepts the retailer's pricing terms (commercial acceptance, not technical) | Agreement accepted |
| 4 | Supply Warehouses | **Customer** | Add every ship-from warehouse: full address + the **short warehouse code** (e.g. `DFW`) it will be known by. This registers the code DSCO's imports validate against | All warehouses listed with their codes |
| 5 | Submit Catalog | **Customer** | Upload the product catalog **in the retailer's template** (real UPCs; images if required). This is the gate — test orders generate from it | Catalog accepted; items visible |
| 6 | Load Items & Inventory | **Customer** (Orderful assists) | Download the *retailer-specific* inventory template (note box, not the instructions). Seed ~3 SKUs with `quantity_available` ≥ 20. For AAFES this bootstrap is a 2-col CSV (`sku`, `quantity_available`) | Items show on the Inventory page |
| 7 | Update Inventory | Customer | Download current inventory (Download All Results → Export Inventory), change qty to 50, re-upload | Quantities show 50 |
| 8 | Create Test Orders | Orderful + Customer | Pick the retailer's standard carrier from the dropdown (AAFES: FedEx – Home Delivery / FEHD), click Next → portal generates ~3 test POs. Note the PO numbers — steps 9–14 use them. Can be re-run for more | Test POs exist |
| 9 | Acknowledge Orders | **Orderful** | The real EDI wiring — AS2 + both automation jobs (Phase 4). Run the Orders export; orders flip to **Acknowledged** (a platform status — no 855 document exists on DSCO) | Test orders show "Acknowledged" and appear in Orderful |
| 10 | Ship an Order | **Orderful** (customer's NS) | Fulfill in NS → outbound 856 through the Outbound job. Test tracking numbers: FedEx = 15 zeros; UPS = `1Z` + 16 zeros. Respect ship-by dates + the retailer's service-level codes; check for a retailer-specific shipment template | Order shows shipped in DSCO order history |
| 11 | Cancel an Order | Orderful | Generate the 870 via the Orderful API — don't build a full NS cancellation workflow just for this test | Cancellation reflected in DSCO |
| 12 | Multi-Line Ship | Orderful | Partial fulfillment of a multi-line test PO → 856 | Partial shipment shows correctly |
| 13 | Invoice | Orderful | Bill in NS → outbound 810 (**after** the 856 — order-first). Strict spec: required fields only | Invoice accepted in DSCO order history |
| 14 | Returns | **Customer** | Handled **manually in the DSCO UI** — no EDI return document; don't scope return automation. Customer's team must know this is theirs in production | Return processed in the portal |
| 15 | Next Steps | Rithum | Rithum reviews all results; on pass the connection moves toward production | Rithum confirms pass |

⚠ **Watchouts**
- Orders **can't be deleted** in the DSCO UI once created — ignore stale ones, use the latest batch.
- **Account-switching bugs**: if the portal shows the wrong account, log out, clear cache/cookies, re-accept the invite.
- Job failures: Automation Jobs → **Job History** → click the failed run — the detail page names the reason (wrong SCAC, missing tracking, invalid data).

## Phase 4 — AS2 + automation jobs (the part that breaks)

**A. AS2 connection**
1. In Orderful, create a communication channel → **Shared AS2** → search **"Rithum AS2"** (the shared connection; reuses Orderful's existing cert already known to Rithum — do **not** mint a new cert).
2. AS2 is **not enabled by default** in the DSCO portal. Call Rithum support (see below) to enable AS2 for the account and configure the backend connection with the customer's ISA ID (exactly 15 chars).

**B. Two automation jobs (in the DSCO portal)**

| Job | Type | Key settings |
|-----|------|--------------|
| **Orders** | Orders Export (pulls 850s → Orderful) | Standard=DSCO, Dest=DSCO AS2, Include Test Orders ✓, **Source Data = "All retailers"**, filename `Purchase_Order_${ymdt}.edi` |
| **Outbound** | EDI Import (sends 856/810 → DSCO) | Source=DSCO AS2, filename `*` (wildcard), **Generate 997 ✓** |

⚠ **Watchouts**
- **Source Data defaults to the specific retailer, which excludes the fictitious test retailer → the export pulls 0 orders.** Set it to **"All retailers"** (works in test and prod).
- Both jobs default to **Manual** schedule. **Leaving "Orders" on manual at go-live means real POs sit un-exported and never reach you** — it looks like "no orders arrived." Flip to automatic at cutover; if an expected order is missing, run the job manually and check its schedule first.

## Phase 5 — Production cutover

1. Install the SuiteApp in **production** NetSuite; mirror the sandbox config.
2. Finish the prod **enabled-transaction** links (customer + doc-type + direction) so transactions match.
3. Set all Orderful relationships **READY** + **autoSend ON**; schedule the inbound polling job; set the prod API secret + polling bucket.
4. **Replace the "Keep In Orderful" outbound channel with the real DSCO/Rithum AS2 delivery.**
5. **Map ALL shipping methods in the NS prod shipping lookup — and put the retailer's code in the right TD5 field.** For AAFES, *every* shipment transmits with service code **`FEHD`** regardless of actual carrier (FedEx, Stamps.com, even USPS) — but `FEHD` is a **service-level code**: it goes in the lookup's *service-level* field (→ TD5 `locationIdentifier`, enum-validated), while the *SCAC/carrier* field stays the real carrier name (FedEx/UPS/USPS → TD5 `identificationCode`). Putting `FEHD` in the carrier field passes validation but ships a service code as the carrier. Map every method the customer's pack/ship tool uses — not just "FedEx Home Delivery" — or force `locationIdentifier` universally via JSONata / an Orderful rule.
6. **Stand up the production 846 inventory feed** — saved search on the trading-partner Customer record (`ITEM`/`AVAILABLE`/`LOCATION`, internal IDs) + schedule the Inventory Advice Handler MR; the `REF*WS` warehouse code must be a bare code registered as a warehouse in the DSCO portal. See `reference/aafes-dsco.md` → "AAFES DSCO 846 Inventory Feed".

⚠ **Watchouts**
- **TD5 carrier failure:** if the prod shipping/SCAC lookup is missing/misconfigured, the 856 `TD5` emits the carrier *name* in `locationIdentifier` and omits the mandatory `identificationCode` → rejected. Sandbox often has the mapping while prod doesn't — **verify prod explicitly.**
- Confirm the first live 850's items resolve in NS (no `ITEM_LOOKUP_MISSING`).

## Phase 6 — Go-live: the smoke-test / LIVE-letter sequence

Go-live is a **gated sequence, not a date** (AAFES example):

1. Retailer places a **smoke-test order**.
2. **Fake-ship + invoice it clean in DSCO within 1 business day**, adhering to the retailer's Required-Fields-by-Workflow.
3. **2–3 business days** through the retailer's systems.
4. If the invoice passes clean → the retailer sends a **LIVE letter**.
5. The compliant assortment moves to the **production stream** (2–3 more days).
6. Retailer creates a **return in DSCO**; **accept it within 1 business day** to close out.

**The customer owns the clock in this phase.** Make sure they know, before the smoke test starts, that they (or Orderful on their behalf) must:
- **Fake-ship + invoice the smoke-test order within 1 business day** of it arriving — someone with NS + DSCO access must be available that day.
- **Accept the retailer's closing return in DSCO within 1 business day** — it's a portal action on their account, and it's easy to miss because it arrives days after everyone stopped watching.
- **Get the production carrier list from the retailer** (which methods/codes will real orders carry) so every method is mapped *before* volume — an unmapped method on a live order = failed 856 = **chargeback** (AAFES: **$150 per ASN violation**; one vendor accumulated $7,148.50 in a cycle).

⚠ **Watchouts**
- **Running the smoke test in production has real side effects** — a real NS fulfillment, invoice/AR, and reduced inventory. Decide up front whether prod testing is acceptable, who runs it, and who reverses it. Deleting the NS records afterward does **not** retract the already-transmitted-and-accepted 856/810 (immutable Orderful events); the return is a manual DSCO accept, so NS records aren't required for it. **Hold reversals until the LIVE letter confirms the invoice passed.**
- **Stale inventory can gate the retailer from releasing orders** — dropship retailers commonly require current inventory before sending a PO. Keep the feed current (this is why the production 846 must be *scheduled*, not one-off).

## Silent killers (no error anywhere — things just stall)

Each of these has burned days on a real onboarding because nothing showed red:

1. **Portal invite never accepted / steps 1–7 sitting on the customer.** Rithum won't progress and no one is notified. Chase weekly; the commercial steps are the longest pole.
2. **Catalog not uploaded** → step 8 can't generate test orders → everything downstream waits.
3. **Source Data = specific retailer** on the Orders export → test orders come from a *fictitious test retailer*, so the job pulls **0 transactions** and simply looks like "no orders."
4. **Automation jobs left on Manual at cutover** → real production POs sit un-exported in DSCO. Looks exactly like "the retailer isn't sending orders."
5. **AS2 not enabled on the DSCO account** → nothing transmits; the portal just never shows AS2 options. It takes a *phone call* to Rithum (ticket alone is slow).
6. **Warehouse code mismatch** → the 846/inventory import fails **application-level** in DSCO ("Unknown warehouse code … please create it") even while the EDI 997 shows ACCEPTED. The `REF*WS` code must be the bare registered code (e.g. `DFW`), not a descriptive location name — and it must exist as a warehouse in the portal (step 4).
7. **810 sent before the 856** → 997-accepted but silently never processed (order-first). Check DSCO order history, not Orderful delivery status.
8. **Stale inventory** → retailer quietly stops releasing orders; the Rithum "you missed an inventory update" exception email is the only signal — make sure it goes to a watched inbox.

---

## Top watchouts (quick reference)

1. **Send the 856 before the 810** — DSCO is order-first; 997 ≠ business acceptance.
2. **Map every ship method — and put the code in the right field**: the retailer's universal code is a *service-level* code (AAFES = `FEHD` → TD5 `locationIdentifier`); the carrier/SCAC field stays the real carrier name.
3. **Outbound relationships need a comm channel** or delivery fails silently.
4. **Source Data = "All retailers"** or the Orders export pulls 0.
5. **Flip automation jobs to automatic at cutover** — manual blocks live orders.
6. **AS2 must be enabled by Rithum support** — not on by default.
7. **Retailer templates override generic DSCO instructions.**
8. **Confirm the correct EDI path first** — wrong account = rebuild.
9. **810 is strict**; **SKU in LIN03, short seq in LIN01** on the 856.
10. **Returns are manual** in the DSCO UI — no EDI return doc.

## Definition of done — gate checklists

Don't declare a phase done until every box in its gate is checked.

**Gate A — ready to start (customer inputs)**
- [ ] Retailer relationship active; Rithum invite accepted; Orderful added to the portal
- [ ] Named EDI/ops contact + billing contact + notification recipients provided
- [ ] Pricing agreement accepted by someone authorized
- [ ] Warehouse list with short codes; catalog in retailer template (UPCs, images); seed inventory numbers
- [ ] NetSuite access (SB + prod) if Orderful runs the ERP side; prior-provider creds if migrating

**Gate B — portal testing complete (end of Phase 3/4)**
- [ ] All 15 steps green; Rithum confirms pass (step 15)
- [ ] AS2 enabled on the DSCO account; both automation jobs exist and have succeeded in Job History
- [ ] Acknowledge / ship / cancel / multi-line / invoice / return all verified in DSCO order history

**Gate C — production cutover**
- [ ] Prod SuiteApp mirrored; relationships READY + autoSend; prod polling wired
- [ ] Outbound channel = real DSCO/Rithum AS2 (not "Keep In Orderful")
- [ ] **Every** production ship method mapped (service-level code → TD5 `locationIdentifier`; real carrier in the SCAC field)
- [ ] Production 846 inventory feed configured **and scheduled**; `REF*WS` = bare registered warehouse code
- [ ] **Both automation jobs flipped to automatic**
- [ ] First live 850's items resolve in NS (no `ITEM_LOOKUP_MISSING`)

**Gate D — go-live closed out**
- [ ] Smoke-test order fake-shipped + invoiced clean within 1 business day
- [ ] LIVE letter received; assortment moved to production stream
- [ ] Closing return accepted in DSCO within 1 business day
- [ ] Reversals of smoke-test NS records done **after** the LIVE letter
- [ ] Inventory feed confirmed recurring (not a one-off run); exception alerts going to a watched inbox
- [ ] Customer team briefed: returns are manual in DSCO; order-first sequencing; chargeback triggers

## Support & contacts

| | Details |
|---|---------|
| Rithum support | **844-482-4357** → DSCO support → DSCO onboarding (until 6PM ET) |
| Partner setup | `dscopartnersetup@rithum.com` |
| Tip | Create a ticket first, then call and reference it — phone is faster |

## Companion skills (onboarding set)

If present in your skills set, these go deeper on individual phases: **dsco-recon** (pull the customer's DSCO config), **dsco-portal-onboarding** (detailed 15-step portal walkthrough), **org-prebuild** (build the Orderful org from recon), **sps-recon** (migrating off SPS), **writing-outbound-jsonata** / **item-lookup** / **audit-rules** (NetSuite/Orderful mechanics), and the **aafes-dsco** reference (AAFES paths, guidelines, 850 structure, compliance $).
