---
name: dsco-wire-testing
description: Run the end-to-end wire-based testing cycle for a customer connecting to a retailer through DSCO/Rithum dropship — from AS2 attachment through test 850s, outbound 856/810, portal scenario completion, and retailer activation. Use when the user says "DSCO testing", "Rithum test orders", "the retailer sent test 850s", "complete the DSCO scenarios", "how does DSCO certification work", "activate the DSCO connection", or is onboarding any customer to a retailer via DSCO/Rithum (Nordstrom, AAFES, Macy's, etc.). Covers what's different about DSCO vs. upload-portal programs, the NetSuite/SuiteApp-side machinery, and the traps (Complete button deletes test data; activation is by email).
---

# DSCO Wire Testing

Run a customer's dropship certification with a retailer that trades through DSCO (Rithum, formerly CommerceHub). This is the *testing process* skill — the portal's step-by-step checklist is self-guided and retailer-flavored, but the wire mechanics, the NetSuite-side machinery, and the activation traps are the same for every DSCO retailer.

## The one-line model

DSCO testing is **wire-based and self-guided**: Rithum auto-sends real test 850s over the AS2 the moment the connection is attached, expects the full document round trip back over the wire, and tracks completion as portal scenarios. There is **no manual X12 download/upload anywhere**. (Contrast: OpenText Compliance Link is a manual file-upload portal; SPS and OrderStream are different again.) Once the AS2 is live, treat the connection as *hot* — inbound test orders can arrive at any time without scheduling.

## When to use

- "The customer got their DSCO/Rithum invitation — what's the process?"
- "Rithum sent test 850s, what do we do with them?"
- "Complete the DSCO shipping/cancellation/invoicing scenarios"
- "Why isn't the retailer activating us? We clicked Complete."
- Planning or executing any customer × retailer onboarding where the retailer's EDI runs through DSCO

## Inputs the skill needs

1. **Customer + retailer** and their Orderful partnership (relationship IDs per doc type).
2. **DSCO portal access** — the vendor's one-time invitation link / portal login (the customer usually owns this; get credentials or a screen-share).
3. **NetSuite access** (sandbox for testing) via the customer's `.env` — see `netsuite-setup`.
4. **The brand's ISA ID** — note the account-model section below; the ISA belongs to the *brand*, the Rithum account to the *pay-to vendor*.

## The account model (trips everyone)

- The Rithum account is named by **Pay-to Vendor, not trading brand**: e.g. "ACME CORPORATION - 1234567" with the actual consumer brand as a sub-brand under it. The EDI still runs under the **brand's** ISA.
- **One Rithum account per Pay-to-Vendor × retailer banner** (a retailer's main site and its off-price/outlet banner are separate accounts).
- Rithum routes inbound **by sender ISA** on their side; Orderful's shared AS2 station serves all DSCO customers (`as2.rithum.com` on the Rithum end).
- Rithum support needs the **account admin username** to attach the AS2 to the account.
- SuiteApp implication: if the brand's ISA differs from the NetSuite subsidiary's default ISA, set the company-ISA overrides on every outbound Enabled Transaction record (`custrecord_edi_enab_trans_isa_company` + `_isa_comp_test`) — otherwise Orderful 422s with "partnership between sender X and DSCO doesn't exist" because the subsidiary ISA leaks as sender.

## The recipe

### Step 1 — Account + invitation

The retailer's dropship-onboarding team invites the vendor (one-time link). Expect an SLA with a "consistent progress" expectation — stalled onboardings risk cancellation, so keep the cadence up.

### Step 2 — Portal onboarding (self-guided steps)

~15 self-guided portal steps at `app.dsco.io`: company/billing contacts, supply warehouses (address, **warehouse code**, shipping calendar with days/cutoffs/holidays), notification preferences (pipeline exception alerts → an inbox someone actually reads), inventory/SKU load. Drive the forms with starter values from NetSuite (see `o2c-discovery` patterns) and have the customer validate after. Real SKUs preferred; dummy SKUs allowed but Rithum must remove them pre-activation.

The **warehouse code** you register here matters later: it's the code outbound 856s (`REF*ZZ`) and 846s (`REF*WS`) must echo. Use the code, not the warehouse's display name.

### Step 3 — AS2 attachment

Via Rithum partner setup (see the retailer reference doc for contacts), supplying the account admin username. Envelope: version **005010**, sender `ZZ`/`DSCO`, receiver `12`/`{brand ISA}`.

### Step 4 — Wire testing begins automatically

Rithum sends real test 850s (consumer ship-to, usually single-unit) **with no scheduling** the moment the AS2 is live. They flow AS2 → Orderful TEST stream → SuiteApp inbound poller → Sales Orders. Before this point, run `audit-outbound-rules` and have the inbound mapping ready (Step: NetSuite-side machinery below).

### Step 5 — Pass the portal scenarios

Portal-tracked scenario set, all end-to-end over the wire: orders in, acknowledgments, shipping **including a multi-line partial shipment**, and cancellations. Notes from the field:

- **Sanctioned test tracking numbers**: the shipping scenarios publish an "allowed ship methods" table with specific test tracking numbers per ship method. Use exactly those on the test 856s — each number is consumable, so budget them across scenarios. (The EDI *import* layer doesn't enforce them, but the scenario checker does.)
- **One line, one item HL**: if the same order line appears under multiple item HLs (e.g. a WMS split one line across two cartons), Rithum rejects the 856 with "Duplicate line_number". Consolidate cartons so each order line appears once.
- **997s only flow after you create the EDI Import job** in the portal (with "Generate 997" checked, filename `*`). Until then outbound docs sit NOT_ACKNOWLEDGED — that's the job missing, not a delivery failure.
- **Cancellations day-to-day** happen in the Rithum portal Orders page — no EDI required. Only build an outbound 870 (Order Status Report) if the scenario demands it or volume justifies automating; the 870 is not SuiteApp-native (see `custom-process-transactions`).

### Step 6 — Outbound legs (856/810)

Item Fulfillment + Orderful carton/tracking records → ready-to-process flag → 856 (see `build-mock-fulfillments`). Bill the SO → flag → 810 (see `bill-and-fire-810`). Validate against the retailer's DSCO guidelines in Orderful (`fetch-validations`) and confirm DELIVERED over the AS2.

### Step 7 — Orderful platform close-out

Complete the scenario checklists on the partnership so relationships go READY. Checklist bypass is leader-side-gated — needs an admin acting as the retailer org.

### Step 8 — Pre-activation (the retailer's gate, all vendor-side)

Retailer-specific checklist, typically: carrier/ship-code readiness, third-party billing account setup, ticketing/packaging compliance per the retailer's dropship manual, and a minimum number of active Rithum portal contacts. See the retailer's reference doc for specifics. These are vendor obligations — surface them to the customer early; they're the long pole after EDI is done.

### Step 9 — Activation = email, not button

Completion is confirmed by **emailing the retailer's dropship-onboarding team**. **Clicking "Complete" in the portal deletes the test data without activating** — do not click it. After activation, items publish only when positive Rithum inventory exists and the retailer's item-setup/creative process is done — a merchandising dependency outside EDI. The onboarding team drops off after activation; ops issues go to the retailer's post-activation contact.

## NetSuite-side machinery (SuiteApp customers)

**Inbound 850 → SO.** Three things prior middleware typically set silently that the ECT mapping must now own (see `writing-inbound-jsonata`):

1. **Cancel-by date**: DSCO test 850s don't send DTM 001/063. If the SO form mandates a cancel date, build a fallback chain across DTM qualifiers (001→063→175→038→996).
2. **Order channel / approval gating**: dropship orders are single-unit consumer orders — if the customer has wholesale order-approval rules (case-pack checks etc.), set whatever field exempts dropship (e.g. an order-channel custom field) *at creation time* so SOs auto-approve.
3. **Ship method**: DSCO's TD5 carries the *routing text* (e.g. "Ground"), not the service code. If the customer has their own EDI routing table custom record from prior middleware, join on it at mapping time (`$lookupSingleSuiteQL`, customer id from `$defaultValues.transaction.entityNetSuiteId` — `metaData.customerConfig.*` is empty at eval time). Future service levels then become customer-added table rows, zero mapping changes.

**Fulfillment chain**: SO → the customer's own fulfillment pipeline (fulfillment requests, WMS, ship-confirm MRs — discover what's scheduled vs. manual before assuming IFs will appear) → pack cartons + tracking → 856.

**Clean-replay rule**: when a mapping fix lands, delete/void the SOs and downstream artifacts and reprocess the inbound transactions (`reprocess-transaction`, `cleanup-orderful-transactions`). Patching SOs in place leaves stale downstream artifacts (channel, shipper on fulfillment requests) that a sharp customer EDI coordinator will catch.

**Prod cutover mirror list**: every fix above lives in sandbox until cutover. Keep a running list — ECT mapping items, ISA overrides, routing-table rows, inventory-feed wiring, prod integration tokens — and mirror them deliberately. Also settle the pricing-model decision ("Use EDI Pricing" = bill the PO price; price-discrepancy checks then can't fire — a variance report is the middle path).

## Behaviour rules

1. **Test in sandbox NetSuite against the Orderful TEST stream only.** Never point wire testing at a production NetSuite or LIVE stream.
2. **Never click the portal's "Complete" button.** Activation is by email to the retailer; Complete deletes test data.
3. **Treat the AS2 as hot from attachment.** Inbound test 850s arrive unscheduled — have the inbound mapping and poller ready *before* the AS2 is attached, or expect failed first impressions.
4. **Use the portal's sanctioned test tracking numbers** on shipping scenarios; don't burn them on drafts.
5. **Clean-replay after mapping fixes** — don't hand-patch SOs mid-certification.
6. **Don't build an 870 by default.** Portal-UI cancellation is the sanctioned day-to-day path; automate only on demonstrated volume.
7. **Surface the retailer's pre-activation checklist to the customer at kickoff**, not at the end — items like third-party billing accounts and ticketing compliance are on the vendor's critical path and are slower than the EDI work.
8. **Anchor every retailer-specific fact in a reference doc**, not in ad-hoc session knowledge — contacts, envelope IDs, sanctioned codes drift, and the next contractor needs one place to check.

## Reference material

- [`reference/nordstrom-dsco.md`](../../reference/nordstrom-dsco.md) — Nordstrom-specific program facts (account model, contacts, pre-activation gates, activation email format)
- Related skills: `audit-outbound-rules`, `inject-test-transaction`, `build-mock-fulfillments`, `bill-and-fire-810`, `fetch-validations`, `writing-inbound-jsonata`, `writing-outbound-jsonata`, `reprocess-transaction`, `cleanup-orderful-transactions`, `custom-process-transactions`
