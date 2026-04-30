# Outbound JSONata reference

Technical reference for authoring JSONata expressions that override the Orderful SuiteApp's default outbound message mapping.

> **Schema note**: Outbound messages here use **Orderful's JSON schema** — a JSON form of EDI X12. This is *not* the same as **Mosaic**, which is a separate, newer, simplified Orderful schema for common transaction types. Everything in this reference is about the JSON-X12 schema unless explicitly noted otherwise.

JSONata expressions run inside the SuiteApp's outbound message generator. They live on the customer's `customrecord_orderful_edi_customer_trans` record (the EDI Enabled Customer Transaction, or "ECT") in the `custrecord_edi_enab_jsonata` field. The version selector `custrecord_edi_enab_trans_jsonata_ver` should be set to **V2** for the transform syntax used throughout this reference.

## Where the expression runs

The SuiteApp's outbound JSONata engine evaluates expressions via:

```js
expression.evaluate(input, context)
```

— where `input` becomes JSONata's **root context** (accessed by name without `$`) and `context` is bound as **`$variables`** (accessed with `$prefix`).

The engine also registers two custom functions: `$lookupSingleSuiteQL` and `$lookupMultiSuiteQL`. Both run against the live NetSuite account during evaluation.

## Available variables

### Root context (no `$` prefix)

| Name | Shape | Notes |
|---|---|---|
| `currentOrderfulTransaction` | The outbound transaction record being built | All `custrecord_ord_tran_*` fields |
| `inboundOrderfulTransaction` | The originating inbound transaction (e.g. the 850 that led to this 856) | Null for purely-outbound flows |
| `salesOrders[]` | Related Sales Orders, fully loaded | One per linked SO |
| `invoices[]` | Related Invoices | For 810 flows |
| `itemFulfillments[]` | Related Item Fulfillments | For 856 flows; `[0].id`, `[0].tranid`, all `custbody_*` fields are accessible |
| `customer` | The trading partner Customer entity | Includes `companyName`, `enabledTransactionTypes`, etc. |
| `authorizedDiscounts[]` | Customer's authorized discount lookups | For 810 flows that need SAC normalization |

These come from the SuiteApp's `getJoinedTransactions()` repository call, which selects all columns from the `transaction` table for the linked record IDs. Custom body fields ARE available here (since `selectAll()` returns them).

### Bound `$` variables (from context)

| Name | Available for | Notes |
|---|---|---|
| `$defaultValues` | 810, 855, 856, 940, 846, simplified PO ack/shipment/invoice, 943 | The pre-built message the SuiteApp would otherwise send. **Wrapped envelope** — see below. |
| `$dataset` | When an analytics dataset is configured on the ECT | Per-row results from the dataset; useful for inventory advice (846) and similar |
| `$savedSearch` | When a saved search is configured on the ECT | Per-row results from the saved search |

### Registered functions

```jsonata
$lookupSingleSuiteQL(queryString)     /* runs SuiteQL, returns 1 row as object */
$lookupMultiSuiteQL(queryString)      /* runs SuiteQL, returns array of rows */
```

Constraints (these are enforced by the SuiteApp wrapper, not JSONata itself):

- **Max 3 JOINs in the FROM clause.** Implied joins (`FROM a, b WHERE a.id = b.id`) count too. Exceeding this throws `lookupSuiteQL error: Only up to 3 joins are supported`.
- **`$lookupSingleSuiteQL` errors if more than 1 row returns.** The wrapper rewrites bare `SELECT` to `SELECT TOP 2` to detect over-matching. If you write `SELECT TOP 1` explicitly, that stays as `TOP 1` and you guarantee a single row. Always include `ORDER BY` when using `TOP 1` so the choice is deterministic.
- **No write SQL.** SELECT only.

## The wrapped-envelope gotcha

`$defaultValues` is NOT just the X12 message body. It's wrapped:

```jsonc
{
  "sender":   { "isaId": "..." },
  "receiver": { "isaId": "..." },
  "type":     { "name": "856_SHIP_NOTICE_MANIFEST" },
  "stream":   "TEST",
  "message":  { "transactionSets": [ ... ] }   // ← actual EDI message lives here
}
```

