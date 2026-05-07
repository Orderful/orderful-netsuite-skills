---
name: writing-inbound-jsonata
description: Author and review inbound JSONata advanced mappings for the Orderful NetSuite SuiteApp on 850 Purchase Orders. Covers the BDO override pattern, the userDefinedFields path for custom-field writes (the non-obvious part), the pre-registered helper functions ($lookupContact, $lookupItems, $lookupRecords, etc.), and the raw Mosaic input shape. Use when the user is editing the Advanced Mapping pane for an 850, asks for an inbound JSONata expression, mentions $defaultValues, or wants to populate a custom field on a Sales Order from inbound EDI data.
---

# Writing Inbound JSONata (850 Purchase Orders)

## When to use this skill

Use when the user says any of:

- "I need an inbound JSONata expression for an 850"
- "How do I map [partner field X] to a custom field on the Sales Order?"
- "What goes in the Advanced Mapping pane for 850?"
- "Override the [department / location / item / etc.] coming out of the default 850 mapping"
- "Pull [phone / contact / reference number / address] from the 850 into NetSuite"
- "Set custbody_xxx from the inbound transaction"
- Anything about `$defaultValues`, `lookupContact`, `lookupItems`, `userDefinedFields`, BDO transformation
- The user shares a screenshot of the SuiteApp Advanced Mapping UI (three-pane editor with raw transaction on left, JSONata in middle, transaction JSON on right)

**Scope:** This skill covers **inbound 850 only**. The same engine handles 875, 944, 945, 947, and 860 — patterns transfer, but field shapes and helper applicability differ. For outbound (855/856/810/etc.), use `writing-outbound-jsonata` instead.

