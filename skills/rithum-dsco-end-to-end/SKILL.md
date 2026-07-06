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

## When to use

- Customer fulfills for a retailer via Rithum/DSCO dropship (AAFES, Chewy, etc.)
- You're standing up a brand-new DSCO trading partner end to end
- You need the full arc: recon → Orderful setup → testing → portal → cutover → go-live

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

## Phase 3 — Rithum/DSCO portal (15-step supplier checklist)

Portal: `https://app.dsco.io`. The arc:

| Steps | What | Key action |
|-------|------|-----------|
| 1–5 | Setup | Company info, warehouses, pricing agreement, **submit catalog** (retailer template — images often required) |
| 6–7 | Inventory | Upload + update inventory. **AAFES portal bootstrap = 2-col CSV (`sku`, `quantity_available`)** — seeds test stock only; the *production* feed is a scheduled EDI 846 (set up at cutover) |
| 8 | Test orders | Portal generates test POs (pick a carrier) |
| 9 | Acknowledgement + **AS2** | The real EDI wiring — see Phase 4 |
| 10 | Ship | Outbound 856 (test tracking: FedEx = 15 zeros; UPS = `1Z` + 16 zeros) |
| 11 | Cancel | Can generate the 870 via Orderful API rather than a full NS workflow |
| 12 | Multi-line ship | Partial fulfillment |
| 13 | Invoice | Outbound 810 |
| 14 | Returns | **Manual in the DSCO UI — no EDI return document.** Don't scope return automation |
| 15 | Next steps | Rithum reviews; on pass, connection moves toward production |

⚠ **Watchouts**
- **The retailer's own templates override the generic DSCO instructions.** Always look for a "Download <Retailer> Specific Template" link in the note box before following the standard steps.
- Orders **can't be deleted** in the DSCO UI once created — just use the latest batch.

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

⚠ **Watchouts**
- **Running the smoke test in production has real side effects** — a real NS fulfillment, invoice/AR, and reduced inventory. Decide up front whether prod testing is acceptable, who runs it, and who reverses it. Deleting the NS records afterward does **not** retract the already-transmitted-and-accepted 856/810 (immutable Orderful events); the return is a manual DSCO accept, so NS records aren't required for it. **Hold reversals until the LIVE letter confirms the invoice passed.**
- **Stale inventory can gate the retailer from releasing orders** — dropship retailers commonly require current inventory before sending a PO. Keep the feed current.

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

## Support & contacts

| | Details |
|---|---------|
| Rithum support | **844-482-4357** → DSCO support → DSCO onboarding (until 6PM ET) |
| Partner setup | `dscopartnersetup@rithum.com` |
| Tip | Create a ticket first, then call and reference it — phone is faster |

## Companion skills (onboarding set)

If present in your skills set, these go deeper on individual phases: **dsco-recon** (pull the customer's DSCO config), **dsco-portal-onboarding** (detailed 15-step portal walkthrough), **org-prebuild** (build the Orderful org from recon), **sps-recon** (migrating off SPS), **writing-outbound-jsonata** / **item-lookup** / **audit-rules** (NetSuite/Orderful mechanics), and the **aafes-dsco** reference (AAFES paths, guidelines, 850 structure, compliance $).