**All transform paths must include `message.`** as the first segment after `$defaultValues`. Example:

```jsonata
$defaultValues
  ~> | message.transactionSets[0].HL_loop[0].N1_loop[0] |
     { ... } |
```

Why this trips people up: Orderful's `/v3/transactions/{id}/message` REST endpoint returns the *unwrapped* inner `message` object. So if you copy a path from the Orderful UI's Rules Editor — which is showing the unwrapped form — and paste it into JSONata, the path will be one level too shallow and match nothing.

You can also confirm the wrapped shape directly by reading the SuiteApp's saved message:

```sql
SELECT custrecord_ord_tran_message
FROM customrecord_orderful_transaction
WHERE id = <ns_tran_id>
```

The result is a JSON string — parse it and you'll see the `{sender, receiver, type, stream, message}` structure that JSONata sees as `$defaultValues`.

## The transform operator: `~> | path | update |`

JSONata's transform operator does a **shallow merge** of the `update` object into the value(s) at `path`:

```jsonata
$defaultValues ~> | message.transactionSets[0].HL_loop[0] |
  { "newKey": "value", "existingKey": "newValue" }
|
```

- The keys in the update object **replace** the corresponding keys at the location.
- Keys at the location that you don't mention are **preserved**.
- The whole `~> | ... | ... |` chain returns a copy of `$defaultValues` with the change applied.

Two non-obvious behaviors:

### Replacement context is the LOCATED value, not root

Inside the `update` block, JSONata's evaluation context is whatever the `path` matched, NOT the original root input. This means:

```jsonata
$defaultValues ~> | message.transactionSets[0].HL_loop[0].N1_loop[0] |
  {
    "name": itemFulfillments[0].custbody_vendor_name   // ← will NOT resolve
  }
|
```

…fails silently. `itemFulfillments[0]` doesn't exist relative to the matched N1_loop entry. Bind root data to `$vars` BEFORE the transform:

```jsonata
(
  $vendorName := itemFulfillments[0].custbody_vendor_name;

  $defaultValues ~> | message.transactionSets[0].HL_loop[0].N1_loop[0] |
    { "name": $vendorName }
  |
)
```

### Path expressions can fan out

A path with no array index fans out across all matching elements:

```jsonata
~> | message.transactionSets[0].HL_loop.itemIdentification[0] |
   { "productServiceIDQualifier": "IN" } |
```

This applies the update to **every** `itemIdentification[0]` across all `HL_loop` entries. Only I-level entries have `itemIdentification`, so it's effectively "for every item line, set LIN02". Useful when you want one rule applied to many lines.

### Undefined values omit the key

If a key in the `update` object resolves to `undefined`, JSONata **omits** the key from the result entirely. This can be either a feature or a footgun:

```jsonata
"identificationCode": $someValueThatMightBeNull
```

If `$someValueThatMightBeNull` is null, the result has no `identificationCode` key. If the partner's spec REQUIRES that field, you'll get a validation error. Use a fallback:

```jsonata
"identificationCode": $someValueThatMightBeNull ? $someValueThatMightBeNull : "default"
```

## Orderful JSON field names that bite

Orderful's outbound schema uses specific field names that don't always match the X12 element name. If you guess and get it wrong, the SuiteApp returns `must NOT have additional properties - <field>` from the local schema validation step (before any partner sees the message).

| X12 element | Orderful JSON field name | NOT |
|---|---|---|
| TD108 (Unit / Basis for Measurement Code) | `unitOrBasisForMeasurementCode` | ~~`unitOfMeasureCode`~~ |
| TD106 (Weight Qualifier) | `weightQualifier` | (matches) |
| TD107 (Weight) | `weight` | (matches) |
| BSN05 (Purchase Order Type Code) | Lives on `purchaseOrderReference[0].purchaseOrderTypeCode` at the HL O level — **NOT on `beginningSegmentForShipNotice[0]`** | ~~`beginningSegmentForShipNotice[0].purchaseOrderTypeCode`~~ |
| N101 (Entity Identifier Code) | `partyIdentification[0].entityIdentifierCode` |  |
| N102 (Name) | `partyIdentification[0].name` |  |
| N103 (Identification Code Qualifier) | `partyIdentification[0].identificationCodeQualifier` |  |
| N104 (Identification Code) | `partyIdentification[0].identificationCode` |  |
| N301 (Address Information) | `partyLocation[0].addressInformation` |  |
| N302 (Address Information 2) | `partyLocation[0].addressInformation1` |  |
| N401-N404 | `geographicLocation[0].cityName`, `.stateOrProvinceCode`, `.postalCode`, `.countryCode` |  |
| LIN02 (Product/Service ID Qualifier) | `itemIdentification[0].productServiceIDQualifier` |  |

