# Inbound customer disambiguation (one partner ISA → several NetSuite customers)

A trading partner sends orders for more than one of its own buying entities — a US division and a Canadian division, two banners, a retail arm and a wholesale arm — all under **one** Orderful partnership and **one** sender ISA. Each entity has to land on its **own** NetSuite Customer record, and those records are deliberately *not* in a parent/child hierarchy.

This is the supported way to do that, and the traps in it.

## Don't do it with a JSONata `entityNetSuiteId` override

The tempting shortcut is advanced mapping on the ETT:

```jsonata
$defaultValues ~> | transaction | { "entityNetSuiteId": <A or B> } |
```

It works — for the Sales Order only. **The `customrecord_orderful_transaction` row stays stamped with whichever customer the ISA resolution originally picked**, because that resolution happens before the mapping runs. You end up with the OT on customer A and its Sales Order on customer B.

If the entities sit under a shared parent that's fine — the OT lands on the parent, which is a defensible roll-up. If they're **not** parent/child, the OT is simply attached to the wrong customer, and anything that reads the OT (audit, error triage, the `edi_trx` join, reprocessing) sees the wrong entity. Verified in a live account: OT entity = the ISA-resolved customer, SO entity = the JSONata target.

Use the ISA06 mechanism below instead. It moves the resolution itself, so the OT *and* the transaction land together.

## How resolution actually works

Two tiers, verified against `origin/dev` (`Repositories/entity.repository.ts` → `_getEntityByIsaId` and `pickEntityByInterchangeSenderId`; `TransactionHandling/orderful_inboundTransaction_LIB.ts` → `lookupCustomerConfig`):

1. **Primary — the Orderful *envelope* `senderIsaId`**, matched against Customer `custentity_orderful_isa_id` (live) / `custentity_orderful_isa_id_test` (test). Not the payload ISA06.
2. **Tiebreaker — the payload ISA06** (`message.interchangeControlHeader[0].interchangeSenderID`), consulted **only when more than one customer matched tier 1**.

So the design is: give **every** candidate customer the *same* partner ISA — that intentional collision is what switches the tiebreaker on — then separate them by ISA06.

### Where the tiebreaker value goes

| Field | Location | Status |
|---|---|---|
| `custrecord_edi_enab_interchange_id` | the **850 ETT** | Preferred (NS-1014). UI-hidden on every other document type — see `ConfigAndUISupport/enabledTransactionFieldMap.ts` |
| `custentity_orderful_inter_sender_id` | the **Customer** | Deprecated fallback, still read |

**Set both to the same value.** The two code paths disagree:

- the repository path (`getEntityByIsaId`, used by the inbound MR and the polling handler) always reads the **850** ETT override regardless of the inbound document type, falling back to customer-level;
- `lookupCustomerConfig` constrains via SuiteQL to the **current** document type's ETT — which is null on anything but an 850, because the field is hidden there — and falls back to customer-level.

Populate only the ETT field and non-850 inbound types quietly fall through to the customer field. Populate only the customer field and you're on the deprecated path. Set both.

### Two traps that don't announce themselves

**Strict equality, no normalisation.** The comparison is `effective === interchangeSenderId`. No trim, no padding fix-up. Real ISA06 arrives **space-padded to 15 characters** (`"<PARTNER_ISA>    "`), while a value you type into NetSuite or write from a rule usually isn't padded. Don't guess: put one real transaction through, read the inbound MR's `log.debug('interchangeSenderId', …)` line, and store *that* string verbatim in the NetSuite field.

**A no-match fails silently.** `pickEntityByInterchangeSenderId` returns `null` and the caller falls back to `allCustomers[0]`. Nothing errors; every order simply piles onto whichever candidate the query returned first. So the acceptance test is never "an SO was created" — it is **"the SO and the OT are on the customer I expected."**

## Prerequisite: every candidate needs its own ETT

`lookupCustomerConfig` JOINs `customer` to `customrecord_orderful_edi_customer_trans` for the inbound document type. **A customer with no ETT for that type never becomes a candidate at all** — it cannot be selected no matter what its ISA fields say. Create the inbound ETT on each entity before you touch the ISA fields, or the split silently does nothing.

Decide deliberately what to do with the ISA on the customer that used to receive everything:

- **Leave it populated** — it stays in the candidate set, so an ISA06 no-match falls back to today's behaviour. Safer during rollout, but it hides a broken rule.
- **Clear it** — resolution becomes deterministic across only the new entities. Cleaner, but check outbound first: that record may be supplying the receiver ISA and the ETTs for outbound document types.

## Driving ISA06 from message content (Orderful rule)

When the discriminator is *in the message* — currency, a ship-to id, a reference qualifier — an Orderful inbound rule can stamp ISA06 so the tiebreaker has something to match. See [`orderful-rules-engine.md`](orderful-rules-engine.md) for the REST contract.

```
path:      interchangeControlHeader.*.interchangeSenderID
direction: in
expression: SET( IF( EQUALS( INDEX(<reference to the discriminator>, 0), "<VALUE>" ),
                     "<ISA06_FOR_ENTITY_A>",
                     "<ISA06_FOR_ENTITY_B>" ) )
```

