# Partner acceptance semantics — a green Orderful status is not partner acceptance

Reference for a recurring false positive: reading a green Orderful status ("it says DELIVERED, we're done") when the trading partner actually **rejected** the document downstream. Applies to SPS-, Rithum/DSCO-, and direct-AS2-fed partners alike.

## What Orderful's statuses actually mean

On an outbound transaction:

- **`deliveryStatus = DELIVERED`** — the message left Orderful and reached the partner's mailbox / VAN (or, for a "keep in Orderful" channel, was retained).
- **`acknowledgmentStatus = ACCEPTED`** — the partner returned a **997 functional acknowledgment** accepting the **syntax** of the functional group.

Neither is proof the partner's **document processor** accepted the **data**. A transaction can show DELIVERED + ACCEPTED in Orderful and still be **application-rejected** by the partner — e.g. an 810 rejected because its ship-to GLN doesn't resolve or because there's no matching PO on the retailer's side; an 846 rejected for an unknown warehouse code.

## The rejection is invisible to the Orderful API

There is **no 824 (Application Advice) object exposed on `/v3/transactions`**. An application-level rejection surfaces **only** as a "Document Processing Error" / "Dataflow Error"–style **email to the customer's own contact** — never to Orderful, never on the transaction record. You cannot detect it by polling Orderful.

## How to confirm outbound success

- Confirm via the **partner portal** (SPS Fulfillment, Rithum/DSCO order history, etc.) or the **absence of an error email** in the customer's inbox — not by Orderful ack/delivery status alone.
- At go-live, ask the customer to **forward anything from the partner/VAN that looks like an error**, and treat those emails as the real acceptance verdict.
- Rule of thumb: **`997 ACCEPTED` ≠ applied at the application level.** Never declare an outbound document "done" from Orderful status alone.

## Don't confuse this with INVALID (an Orderful-side gate)

An **INVALID** transaction — one that failed Orderful *guideline* validation — is a different, *visible* state: it is **held, not delivered**, until it revalidates VALID or a user manually sends it, so `validationStatus` gates delivery on the Orderful side. That's the opposite situation: INVALID is an Orderful-side hold you *can* see in the API; the application rejection above is a partner-side rejection you *cannot*.

## Related

- [`outbound-dispatch.md`](outbound-dispatch.md) — the NS→Orderful send path and the status-update MR that sets Success/Error.
- [`skills/dsco-wire-testing`](../skills/dsco-wire-testing/SKILL.md), [`skills/audit-outbound-rules`](../skills/audit-outbound-rules/SKILL.md).