When you're unsure, **read the NS-saved message first** to find the exact field name the SuiteApp uses for that element. Don't guess.

## Common SuiteQL patterns

### IF's first-line Location → main address + subsidiary legal name

A single 3-join lookup that gets the ship-from address and shipper legal name from the IF's first valid line:

```jsonata
$ifId := $string(itemFulfillments[0].id);

$locAddr := $lookupSingleSuiteQL(
  "SELECT TOP 1 " &
    "lma.addr1 AS addr1, lma.addr2 AS addr2, " &
    "lma.city AS city, lma.state AS state, lma.zip AS zip, lma.country AS country, " &
    "s.legalname AS legal_name " &
  "FROM transactionline tl " &
  "JOIN location loc ON tl.location = loc.id " &
  "JOIN locationmainaddress lma ON loc.mainaddress = lma.nkey " &
  "JOIN subsidiary s ON tl.subsidiary = s.id " &
  "WHERE tl.transaction = " & $ifId & " AND tl.location IS NOT NULL " &
  "ORDER BY tl.linesequencenumber"
);
```

Notes:
- `transaction.subsidiary` is NOT_EXPOSED for SEARCH. Use `transactionline.subsidiary` instead.
- `locationmainaddress` is a NetSuite-built-in view; join via `loc.mainaddress = lma.nkey`.
- Exactly 3 JOINs — the cap.

### Sum carton weights from `$defaultValues` (dataset-driven cartons)

When packing comes from an analytics dataset rather than `customrecord_orderful_carton` records, the SuiteApp writes one HL `P` (Pack/Tare) entry per carton into `$defaultValues`. The dataset can be configured to include weight per carton. Sum across P entries:

```jsonata
$cartonWeights := $defaultValues.message.transactionSets[0]
  .HL_loop[hierarchicalLevel[0].hierarchicalLevelCode = "P"]
  .carrierDetailsQuantityAndWeight[0].weight;

$totalWeight := $string($sum($cartonWeights.$number($)));
```

`$cartonWeights.$number($)` maps each string weight to a number (the field is a string in the message); `$sum` returns 0 if there are no P entries.

### Sum carton weights from `customrecord_orderful_carton`

For customers whose cartons are stored in records (not a dataset):

```jsonata
$weightRow := $lookupSingleSuiteQL(
  "SELECT SUM(custrecord_orderful_carton_weight) AS total " &
  "FROM customrecord_orderful_carton " &
  "WHERE custrecord_orderful_carton_fulfillment = " & $ifId
);
$totalWeight := $string($weightRow.total ? $weightRow.total : 0);
```

## Annotated worked example: outbound 856 for a hypothetical retailer

Below is a complete JSONata expression for "Acme Foods" (customer slug `acme-foods`) outbound 856. It addresses a representative set of partner-spec divergences:

- Default mapper produces empty SF (Ship From) — partner rejects qualifier-only N1
- Default mapper writes `N1*ST` at HL S — partner doesn't allow ST at this level
- Default `referenceInformation` qualifier is `WH` — partner only allows certain values, requires `BM`
- Default `productServiceIDQualifier` is `PI` — partner allows only `UK`/`IN`/`VN`/`LT`
- Partner requires `purchaseOrderTypeCode` on the HL O `purchaseOrderReference`
- Partner requires weight elements on the shipment-level TD1
- SCAC must come from `custbody_scac` on the IF