Points that cost time:

- **A `Reference` whose path contains array wildcards resolves to an ARRAY.** Handing that straight to a scalar function like `EQUALS` gets the rule rejected in the Orderful UI with *"Unexpected arguments. Objects and Arrays are unsupported."* Wrap it in `INDEX(ref, 0)`, or use `INCLUDES` (id 55), whose first argument *is* an array.
- **The REST API does not validate the expression.** A structurally-wrong expression returns `201`/`200` and reads back byte-identical. It only fails in the UI (and, presumably, at evaluation). There is no preview endpoint — `/v2/rules/{test,preview,simulate,evaluate}` all 404. **Open the rule in the UI after writing it.**
- **Omitting `liveExpression` on create is accepted** and leaves it `null`. That is the clean way to stage a rule on the test stream without touching live traffic. Remember it then has to be promoted deliberately at cutover — a test-only rule means live orders resolve by the `allCustomers[0]` fallback on day one.
- ⚠ **Nesting caveat, unresolved.** Gotcha 2 in [`orderful-rules-engine.md`](orderful-rules-engine.md) warns that nesting a function inside another function's value argument makes the outer one a no-op. That was observed on value transforms (`formatDate`/`concatenate` wrapping `substring`). The `SET(IF(EQUALS(INDEX(...))))` shape above is UI-accepted and `IF`'s arguments are declared `deferred` in `GET /v2/rules/functions`, which suggests predicate nesting is supported — but **runtime evaluation of this shape has not been confirmed end to end.** Verify on a real transaction before relying on it, and if the outer `SET` no-ops, fall back to a rule per branch guarded by `IF(EQUALS(...))` with the `fail` argument omitted.

Rewriting ISA06 deliberately looks identical to the misconfiguration that *breaks* this tiebreaker elsewhere (a carbon-copy rule stamping someone else's ISA). Note it in the customer's onboarding notes, or a later rules audit will "fix" it.

## Advanced mapping moves with the resolved customer

Once resolution lands on entity A or B, **advanced mapping is read from the resolved customer's ETT** — not from the record that used to receive the traffic. Any JSONata you still need has to be created on **each** entity's ETT for that document type. This is the most common thing forgotten when migrating off an `entityNetSuiteId` override: the routing keeps working and every other mapping behaviour silently disappears.

Currency is the usual casualty:

```jsonata
(
  $cur := message.transactionSets[0].currency[0].currencyCode;
  $defaultValues ~> | transaction | {
    "userDefinedFields": { "currency": $cur = "CAD" ? <cad-internal-id> : <usd-internal-id> }
  } |
)
```

- **`userDefinedFields: { "currency": <internal id> }` does set the native Sales Order currency.** Confirmed by A/B test: without this block the SO fell back to the **subsidiary's** home currency even though the inbound message carried the correct ISO code *and* the customer record's own currency field was correct. Don't assume either of those drives SO currency.
- Read the code from **`currency[0].currencyCode`**, matching how the connector itself reads it (`orderful_inboundTransaction_LIB.ts`). Filtering on a CUR01 qualifier (e.g. only `"BY"`) means the routing decision and the currency decision read different elements and can silently diverge — an order routed to the US entity while priced in the foreign currency.
- Older SuiteApp builds may not have `custrecord_orderful_currency_override` on the ETT at all, so the native Currency Override is not always available as a substitute. Probe for the field before designing around it.

## Testing without injecting through Orderful

When a relationship's test stream is pointed at a **production** poller, injecting a test transaction lands it in production NetSuite. You can still validate the whole NetSuite-side mechanism in a sandbox with no Orderful delivery at all:

1. Clone an existing **successful** OT row for the same document type.
2. In the clone's stored message, patch the ISA06, the discriminator value, and the PO number (a unique PO keeps `externalid` dedupe out of the way).
3. Set the clone's status to **Pending**.
4. Drive the inbound MapReduce (the agent-write RESTlet's `triggerInboundPolling`, or the script deployment).
5. Assert on **both** the OT's entity field and the resulting Sales Order's entity **and** currency.

Gotchas:

- The OT status list has **1 = Success, 2 = Pending**, and the pending-inbound query **excludes** Success. A clone left at status 1 is never picked up — which looks exactly like a broken rule.
- The MR may process roughly one row per run. Re-trigger until the queue drains rather than concluding the second case failed.
- Creating `customrecord_orderful_transaction` over REST requires `name`.
- Run the no-JSONata case first as a control. That A/B is what proves which layer is actually setting a field.

## Sandbox and production can run different SuiteApp builds

Same account family, different code. Observed in one account: the NS-1014 ETT interchange field present in production but **absent** in sandbox, and the agent-write RESTlet accepting only `triggerInboundPolling` in sandbox (no `reprocessTransaction`, which landed later).

Consequences worth internalising:

- Probe for a field with a SuiteQL `SELECT` before designing around it. An unknown column errors the query outright, which is a fast existence check.
- A green sandbox test does **not** prove the production path when the builds differ — say so explicitly when reporting results.
- Check the ISA-tiebreaker field and the currency-override field in *both* environments before writing the cutover plan; the fields you're told to use may only exist in one.
