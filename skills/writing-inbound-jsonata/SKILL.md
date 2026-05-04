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

## Pre-registered helper functions

Defined in `TransactionHandling/mapping/inboundJsonata.engine.ts:204-238`. All are available with no import.

| Function | Returns | Use for |
|---|---|---|
| `$lookupContact(contacts, code)` | `{ email, phone, extension, fax }` or `null` | Finding the first PER-segment contact with a given `contactFunctionCode` and pulling its standard communication channels |
| `$lookupQualifiedValues(obj, qualifier)` | `string[]` | Generic version — extract all values from an object whose paired qualifier matches (e.g., pull all `EM` emails from a contact) |
| `$lookupLoopInstances(loop, code)` | array of loop entries | Filter an `N1_loop` (or similar) by `entityIdentifierCode` (`"BT"`, `"ST"`, `"SH"`, etc.) |
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
- `message.transactionSets[0]` — the actual EDI content. Key sub-fields for 850:
  - `purchaseOrderIdentification[]` — header (PO number, date, type code, status code)
  - `extendedReferenceInformation[]` — REF segments
  - `contact[]` — PER segments (use `$lookupContact`)
  - `dateTime[]` — DTM segments
  - `noteSpecialInstruction[]` — NTE segments
  - `transportationInstructions[]` — TD5 (routing, carrier)
  - `N1_loop[]` — N1/N3/N4 parties (BT, ST, SH, etc. — use `$lookupLoopInstances`)
  - `G72_loop[]` — header-level allowances/charges
  - `G68_loop[]` — line items (PO1)
  - `totalPurchaseOrder[]` — CTT control totals

A representative test fixture lives at `__tests__/jsonata/inboundJsonata.engine.spec.ts:124-298` — read that whenever you need to confirm a field name; the spec is the source of truth for what the engine sees.

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
- ❌ Returning a fresh BDO without overlaying `$defaultValues`. You'll lose every default mapping (addresses, line items, contacts).
- ❌ Reading from `$defaultValues.transaction.contacts.*` for codes that aren't in the native list (BD, OC, IC, RE, SC, EA, CN, ZZ) — they won't be there. Use `$lookupContact` against the raw `contact[]` array instead.
- ❌ Hardcoding line indices (`contact[0]`) when the order isn't guaranteed. Use predicates: `contact[contactFunctionCode = "OC"][0]` or `$lookupContact`.
- ❌ Using `==` for equality in JSONata predicates. JSONata uses `=`. The expression `[code == "X"]` always returns `false`.

## Reference files (in netsuite-connector repo)

| Path | What it tells you |
|---|---|
| `TransactionHandling/mapping/inboundJsonata.engine.ts` | Engine entry point; helper registration list (lines 204-238) |
| `TransactionHandling/mapping/functions/lookupContact.ts` | Source for `$lookupContact` — exact return shape, qualifier mapping |
| `TransactionHandling/mapping/functions/` | All other helpers — `lookupItems.ts`, `lookupRecords.ts`, etc. |
| `TransactionHandling/mapping/templates/875.jsonata` | Native template; canonical reference for how all 8 standard contacts map into the BDO |
| `TransactionHandling/850/createSalesOrder.ts` (line 302, 413) | Where `userDefinedFields` is unpacked and spread onto the SO create |
| `TypesAndUtil/businessDataObject.ts` (lines 60-79) | BDO type definitions; `userDefinedFields` interface |
| `__tests__/jsonata/inboundJsonata.engine.spec.ts` | Worked example of input → output, useful as test fixture and field-name reference |

Local clone path: `~/Documents/Documents-Isaiah-Work-Macbook-Pro/GitHub/netsuite-connector/FileCabinet/SuiteApps/com.orderful.orderfulnetsuite/`

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