```jsonata
(
  /* SECTION 1 — gather data via lookups */

  $ifId := $string(itemFulfillments[0].id);

  /* SCAC = Standard Carrier Alpha Code, set on the IF when the carrier is selected. */
  $scac := itemFulfillments[0].custbody_scac;

  /* Use the IF's tranid (= shipmentIdentification in the BSN) as the BOL number. */
  $bolNumber := $defaultValues.message.transactionSets[0]
                  .beginningSegmentForShipNotice[0].shipmentIdentification;

  /* SF address + shipper legal name from first valid line's location.
     - transaction.subsidiary is NOT_EXPOSED for SEARCH; use tl.subsidiary.
     - locationmainaddress is NS built-in; join on loc.mainaddress = lma.nkey.
     - lookupSingleSuiteQL caps at 3 JOINs. This uses 3.
     - TOP 1 stays as TOP 1; without it the wrapper rewrites to TOP 2 + errors on >1 row. */
  $locAddr := $lookupSingleSuiteQL(
    "SELECT TOP 1 " &
      "lma.addr1 AS addr1, lma.addr2 AS addr2, " &
      "lma.city AS city, lma.state AS state, lma.zip AS zip, lma.country AS country, " &
      "s.legalname AS legal_name " &
    "FROM transactionline tl " &
    "JOIN location loc ON tl.location = loc.id " &
    "JOIN locationmainaddress lma ON loc.mainaddress = lma.nkey " &
    "JOIN subsidiary s ON tl.subsidiary = s.id " &
    "WHERE tl.transaction = " & $ifId & " AND tl.location IS NOT NULL " &
    "ORDER BY tl.linesequencenumber"
  );

  /* Total shipment weight = sum of P-level HL carton weights from $defaultValues.
     Only used when packing comes from an analytics dataset; for record-based
     packing, replace with a SuiteQL sum over customrecord_orderful_carton. */
  $cartonWeights := $defaultValues.message.transactionSets[0]
    .HL_loop[hierarchicalLevel[0].hierarchicalLevelCode = "P"]
    .carrierDetailsQuantityAndWeight[0].weight;
  $totalWeight := $string($sum($cartonWeights.$number($)));

  /* SECTION 2 — chained transforms */

  $defaultValues

    /* HL O purchaseOrderTypeCode — partner requires this code.
       <ASSUMPTION: every order to this partner is drop-ship. If they ever
        also send warehouse-routed POs, this needs to switch on a signal
        (SO location, custom body field, etc).> */
    ~> | message.transactionSets[0].HL_loop.purchaseOrderReference[0] |
       { "purchaseOrderTypeCode": "DS" } |

    /* HL S level — replace N1_loop entirely (drop the ST entry the partner
       rejects, keep only SF) and replace referenceInformation with REF*BM. */
    ~> | message.transactionSets[0].HL_loop[0] |
       {
         "N1_loop": [{
           "partyIdentification": [{
             "entityIdentifierCode": "SF",
             "name": $locAddr.legal_name
           }],
           "partyLocation": [{
             "addressInformation":  $locAddr.addr1,
             "addressInformation1": $locAddr.addr2
           }],
           "geographicLocation": [{
             "cityName":             $locAddr.city,
             "stateOrProvinceCode":  $locAddr.state,
             "postalCode":           $locAddr.zip,
             "countryCode":          $locAddr.country,
             "locationQualifier":    "CC"
           }]
         }],
         "referenceInformation": [{
           "referenceIdentificationQualifier": "BM",
           "referenceIdentification": $bolNumber
         }]
       } |

    /* TD1 weight elements — partner requires gross weight, in pounds.
       <ASSUMPTION: this customer ships in lbs. EU subsidiaries would need
        to source unitOrBasisForMeasurementCode dynamically.> */
    ~> | message.transactionSets[0].HL_loop[0].carrierDetailsQuantityAndWeight[0] |
       {
         "weightQualifier": "G",
         "weight": $totalWeight,
         "unitOrBasisForMeasurementCode": "LB"
       } |

    /* TD5 SCAC — applied to every HL level that carries a TD5. */
    ~> | message.transactionSets[0].HL_loop.carrierDetailsRoutingSequenceTransitTime[0] |
       { "identificationCode": $scac } |

    /* LIN02 — partner allows only UK/IN/VN/LT. Default mapper writes "PI"
       which is rejected. The 7-digit value is the partner's catalog SKU =
       Buyer's Item Number → "IN".
       <ASSUMPTION: this rule is partner-wide. If different partners want
        different qualifiers, this whole transform belongs in their
        respective ECT JSONata, not here.> */
    ~> | message.transactionSets[0].HL_loop.itemIdentification[0] |
       { "productServiceIDQualifier": "IN" } |
)
```

