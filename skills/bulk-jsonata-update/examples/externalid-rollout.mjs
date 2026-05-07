// Copyright (c) 2026 Orderful, Inc.
//
// Example transformation: add an `externalid` mapping to every inbound 850
// JSONata, where externalid = purchaseOrderNumber + "-" + BEG01.
//
// To use this with deploy.mjs:
//   1. Run the audit first:
//        node ../scripts/audit.mjs ~/orderful-onboarding/<slug> 850_PURCHASE_ORDER
//   2. Dry-run with this transform:
//        node ../scripts/deploy.mjs ~/orderful-onboarding/<slug> 850_PURCHASE_ORDER ./externalid-rollout.mjs --dry-run
//   3. Diff a few transformed files in jsonata-backups/.../transformed/.
//   4. After approval:
//        node ../scripts/deploy.mjs ~/orderful-onboarding/<slug> 850_PURCHASE_ORDER ./externalid-rollout.mjs --execute
//
// This is a working example. Copy and adapt for your own rollouts.

import { insertIntoUserDefinedFields } from '../transformations/insertIntoUserDefinedFields.mjs';

const transform = insertIntoUserDefinedFields({
  key: 'externalid',
  expression:
    '$defaultValues.transaction.purchaseOrderNumber & "-" & ' +
    'message.transactionSets[0].beginningSegmentForPurchaseOrder[0].transactionSetPurposeCode',
  comment: 'External ID = PO# + "-" + BEG01 (Transaction Set Purpose Code) — uniqueness guard',
  fixCasingTypo: true,
});

export default transform;
