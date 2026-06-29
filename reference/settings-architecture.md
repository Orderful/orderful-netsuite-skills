# Settings architecture — Orderful connector (NS-969)

Reference doc for how the Orderful SuiteApp resolves a per-customer / per-vendor / per-ETT setting at runtime. The NS-969 work introduced a **subsidiary-default layer** and a uniform inheritance chain so a setting can be configured ONCE at the subsidiary instead of stamped on every (sub)customer. Skills cite this so Claude uses the correct field IDs and knows where a value actually comes from.

> **Field IDs here are verbatim from the connector source** (`Modules/config/config.service.ts`, `Models/{settings,entity,subsidiary}.ts`, `Migrations/orderful_settingsMigration_MR.ts`, and the `Objects/custrecord_orderful_sub_*.xml` definitions). When in doubt, the connector is the source of truth.

## TL;DR

- A setting lives in one of **two shapes**: Pattern B (legacy boolean + a 3-value `*_override` select) or Pattern D (the nullable customer/vendor/ETT field *is* the override).
- Resolution always walks **customer → parent customer → subsidiary default → hardcoded last-resort**. Only an **unset** value at one level falls through to the next.
- **Vendors** resolve **vendor → subsidiary** — there is **no parent layer** (NS vendors aren't modeled with the customer parent/sub hierarchy).
- The subsidiary-default fields are `custrecord_orderful_sub_*` on the Subsidiary record (Company Information on non-OneWorld). Set one there and every (sub)customer/vendor under it inherits unless it overrides locally.
- **Handling preferences are the outbound gate** (the old `auto_send_asn` / generate-only model was removed in v1.22.0).

## The two resolution patterns

### Pattern B — boolean + explicit 3-value override

Used for settings that were historically a single checkbox. The entity keeps its **legacy boolean** field AND gains a new **`*_override` select** backed by `customlist_orderful_setting_override` (values **Yes / No / Default**). Resolution (`ConfigService.inspectBooleanSetting`):

- override = **Yes** → `true` (use the entity's value, stop)
- override = **No** → `false` (stop)
- override = **Default** → fall through to parent customer's override, then the subsidiary default
- override **empty/undefined** (migration hasn't stamped it yet) → **bilingual fallback** to the legacy boolean

The settings migration M/R stamps legacy `true → Yes` and `false → Default` (never `No`), so no record silently acquires a hard `No` override.

### Pattern D — the nullable field IS the override

Used for selects/scalars. There is **no separate override field**; the existing nullable customer/vendor/ETT field is itself the override. Existence is checked with `!== undefined`, so `0` and `''` count as **set** (they stop the chain — they do NOT inherit). Resolution (`ConfigService.inspectScalarSetting`):

> entity → parent entity → subsidiary default → (still undefined → read-site hardcoded default)

## The resolution chain

```
customer value/override
   ↓ (only if unset / Default)
parent customer value/override
   ↓ (only if unset / Default)
subsidiary default (custrecord_orderful_sub_*)
   ↓ (only if unset)
hardcoded last-resort at the read site
   (e.g. LocationSource.Default, InvoiceHandlingPrefs.OnInvoiceCreation)
```

- **Only an UNSET value inherits.** Pattern B: only `Default` (or empty → legacy boolean) cascades; `Yes`/`No` stop the chain. Pattern D: any value `!== undefined` stops the chain (explicit `0`/`''` are treated as set).
- **Vendors:** vendor → subsidiary, **no parent layer** (`inspectVendorSettings` always passes `parentEntity = null`).
- **ETT:** ETT override (or nullable ETT field) → per-doctype subsidiary default (keyed off `ett.documentType`) → bilingual fallback to the legacy ETT field. Doctypes with no per-doctype subsidiary entry simply have no subsidiary layer for that setting.

## The subsidiary-default layer

Each subsidiary-defaultable setting has a `custrecord_orderful_sub_*` field on the **Subsidiary** record (on non-OneWorld accounts the subsidiary is `id=1` / Company Information). Set it once there and every (sub)customer or vendor in that subsidiary inherits it — invaluable for hundreds-of-subcustomers setups where you don't want to stamp the same value on every child.

The migration M/R seeds these defaults so the effective default is visible/editable: booleans seed to `false`; selects seed to the value the read sites previously hardcoded.

## Field-ID tables

### Pattern B (boolean) settings

| Setting | Legacy boolean (entity) | `*_override` select | Subsidiary default |
|---|---|---|---|
| useSLN (customer) | `custentity_orderful_use_sln` | `custentity_orderful_use_sln_override` | `custrecord_orderful_sub_use_sln` |
| use850Date (customer) | `custentity_orderful_use_850_date` | `custentity_orderful_use_850date_override` | `custrecord_orderful_sub_use_850_date` |
| invAdvicePerLoc (customer) | `custentity_orderful_inv_advice_per_loc` | `custentity_orderful_inv_per_loc_override` | `custrecord_orderful_sub_inv_per_loc` |
| sendAsnWithoutPack (customer) | `custentity_orderful_asn_wo_pack` | `custentity_orderful_asn_wo_pack_override` | `custrecord_orderful_sub_asn_wo_pack` |
| splitByStore (customer) | `custentity_orderful_split_by_store` | `custentity_orderful_split_store_ovrd` | `custrecord_orderful_sub_split_store` |
| splitByShipTo (customer) | `custentity_orderful_split_by_shipto` | `custentity_orderful_split_shipto_ovrd` | `custrecord_orderful_sub_split_shipto` |
| autoAcknowledge (customer) | `custentity_orderful_auto_acknowledge` | `custentity_orderful_auto_ack_override` | `custrecord_orderful_sub_autoack` |
| allowPositiveAdjustments (VENDOR) | `custentity_orderful_allow_positive_adj` | `custentity_orderful_pos_adj_override` | `custrecord_orderful_sub_allow_pos_adj` |
| testMode (ETT) | `custrecord_edi_enab_trans_test` | `custrecord_edi_enab_test_override` | `custrecord_orderful_test_mode` (subsidiary-wide) OR per-doctype `custrecord_orderful_sub_test_850/_855/_856/_810` |
| consolidateDiscountSAC (ETT, 810) | `custrecord_edi_enab_trans_cons_sac` | `custrecord_edi_enab_cons_sac_override` | `custrecord_orderful_sub_cons_sac_810` |
| allowDateChanges (ETT, 860) | `custrecord_orderful_allow_date_change` | `custrecord_edi_enab_date_chg_override` | `custrecord_orderful_sub_date_chg_860` |
| isProcessAsCustom (ETT, all doctypes) | `custrecord_edi_enab_trans_cust_process` | `custrecord_edi_enab_custproc_override` | per-doctype `custrecord_orderful_sub_custproc_*` (see below) |

> **testMode** resolution is bespoke: an ETT override of `Yes`/`No` wins over everything; `Default`/unstamped falls through to the subsidiary-wide `testMode` **OR** the per-doctype subsidiary checkbox. Only 850/855/856/810 have per-doctype test fields.
> **allowDateChanges** is tri-state — it can return `undefined` (no change-request preferences at all → settings validation skipped).

### Pattern D — customer-level (chain: customer → parent → subsidiary default)

| Setting | Customer field (= the override) | Subsidiary default |
|---|---|---|
| locationSource | `custentity_orderful_so_location_source` | `custrecord_orderful_sub_location_src` |
| packagingDataSource | `custentity_orderful_pkg_data_src` | `custrecord_orderful_sub_pkg_data_src` |
| salesOrderFormOverride | `custentity_orderful_so_form_override` | `custrecord_orderful_sub_so_form` |
| subCustomersRepresentation | `customlist_orderful_subcust_rep_opt` (on customer) | `custrecord_orderful_sub_subcust_rep` |
| priceTolerance | `custentity_orderful_price_tolerance` | `custrecord_orderful_sub_price_tolerance` |
| invAdviceDataset (846) | `custentity_orderful_inv_advice_dataset` | `custrecord_orderful_sub_inv_adv_dataset` |
| invAdviceSearch (846) | `custentity_orderful_inv_advice_search` | `custrecord_orderful_sub_inv_adv_srch` |
| departmentReference | `custentity_orderful_department_reference` | `custrecord_orderful_sub_dept_ref` |
| vendorNumber | `custentity_orderful_vendor_number` | `custrecord_orderful_sub_vendor_number` |
| labelDataSource | `custentity_orderful_label_data_src` | `custrecord_orderful_sub_label_data_src` |
| invoiceHandlingPrefs | `custentity_orderful_inv_handling_prefs` | `custrecord_orderful_sub_inv_hp` |
| creditMemoHandlingPrefs | `custentity_orderful_cm_handling_prefs` | `custrecord_orderful_sub_cm_hp` |
| purchaseOrderAcknowledgmentHandlingPrefs | `custentity_orderful_poack_handling_prefs` | `custrecord_orderful_sub_poack_hp` |
| advancedShippingNoticeHandlingPrefs | `custentity_orderful_asn_handling_prefs` | `custrecord_orderful_sub_asn_hp` |
| warehouseShippingOrderHandlingPrefs (dual-entity) | `custentity_orderful_wso_handling_prefs` | `custrecord_orderful_sub_wso_hp` |
| shipDateFieldSource (855) | `custentity_orderful_itemship_source` | `custrecord_orderful_sub_itemship_src` |
| shipDateFieldCustomSource (855) | `custentity_orderful_itemship_cust_source` | `custrecord_orderful_sub_itemship_cust` |
| scheduledDeliveryDateFieldSource (856) | `custentity_orderful_itemship_source` (scheduled-delivery select) | `custrecord_orderful_sub_deldate_src` |
| scheduledDeliveryDateFieldCustomSource (856) | `custentity_orderful_del_date_cust_source` | `custrecord_orderful_sub_deldate_cust` |
| shipMethodLookupType (850) | `custentity_orderful_shipmethod_lookup` | `custrecord_orderful_sub_shipmeth_lookup` |
| staticShipMethod (850) | `custentity_orderful_shipmethod_static` | `custrecord_orderful_sub_shipmeth_static` |
| staticCarrier (850) | `custentity_orderful_shipcarrier_static` | `custrecord_orderful_sub_shipcarr_static` |
| shippingAccountNumber (850) | `custentity_orderful_shipping_acct` | `custrecord_orderful_sub_shipping_acct` |

> **Date-source pairs** (ship-date 855, scheduled-delivery-date 856) are resolved **atomically** by `inspectDateSourcePair`: the source SELECT and its custom-field-name TEXT companion always come from the SAME layer (customer → parent → subsidiary).

### Pattern D — vendor-level (chain: vendor → subsidiary default; NO parent layer)

| Setting | Vendor field (= the override) | Subsidiary default |
|---|---|---|
| inventoryAdjustmentDefaultAccount (947) | `custentity_orderful_default_inv_adj_acco` | `custrecord_orderful_sub_inv_adj_acco` |
| inventoryAdjustmentReasonAccountMap (947) | `custentity_orderful_reason_code_acc_map` | `custrecord_orderful_sub_reason_acc_map` |
| warehouseShippingOrderHandlingPrefs (dual-entity) | `custentity_orderful_wso_handling_prefs` | `custrecord_orderful_sub_wso_hp` |
| warehouseStockTransferTOHandlingPrefs | `custentity_orderful_wst_handling_prefs` | `custrecord_orderful_sub_wst_hp` |
| warehouseStockTransferPOHandlingPrefs | `custentity_orderful_wst_po_handling_prefs` | `custrecord_orderful_sub_wstpo_hp` |

### Pattern D — ETT-level

| Setting | ETT field (= the override) | Subsidiary default |
|---|---|---|
| consolidationMethod (855/856/810) | `ett.consolidationMethod` | `custrecord_orderful_sub_consmeth_855` / `_consmeth_856` / `_consmeth_810` |
| sourceTransactionType (810) | `ett.sourceTransactionType` | **NONE** — ETT-only by product decision |
| itemPricingChanges (860) | `custrecord_orderful_item_pricing_changes` | `custrecord_orderful_sub_price_chg_860` |
| itemQuantityChanges (860) | `custrecord_orderful_item_quantity_change` | `custrecord_orderful_sub_qty_chg_860` |

> The **860 change-request triple** = itemPricingChanges (Pattern D) + itemQuantityChanges (Pattern D) + allowDateChanges (Pattern B). All three are back-stopped by per-860 subsidiary defaults: `_price_chg_860`, `_qty_chg_860`, `_date_chg_860`.

### Per-doctype process-as-custom subsidiary fields

`isProcessAsCustom` has a `custrecord_orderful_sub_custproc_*` field per doctype. An **unchecked** subsidiary box contributes nothing (only checked = default). Full set:

`_850, _855, _856, _810, _846, _860, _864, _865, _875, _880, _940, _943, _944, _945, _947, _844, _845, _867, _spo, _spoa, _ssn, _sinv`

## The override list — `customlist_orderful_setting_override`

`isordered=T`. Backs every Pattern B `*_override` select.

| scriptid (SDF, lowercase) | value | TS enum (`SettingOverride`) | data value (NS uppercases) |
|---|---|---|---|
| `orderful_yes` | Yes | `SettingOverride.Yes` | `ORDERFUL_YES` |
| `orderful_no` | No | `SettingOverride.No` | `ORDERFUL_NO` |
| `orderful_default` | Default | `SettingOverride.Default` | `ORDERFUL_DEFAULT` |

> NetSuite uppercases custom-list scriptids at the data layer, so the TS enum values are uppercase even though the SDF customvalue scriptids are lowercase.

## Outbound gate: handling preferences

Outbound dispatch is gated by the relevant **handling preference** (a Pattern D customer setting, with the customer → parent → subsidiary-default resolution above), NOT by a per-ETT auto-send flag.

- 810 → `invoiceHandlingPrefs` (`custentity_orderful_inv_handling_prefs`) — if it resolves to nothing, **810 outbound never fires**.
- 855 → `purchaseOrderAcknowledgmentHandlingPrefs`
- 856 → `advancedShippingNoticeHandlingPrefs`
- credit memo → `creditMemoHandlingPrefs`; WSO / WST → their respective handling prefs.

> **The legacy generate-only "auto-send" model was removed in v1.22.0.** The old per-ETT `auto_send_asn`-style flag no longer dispatches; the one-gate model is now handling-preference (Pattern D) + isProcessAsCustom (Pattern B). The SDF install script (`assertNoGenerateOnlyOutboundEtts`) actively fails the deploy if it finds a generate-only outbound ETT, forcing a human to set a handling preference / custom process or inactivate the ETT.

## Common "where does this come from?" answers

- **`salesOrderFormOverride`**, **`subCustomersRepresentation`**, and the **inventory-adjustment accounts** (947) are now subsidiary-defaultable — you can set them once on the subsidiary (`custrecord_orderful_sub_so_form`, `custrecord_orderful_sub_subcust_rep`, `custrecord_orderful_sub_inv_adj_acco` / `_reason_acc_map`) instead of per-customer/vendor.
- **`subCustomersRepresentation`** resolves customer → parent → subsidiary default (`custrecord_orderful_sub_subcust_rep`). Its list has only Stores/DCs, so the empty field means "None" (the correct legacy default; the read site applies `?? None`). It is the one subsidiary default that is **not** seeded by the migration.
- A setting that "isn't taking effect" on a customer is usually inheriting: the customer field is unset/`Default`, so the value is coming from the parent customer or the subsidiary default. Check those two layers before assuming the customer field is wrong.
