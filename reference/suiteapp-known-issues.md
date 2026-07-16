# SuiteApp known issues — verified failure modes

Behaviors of the Orderful SuiteApp that will bite you, each one observed and confirmed in a live production account during a full retailer certification (SPS Commerce T&C, July 2026). These are empirical, not guessed from source. Where a behavior contradicts what you'd expect from the happy-path docs, the contradiction is called out. Cross-links point at the reference docs that explain the underlying machinery.

Severity key: 🔴 corrupts data or creates records · 🟡 blocks a workflow · ⚪ paper cut.

## 🔴 UOM mapping is not applied when the item resolves via an item-lookup record

With a correct UOM mapping in place (e.g. `CA → Master Case`, properly authored), inbound 850 lines whose items matched through `customrecord_orderful_item_lookup` records still landed on the sales order in the item's **base unit**. Quantities and amounts are silently wrong — nothing errors.

- **Detect:** after ingest, check SO line `units` against what the PO's UOM implies. If lines show the base unit on a customer with case-level ordering, this is it.
- **Workaround:** patch the SO lines manually (units + quantity + rate) before acknowledging/fulfilling.
- **Authoring note:** the mapping record's target field (`custrecord_orderful_uom_target`) rejects unit *names* ("Master Case", "CS") — it needs the unit's **internal id**, and the Target UOM Type must be populated.

## 🔴 Reprocess has two traps

See the status guard in [skills/reprocess-transaction](../skills/reprocess-transaction/SKILL.md) for the eligibility matrix. Two behaviors discovered beyond it:

1. **Reprocessing a `Pending` transaction is self-defeating.** The reprocess handler saves the record, which bumps its last-modified time — and the inbound MR's bulk pass only picks up records older than a freshness window (~10 minutes observed). Every reprocess restarts that clock, so repeatedly poking a Pending record guarantees it is never processed. Leave Pending records alone.
2. **A queued reprocess that runs later against an already-`Success` 850 creates records.** During a stalled-queue incident, reprocess tasks accepted earlier eventually executed against 850s that had since processed successfully — and each run auto-created a **system Item Fulfillment** (created-by shows `-System-`), shipping inventory nobody asked to ship. Five rogue IFs had to be found, deleted, and the inventory re-adjusted. The skill's status guard refuses Success *at call time*; it cannot protect against tasks already sitting in the queue.

## 🔴 Outbound acknowledgments can dispatch twice

Two byte-identical 855s reached the trading partner for one sales order: one from the deliberate flag-triggered dispatch, one system-fired. Probable mechanism: the ready-to-process flag stays `T` after the User Event dispatches, and the scheduled backstop MR sweeps flagged records within its back-processing window (see [outbound-dispatch.md](outbound-dispatch.md) — "the MR is a backstop"), so both paths can generate. Not fully root-caused; treat as live risk.

- **Impact:** duplicate documents at the partner. During certification, the rogue duplicate (a default all-accepted 855) got graded by the test platform before the intended document arrived.
- **Mitigation:** after any manual outbound fire, check for sibling OT rows for the same source record before assuming exactly one document went out.

## 🟡 ASN consolidation is unreachable as installed

The 856 enabled-transaction record offers a consolidation method (None / Parent 850 / Ship To), but selecting Ship To just defers generation to a consolidation MapReduce — and every consolidation deployment in the account was `NOTSCHEDULED`, with nothing (poller chain included) that ever triggers it. Multi-PO consolidated shipments — a standard scenario in retailer certifications — cannot be produced through the app.

- **Workaround:** build the consolidated 856 by hand from the fulfillments' packing data and POST it via the Orderful `/v3/transactions` API.

## 🟡 The 856 generator includes inactive cartons

Setting `isinactive = T` on a carton record does **not** exclude it from ASN generation — an inactivated pallet carton kept producing a Tare level in the 856. Only hard-deleting the carton record removed it.

- **Why it matters:** partners that require a flat Shipment→Order→Pack→Item structure (e.g. KeHE via SPS) reject any ASN with a Tare level, and the generator gives no hint the extra level came from a record you thought was retired.
- **Rule of thumb:** for flat-ASN partners, never create pallet cartons at all; if one exists, delete it, don't inactivate it.

## 🟡 Manually-created sales orders cannot be acknowledged

The 855 generator hard-requires a source inbound-850 Orderful Transaction. On SOs created by hand it dies with `search.lookupFields: Missing a required argument: id` — a message that says nothing about the real cause. Any customer mixing manual and EDI orders for the same partner will hit this.

- **Detect:** OT row in `Error` with that message + an SO with no linked inbound 850.
- **Workaround:** none in-app; build the 855 externally if the partner requires it, or exclude manual orders from EDI acknowledgment expectations.

## 🟡 Inbound processing is invisible when the account's queue stalls

Inbound MR deployments are `NOTSCHEDULED` by design — processing only runs chained from poller triggers (see [mapreduce-monitoring.md](mapreduce-monitoring.md) for how to watch it). During a NetSuite processor-queue stall, API-submitted MR tasks were **accepted but never started** — layer-1 status stayed queued indefinitely with no error anywhere.

- **Playbook that worked:** a UI-initiated **Save & Execute** on the deployment bypasses the API task queue; the **Map/Reduce Script Status** page shows queue state SuiteQL can't; stalled queues tend to self-clear at the top of the hour when reserved processors free up. Escalate internally if it persists past that.

## ⚪ Paper cuts

- **Carton names via REST:** custom-record `name` is rejected ("Please enter value(s) for: Name") — write `altName` instead.
- **OT internal ids are not chronological across refires:** a regenerated row was observed with a *lower* internal id than its predecessor. Find the newest outbound by the Orderful transaction id (or created timestamp), never `ORDER BY id`. (Same family as the `scheduledscriptinstance.internalid` ordering trap in [mapreduce-monitoring.md](mapreduce-monitoring.md).)
- **No shipping-label capability:** the SuiteApp has nothing for GS1-128 case labels; certifications that require label uploads (SSCC-18, content, and postal barcodes) need an external generator. See [gs1-sscc-formula.md](gs1-sscc-formula.md) for the check-digit math.