Substitute partner-specific values (`"DS"`, `"IN"`, `"G"`, `"LB"`, `"BM"`, `"CC"`) from the partner's published 856 spec — every retailer has different code lists.

## Local testing harness

Iterating against NetSuite is slow (~30s per reprocess). Iterating locally with the `jsonata` package is sub-second:

```js
import jsonata from 'jsonata';

// Reconstruct the wrapped envelope JSONata sees in NS:
const defaultValues = {
  sender:   { isaId: '<sender-isa-id>' },
  receiver: { isaId: '<receiver-isa-id>' },
  type:     { name: '856_SHIP_NOTICE_MANIFEST' },
  stream:   'TEST',
  message: /* the inner message JSON copied from custrecord_ord_tran_message */
};

// Stand-in for the runtime input:
const input = {
  itemFulfillments: [{
    id: 1234567,
    tranid: '<bol-number>',
    custbody_scac: '<scac>',
    /* any other custom body fields the expression references */
  }],
  customer:   { id: 1234567, companyName: 'Acme Foods' },
  salesOrders: [],
  invoices:    [],
  /* etc */
};

const expression = jsonata(JSONATA_EXPR);
const result = await expression.evaluate(input, { defaultValues });

// Verify the segments that should have changed:
console.log(JSON.stringify(
  result.message.transactionSets[0].HL_loop[0].N1_loop[0],
  null, 2
));
```

For transforms that depend on `$lookupSingleSuiteQL`, mock the `$var` it produces with a hardcoded value during local testing, then swap back to the lookup before pushing.

## Schema gaps that JSONata cannot fix

JSONata can only set fields that exist in Orderful's outbound JSON schema for the document type. If a partner requires an X12 element that Orderful's schema doesn't currently expose at any path, the SuiteApp's local schema validation rejects the payload before send with `must NOT have additional properties - <fieldName>`.

When you hit this:
1. Search the SuiteApp's outbound message-shape definitions to confirm the field genuinely isn't there (don't conclude this from one failed attempt — try alternative field names first).
2. File a feature request with Orderful naming the X12 element, the partner that requires it, and the document type.
3. Document the gap inline in the JSONata as a `/* NOTE: <element> can't be set — Orderful schema gap */` so the next maintainer doesn't re-discover it.

## Reprocess flag reference

After PATCHing the JSONata onto the ECT, trigger reprocessing by flipping the run-control flag for the source record:

| Doc type | Source record | Run-control field |
|---|---|---|
| 856 (ASN) | Item Fulfillment | `custbody_orderful_ready_to_process_ful` |
| 855 (PO Ack) | Sales Order | Save with the right status (varies by config) |
| 810 (Invoice) | Invoice | Save with the right status (varies by config) |
| 940 (WSO) | Sales Order / Transfer Order | `custbody_orderful_ready_to_process_*` (check field map) |

A new `customrecord_orderful_transaction` row appears within seconds.

## Where to learn more

- The SuiteApp's outbound JSONata engine code (in the `netsuite-connector` repo) at `TransactionHandling/mapping/outboundJsonata.engine.ts` defines the input/context types and registers the SuiteQL functions. If you have access, this is the source of truth for what variables exist.
- The `mapOutboundJsonataLegacy` function (same repo, `TransactionHandling/common/mapOutboundJsonataLegacy.ts`) is the entry point that wires `$defaultValues` and runs evaluation for the doc types listed in the "Bound `$` variables" table above.
- The `customlist_orderful_jsonata_version` SDF object defines the V1/V2 selector. New work should always use V2.
