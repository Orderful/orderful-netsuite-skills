# Nordstrom Dropship via DSCO/Rithum — program facts

Verified during a live vendor onboarding (mid-2026). Nordstrom's consumer dropship program ("n.com") runs entirely through DSCO/Rithum — see the `dsco-wire-testing` skill for the process; this doc is the Nordstrom-specific facts.

## Programs and contacts

Nordstrom runs dropship onboarding and B2B EDI as **separate programs with separate teams** — don't cross the streams.

| Function | Contact | Notes |
|---|---|---|
| Drop Ship Onboarding (n.com) | dsonboarding@nordstrom.com | Owns invitation and the activation gate. Team inbox — individuals cover. |
| Rithum partner setup | dscopartnersetup@rithum.com | AS2 / account attachment. Needs the vendor's Rithum **account admin username**. |
| EDI Setup (B2B wholesale — separate program) | edisetup@nordstrom.com | Not involved in dropship. |
| Post-activation dropship ops | DropShip@nordstrom.com | The onboarding team drops off after activation. |

## Account model

- Rithum account is named by **Pay-to Vendor**: "VENDOR NAME - {vendor number}", with the trading brand as a sub-brand (its own supplier number) under it. EDI runs under the **brand's** ISA, not a pay-to-vendor ISA.
- **n.com and Nordstrom Rack (r.com) are separate Rithum accounts** — one per Pay-to-Vendor × banner.
- Rithum routes inbound by **sender ISA**; the AS2 endpoint is `as2.rithum.com` and one Orderful shared station serves all DSCO customers.

## Envelope / wire

- X12 **005010**; DSCO side is `ZZ`/`DSCO`, vendor side `12`/`{brand ISA}` (i.e. phone-number-style ISAs qualified `12`).
- Test 850s: consumer ship-to, single-unit, sent automatically once the AS2 attaches — no scheduling, no warning.
- Test 850s carry **no DTM 001/063** (cancel-by) — inbound mappings that require a cancel date need a fallback chain (001→063→175→038→996).
- TD5 carries the **routing text** ("Ground"), not a carrier service code; the vendor's DSCO "allowed ship methods" table maps text ↔ service codes (e.g. UPCG = UPS Ground, U2DA = UPS 2nd Day Air).

## Portal testing specifics

- Scenario set: inventory update, order acknowledgment, shipping (single-line), **multi-line partial shipment**, cancellation. All wire-based and portal-tracked.
- Shipping scenarios publish **sanctioned test tracking numbers per ship method**; each is consumable. The scenario checker enforces them; the EDI import layer does not.
- 856s: each order line may appear in only one item HL ("Duplicate line_number" import failure otherwise); warehouse code goes in `REF*ZZ` and must match a warehouse **code** registered in the portal (not the warehouse name).
- 997s flow only after the vendor-side **EDI Import job** exists (Generate 997 checked, filename `*`, source = the DSCO AS2).
- Inventory feed is an X12 **846** — warehouse code in `REF*WS`, and the code must be registered in the portal or DSCO rejects at import with "Unknown warehouse code" (997 ACCEPTED is separate from app-level import success).
- Day-to-day cancellations are done in the Rithum portal Orders page; the EDI path is an 870 Order Status Report (BSR `2`/`PP`, HL O with PRF + `REF*IA` = vendor DSCO id, HL I with PO1 + ISR `IC` + a `statusReasonCode` from the guideline enum, e.g. W01/W13).

## Pre-activation checklist (Nordstrom's gate — all vendor-side)

1. **Ship codes readiness** — the vendor declares which of the allowed ship methods they support.
2. **Third-party billing** — vendors ship on **Nordstrom's UPS third-party billing account** (`<get the account number from the current DS Manual — reconfirm on each onboarding>`); collect and prepaid are **prohibited**. Beware internal NetSuite ship-method labels that say "Prepaid" — what matters is the third-party billing setup at the carrier.
3. **RFID-enabled price tickets** per the DS Manual — a merchandising task, not EDI.
4. **≥2 active Rithum portal contacts** on the account.
5. Pack slips / return cards: **no longer required** (DS guide revision dated 11/24/2025) — don't let an old checklist stall the vendor.

## Activation

- Completion is confirmed by **email to dsonboarding@nordstrom.com** with subject format: `"{PAY-TO VENDOR NAME} v#{vendor number} — n.com"`.
- **Do not click the portal "Complete" button** — it deletes test data without activating.
- 30-day onboarding SLA with a "consistent progress" expectation; stalls risk cancellation of the onboarding.
- After activation, items publish to n.com only when (a) positive inventory exists in Rithum and (b) the item-setup/creative process with the Nordstrom Buy team is complete — a merchandising dependency outside EDI entirely.