**Don't use this skill for:**
- Outbound mappings (different engine, different input shape)
- Workflow-level customization that needs SuiteScript (User Event scripts, Map/Reduce hooks)
- Creating standalone NetSuite custom records as a side effect of inbound — advanced mapping outputs **one** Sales Order BDO; spawning ancillary records requires a developer extensibility hook (see the docs site's "Developer Extensibility Guide")

## Mental model

The inbound advanced mapping is a JSONata expression evaluated against the raw Orderful Mosaic JSON. Its output replaces the default Business Data Object (BDO) the connector would have produced — which is then turned into a Sales Order.

Three things you have access to inside the expression:

1. **The raw transaction** — root context. Has `sender`, `receiver`, `customer`, `metaData`, and `message.transactionSets[0].*` with X12-named segments (`purchaseOrderIdentification`, `contact`, `N1_loop`, `G68_loop`, etc.). This is the Mosaic format, not the BDO.
2. **`$defaultValues`** — the BDO the connector would have built without your override. You almost always want to start with this and overlay changes.
3. **Pre-registered helper functions** (see "Helpers" below) — `$lookupContact`, `$lookupItems`, `$lookupRecords`, etc.

The output must be a BDO-shaped object. The shape lives in `TypesAndUtil/businessDataObject.ts` in the netsuite-connector repo.

## The override pattern

Always use the JSONata transform operator `~> | <key> | { ...overrides } |` to overlay onto `$defaultValues`. Don't rebuild the BDO from scratch — it's a deep object with dozens of fields and you'll regress whatever the connector already mapped correctly.

```jsonata
$defaultValues ~> | transaction | {
  "department": 2,
  "location": 17
} |
```

That keeps every other field of `$defaultValues.transaction` intact and overrides only `department` and `location`.

For overrides that need intermediate computation, wrap in a parens block with `:=` bindings:

```jsonata
(
  $shipTo := message.transactionSets[0].N1_loop[partyIdentification[entityIdentifierCode = "ST"]];
  $defaultValues ~> | transaction | {
    "shipToId": $shipTo.partyIdentification[0].identificationCode
  } |
)
```

## Custom field writes — the userDefinedFields gotcha

**This is the non-obvious part. Read carefully.**

To write a `custbody_*` (or `custentity_*`, `custcol_*`) field, you do **not** put the key directly under `transaction`. There's a dedicated bag for them:

```jsonata
$defaultValues ~> | transaction | {
  "userDefinedFields": {
    "custbody_orderful_admin_phone": "555-1234"
  }
} |
```

The connector spreads `transaction.userDefinedFields` onto the Sales Order create call (`TransactionHandling/850/createSalesOrder.ts:413` — `...userDefinedFields`). The type is a flat key/value map: `{ [key: string]: string | number | boolean | null | undefined }` (`TypesAndUtil/businessDataObject.ts:77-79`).

### Critical merge behavior

The transform operator `~> | transaction | { "userDefinedFields": {...} } |` **replaces the entire `userDefinedFields` object**, not merges into it. If you write multiple custom fields across multiple expressions, only the last one wins. Always collect every `custbody_*`/`custentity_*` write into one object literal:

```jsonata
(
  $admin := message.transactionSets[0].contact ~> $lookupContact("AM");
  $order := message.transactionSets[0].contact ~> $lookupContact("OC");
  $defaultValues ~> | transaction | {
    "userDefinedFields": {
      "custbody_orderful_admin_phone": $admin.phone,
      "custbody_orderful_admin_email": $admin.email,
      "custbody_orderful_order_phone": $order.phone,
      "custbody_orderful_partner_ref": message.transactionSets[0].extendedReferenceInformation[referenceIdentificationQualifier = "PO"][0].referenceIdentification
    }
  } |
)
```

### Why this exists at all

`$defaultValues.transaction` is statically typed in the connector — it has fixed fields like `department`, `location`, `shippingAddress`. Arbitrary `custbody_*` keys can't go there because the type would reject them and the connector wouldn't know to forward them. `userDefinedFields` is the deliberate escape hatch: a typed `Record<string, primitive>` that gets spread verbatim onto the NetSuite record write.

### What `null` / `undefined` does

The map type allows `null` and `undefined`. If the source field is absent (e.g., `$admin.phone` when there's no AM contact), the value is `null` — which the SuiteApp then writes as a null on the Sales Order, **clearing** any prior value. If you only want to write when present, guard:

```jsonata
"custbody_orderful_admin_phone": $admin.phone ? $admin.phone : $defaultValues.transaction.userDefinedFields.custbody_orderful_admin_phone
```

## Setting custom date fields — the `_textFields` workaround

**Read this before writing to any `custbody_*_date` (or `custentity_*_date`) field. There's a SuiteApp bug that makes the obvious approach fail.**

If you do this:

```jsonata
"userDefinedFields": {
  "custbody_my_cancel_date": "20260130"   // YYYYMMDD from EDI
}
```

…or this (formatted):

```jsonata
"userDefinedFields": {
  "custbody_my_cancel_date": "1/30/2026"  // M/D/YYYY
}
```

…the SO save fails with `INVALID_FLD_VALUE: Invalid date value (must be M/D/YYYY)`. Why: `userDefinedFields` is spread into the create payload and applied via `record.setValue(fieldId, value)`. NetSuite's `setValue` on a date field requires a `Date` *object*, not a string. JSONata can't produce a JS `Date` (JSON has no Date type), so any string you emit fails when `record.save()` runs.

The Custom Header Field Mapping (`customrecord_orderful_edi_field_map_head`) is meant to handle this — its code path detects date fields and runs `parseDate(yyyymmdd)`. But the detection is buggy: `createSalesOrder.ts:871` checks `field_value_type === 'DATE'` while NetSuite's `customfield.fieldvaluetype` actually returns `"Date"` (mixed case). The branch is dead code as written, so header field mapper writes also fail on dates.

### The fix

`createNSTransaction.ts:33-38` reads a special key `header._textFields` — an array of field IDs. Anything listed there gets `setText` instead of `setValue`. `setText` accepts the company's text date format directly (M/D/YYYY for US accounts).

So: emit your dates as M/D/YYYY strings AND list them under `_textFields` inside `userDefinedFields`:

```jsonata
(
  $nsDate := function($yyyymmdd) {
    $yyyymmdd
      ? $string($number($substring($yyyymmdd, 4, 2))) & "/"
        & $string($number($substring($yyyymmdd, 6, 2))) & "/"
        & $substring($yyyymmdd, 0, 4)
      : null
  };
  $defaultValues ~> | transaction | {
    "userDefinedFields": {
      "_textFields": [
        "custbody_my_cancel_date",
        "custbody_my_required_date"
      ],
      "custbody_my_cancel_date": $nsDate(message.transactionSets[0].dateTimeReference[dateTimeQualifier = "001"].date),
      "custbody_my_required_date": $nsDate($defaultValues.transaction.date)
    }
  } |
)
```

The `$nsDate` helper strips leading zeros (`"01/30/2026"` → `"1/30/2026"`) — this matters because the error message specifically says `M/D/YYYY`, not `MM/DD/YYYY`, even though both usually parse.

### Caveats

- **`_textFields` from `userDefinedFields` overrides whatever `createSalesOrderHeader` was going to set.** The SuiteApp uses `_textFields: ['discountrate']` for the rare case of a discount whose rate is a percentage string (`"-5.00%"`). If your inbound transaction has a single text-mode discount AND you're using `_textFields` for dates, your override clobbers the discount-rate text mode. Worth a quick sanity check on customers that use percentage discounts.
- **The bug at `createSalesOrder.ts:871` and `:979` should be filed** — the same `field_value_type === 'DATE'` typo appears in both the header and line mappers. Until the SuiteApp ships a fix, `_textFields` is the only way to get a string-typed date into a custom date field via inbound EDI processing.
- **For the typed BDO dates** (`transaction.mustShipBy`, `earliestDelivery`, `latestDelivery`, `startDate`, `endDate`, `requestedShipDate`, `date`), you don't need `_textFields`. `createSalesOrderHeader` runs `parseDate(value, yyyyMMdd)` explicitly on each of those before they hit NetSuite, so YYYYMMDD strings work directly. Use `_textFields` only for arbitrary `custbody_*` / `custentity_*` date fields.

## Pre-registered helper functions

Defined in `TransactionHandling/mapping/inboundJsonata.engine.ts:204-238`. All are available with no import.

| Function | Returns | Use for |
|---|---|---|
| `$lookupContact(contacts, code)` | `{ email, phone, extension, fax }` or `null` | Finding the first PER-segment contact with a given `contactFunctionCode` and pulling its standard communication channels |
| `$lookupQualifiedValues(obj, qualifier)` | `string[]` | Generic version — extract all values from an object whose paired qualifier matches (e.g., pull all `EM` emails from a contact) |
| `$lookupLoopInstances(loopInstances, variantKeyCodes, lookupKeyCodes)` | array of loop entries | **3-arg, not 2.** Matches `lookupKeyCodes` against an *already-extracted* `variantKeyCodes` array running parallel to `loopInstances`. Awkward for casual filtering — for N1 loops, prefer a direct JSONata predicate (see "Filtering N1 loops" below). |
| `$lookupItems(ediId, qualifier)` | `{ id, ... }` matches | Resolve EDI item identifiers to NetSuite item internal IDs using the customer's item config |
| `$lookupItemMappings(partnerSku)` | match record | Resolve a partner part number to a NetSuite item via Custom Item Lookup records |
| `$lookupRecords(lookupName, value)` | record(s) | Generic NetSuite lookup using one of the customer's configured "Lookups" |
| `$lookupSingleSuiteQL(query)` | one row | Run an ad-hoc SuiteQL and return one row |
| `$lookupMultiSuiteQL(query)` | rows | Run an ad-hoc SuiteQL and return an array of rows |

### `$lookupContact` worked example

The PER segment shape in Mosaic is awkward — one contact entry has `communicationNumber` / `communicationNumberQualifier` / `communicationNumber1` / `communicationNumberQualifier1` / etc. as parallel fields. `$lookupContact` finds the first array entry by `contactFunctionCode` and unpacks the qualified communication numbers into a flat object.

```jsonata
message.transactionSets[0].contact ~> $lookupContact("BD")
// → { "email": "buyer@partner.com", "phone": "5551234567", "extension": null, "fax": null }
```

Common contact function codes (PER01):
- `BD` — Buyer Department
- `OC` — Order Contact
- `IC` — Information Contact
- `RE` — Receiving Contact
- `SC` — Schedule Contact
- `EA` — EDI Coordinator
- `CN` — General Contact
- `ZZ` — Mutually Defined

The native 875 template (`TransactionHandling/mapping/templates/875.jsonata:81-88`) maps eight of these into the BDO's `contacts` object — which means anything **not** in that list (e.g., custom function codes, less-common ones like `AM`) is fair game for a `userDefinedFields` write. Anything **in** the list is already on `$defaultValues.transaction.contacts.*` and you can read it from there instead of re-lookup-ing.

## Input data shape (raw Mosaic 850)

The expression's root context is the full Orderful transaction. Top-level keys:

- `id`, `href`, `version` — transaction metadata
- `sender`, `receiver` — `{ isaId, isaIdQualifier, testIsaId, testIsaIdQualifier, name }`
- `customer` — `{ id, companyName, altName, prodIsaId, testIsaId, multiShipToEnabled, locationSource, enabledTransactionTypes[], ... }`
- `metaData` — `{ orderfulId, type, production, referenceNumber, validationStatus, deliveryStatus, acknowledgementStatus, createdAt, lastUpdatedAt, tradingPartnerId, tradingPartnerName, customerConfig, autoAcknowledgeIfInventoryOnHand }`
- `message.transactionSets[0]` — the actual EDI content. Common sub-field names you'll see for 850:
  - `purchaseOrderIdentification[]` or `beginningSegmentForPurchaseOrder[]` — header (PO number, date, type code)
  - `extendedReferenceInformation[]` or `referenceInformation[]` — REF segments
  - `contact[]` or `administrativeCommunicationsContact[]` — PER segments (use `$lookupContact`)
  - `dateTime[]` or `dateTimeReference[]` — DTM segments
  - `noteSpecialInstruction[]` — NTE segments
  - `transportationInstructions[]` or `carrierDetailsRoutingSequenceTransitTime[]` — TD5 (routing, carrier)
  - `N1_loop[]` — N1/N3/N4 parties (BT, ST, SH, etc.)
  - `G72_loop[]` or `SAC_loop[]` — header-level allowances/charges
  - `G68_loop[]` or `PO1_loop[]` — line items
  - `totalPurchaseOrder[]` or `CTT_loop[]` — control totals

> ⚠️ **Field names vary across Mosaic versions and partner-specific schemas.** Some traders' messages use `dateTimeReference` while others use `dateTime`; some use `referenceInformation` while others use `extendedReferenceInformation`. Don't trust this list — always inspect the actual right-hand JSON pane in the Advanced Mapping UI (or the `custrecord_ord_tran_message` content on the Orderful Transaction record) to confirm the exact key names for *this* customer's transactions before writing your expression.

A representative test fixture lives at `__tests__/jsonata/inboundJsonata.engine.spec.ts:124-298` — useful as a fallback reference, but the actual transaction's JSON is the source of truth for any given mapping.

## Filtering N1 loops

Because `$lookupLoopInstances` is awkward (3-arg, requires a parallel keys array), reach for direct JSONata predicates first:

```jsonata
// All ST parties:
$st := message.transactionSets[0].N1_loop[partyIdentification[0].entityIdentifierCode = "ST"];

// First MA party (or null):
$ma := message.transactionSets[0].N1_loop[partyIdentification[0].entityIdentifierCode = "MA"][0];

// Wrap as a helper:
$partyByCode := function($code) {
  message.transactionSets[0].N1_loop[partyIdentification[0].entityIdentifierCode = $code]
};

// ST → MA fallback (drop-ship-to-consumer 850s often have only MA):
$shipParty := (
  $st := $partyByCode("ST");
  $count($st) > 0 ? $st[0] : $partyByCode("MA")[0]
);
```

The predicate `[partyIdentification[0].entityIdentifierCode = $code]` reads as: "keep N1_loop entries whose first partyIdentification has the given code." JSONata's `=` (single equals) is the equality operator; `==` always evaluates false here.

## Where to put what — check the SuiteApp's customer-record knobs FIRST

There are four places to influence the resulting Sales Order, and they're scoped differently. Before you write any JSONata, check whether the SuiteApp already ships a customer-record field for what you're trying to do — many of the most common defaults already have a purpose-built knob and don't need a mapper at all.

| Mechanism | Storage | Scope | Use for |
|---|---|---|---|
| **Customer-record SuiteApp settings** (`custentity_orderful_*`) | Fields on the customer record itself | **Per customer** (across all doc types) | Anything the SuiteApp already exposes — see "Common customer-record knobs" below. Always check here first. |
| **JSONata Advanced Mapping** | `custrecord_edi_enab_jsonata` on the EDI Enabled Transaction record | **Per customer × per doc type** | Customer-specific defaults the SuiteApp doesn't have a knob for, complex transformations, anything keyed off raw EDI segments |
| **Custom Header Field Mapping** (`customrecord_orderful_edi_field_map_head`) | Standalone records | **Per doc type × per subsidiary** (no customer field on the schema) | Universal mappings that apply to *every* customer in a subsidiary for a given doc type |
| **Typed BDO override** (`transaction.X` directly) | inside the JSONata transform | Same as JSONata | Standard SO fields the SuiteApp explicitly handles (`department`, `location`, `shippingAddress`, `requestedShipDate`, `mustShipBy`, etc.) — see `TypesAndUtil/businessDataObject.ts` |

### Common customer-record knobs (`custentity_orderful_*`)

A non-exhaustive list, but covers the cases that come up most often. Always run a `SELECT scriptid, name FROM CustomField WHERE LOWER(scriptid) LIKE 'custentity_orderful%'` against the customer's account to see the full current set — the SuiteApp adds fields over time.

| Field | What it does |
|---|---|
| `custentity_orderful_so_form_override` | Sets the Sales Order custom form for inbound 850s from this customer. **If the SO needs to land on a specific MHI/legacy form, this is the answer — not JSONata.** |
| `custentity_orderful_isa_id` / `_isa_id_test` | Production / test ISA IDs the customer is identified by |
| `custentity_orderful_inter_sender_id` | Interchange sender override |
| `custentity_orderful_split_by_shipto` / `_split_by_store` | Split inbound POs into multiple SOs by ship-to or store |
| `custentity_orderful_multiple_location` | Allow a single SO to span multiple NS locations |
| `custentity_orderful_shipmethod_static` / `_shipcarrier_static` | Static shipping method / carrier defaults |
| `custentity_orderful_shipping_acct` | Shipping account number |
| `custentity_orderful_shipto_n1_id` / `_shipto_use_entityid` | Sub-customer ship-to lookup behaviour |
| `custentity_orderful_subcust_rep` | What sub-customers represent (locations, ship-tos, etc.) |
| `custentity_orderful_use_850_date` | Use the EDI 850's date field as the SO trandate |
| `custentity_orderful_use_edi_pricing` | Trust the EDI's prices vs. NetSuite item prices |
| `custentity_orderful_auto_acknowledge` | Initialize SOs in "Pending Fulfillment" status |
| `custentity_orderful_poack_handling_prefs` | 855 handling preferences |
| `custentity_orderful_asn_handling_prefs` / `_asn_wo_pack` | 856 handling preferences |
| `custentity_orderful_inv_handling_prefs` | 810 handling preferences |
| `custentity_orderful_cm_handling_prefs` | Credit memo handling preferences |
| `custentity_orderful_wso_handling_prefs` / `_wstpo_hp` / `_wst_handling_prefs` | 940 / 943 / 944 warehouse handling preferences |
| `custentity_orderful_del_date_source` / `_del_date_cust_source` | Where to source the scheduled delivery date from |
| `custentity_orderful_itemship_source` / `_itemship_cust_source` | Where to source per-item ship dates from |
| `custentity_orderful_location_sources` | Location resolution strategy |

### Common mistakes

- **Using header field mapping for a single-customer default** (e.g. "Acme Foods always uses Order Channel = 3"). The mapping has no customer scope, so it'll fire for every other customer in the same subsidiary using the same doc type. Customer-specific statics belong in JSONata or — even better — a SuiteApp customer-record knob if one exists.
- **Writing JSONata for a default the SuiteApp already exposes.** If you find yourself overriding `customform`, splitting by ship-to, or hardcoding a static carrier in JSONata, stop and check the `custentity_orderful_*` field list — there's almost certainly a knob for it. The SuiteApp's logic stays consistent across versions; bespoke JSONata can drift.

## Workflow when authoring a new mapping

1. **Confirm what the user actually wants.** Custom field on Sales Order header? → `userDefinedFields`. Override a native BDO field (department, location, shipToId)? → direct property in the transform. Spawn a separate custom record? → not advanced mapping; redirect.
2. **Find the source field in the raw input.** Walk through `message.transactionSets[0].*` — preferably by inspecting the actual transaction in the right-hand pane of the Advanced Mapping UI rather than guessing from EDI segment names.
3. **Pick the right helper if one applies.** PER → `$lookupContact`. N1 loop → `$lookupLoopInstances`. Item → `$lookupItems` / `$lookupItemMappings`. Otherwise plain JSONata path expressions.
4. **Wrap in the transform pattern.** Always `$defaultValues ~> | transaction | { ... } |`, never an unbound object literal.
5. **For custom fields, always use `userDefinedFields` and bundle every `custbody_*` write into one object** (see merge behavior above).
6. **Use `:=` bindings in a parens block** when you need intermediate values or want to share computation across multiple output keys.
7. **Test in the Advanced Mapping UI's preview pane** before saving. Save Advanced Mapping persists to the customer's enabled transaction config — there's no "draft" state.

## Common antipatterns

- ❌ Writing `"custbody_xxx": value` directly under `transaction`. The field type will reject it and the connector won't forward it. **Always use `userDefinedFields`.**
- ❌ Splitting custom field writes across multiple `~> | transaction |` transforms. The second transform replaces the first's `userDefinedFields` entirely.
- ❌ Writing a date string to a `custbody_*_date` field via `userDefinedFields` without listing it in `_textFields`. `setValue` rejects the string at save time. See "Setting custom date fields" above.
- ❌ Returning a fresh BDO without overlaying `$defaultValues`. You'll lose every default mapping (addresses, line items, contacts).
- ❌ Reading from `$defaultValues.transaction.contacts.*` for codes that aren't in the native list (BD, OC, IC, RE, SC, EA, CN, ZZ) — they won't be there. Use `$lookupContact` against the raw `contact[]` array instead.
- ❌ Hardcoding line indices (`contact[0]`) when the order isn't guaranteed. Use predicates: `contact[contactFunctionCode = "OC"][0]` or `$lookupContact`.
- ❌ Using `==` for equality in JSONata predicates. JSONata uses `=`. The expression `[code == "X"]` always returns `false`.
- ❌ Calling `$lookupLoopInstances(loop, "ST")` (2-arg). The actual signature is 3-arg with a parallel `variantKeyCodes` array. For typical N1-loop filtering, write a direct predicate instead.

## Reference files (in netsuite-connector repo)

| Path | What it tells you |
|---|---|
| `TransactionHandling/mapping/inboundJsonata.engine.ts` | Engine entry point; helper registration list (lines 204-238) |
| `TransactionHandling/mapping/functions/lookupContact.ts` | Source for `$lookupContact` — exact return shape, qualifier mapping |
| `TransactionHandling/mapping/functions/` | All other helpers — `lookupItems.ts`, `lookupRecords.ts`, etc. |
| `TransactionHandling/mapping/templates/875.jsonata` | Native template; canonical reference for how all 8 standard contacts map into the BDO |
| `TransactionHandling/850/createSalesOrder.ts` (line 302, 413) | Where `userDefinedFields` is unpacked and spread onto the SO create |
| `TransactionHandling/850/createSalesOrder.ts` (lines 866-877, 974-985) | Header & line custom-field mappers; the date-detection branches with the `field_value_type === 'DATE'` bug |
| `TransactionHandling/common/createNSTransaction.ts` (lines 21, 33-45) | Where `header._textFields` is read and routes those fields through `setText` instead of `setValue` |
| `TypesAndUtil/businessDataObject.ts` (lines 60-79) | BDO type definitions; `userDefinedFields` interface |
| `__tests__/jsonata/inboundJsonata.engine.spec.ts` | Worked example of input → output, useful as test fixture and field-name reference |

Paths are relative to the SuiteApp root: `FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/` inside the `netsuite-connector` repo.

## Worked end-to-end example

User request: "Pull the administrative contact's phone and email off this 850 into custom fields on the Sales Order, and override the location to ID 17 if the ship-to is the LA warehouse."

```jsonata
(
  $admin := message.transactionSets[0].contact ~> $lookupContact("AM");
  $shipToCity := message.transactionSets[0].N1_loop[partyIdentification[entityIdentifierCode = "ST"]].geographicLocation[0].cityName;
  $isLA := $shipToCity = "Los Angeles";
  $defaultValues ~> | transaction | {
    "location": $isLA ? 17 : $defaultValues.transaction.location,
    "userDefinedFields": {
      "custbody_orderful_admin_phone": $admin.phone,
      "custbody_orderful_admin_email": $admin.email
    }
  } |
)
```

Notes on this example:
- `:=` bindings hoist intermediate values for readability and to avoid repeated traversal
- The `location` override falls back to the default when not LA — never returning `undefined` for a typed BDO field
- Both custom fields are inside one `userDefinedFields` object literal, so neither clobbers the other
- `$lookupContact("AM")` returns `null` if no admin contact is present; accessing `.phone` on null in JSONata yields `undefined`, which serializes as a missing key in the output (NetSuite leaves the field unchanged)
