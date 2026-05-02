// Copyright (c) 2026 Orderful, Inc.
//
// Helper transformation: insert one entry as the first field of a JSONata
// record's `userDefinedFields` block. Optionally fixes a lowercase
// `userdefinedfields` typo (which the SuiteApp ignores) before inserting.
//
// Usage:
//   import { insertIntoUserDefinedFields } from './insertIntoUserDefinedFields.mjs';
//
//   const transform = insertIntoUserDefinedFields({
//     key: 'externalid',
//     expression:
//       '$defaultValues.transaction.purchaseOrderNumber & "-" & ' +
//       'message.transactionSets[0].beginningSegmentForPurchaseOrder[0].transactionSetPurposeCode',
//     comment: 'External ID = PO# + "-" + BEG01 — uniqueness guard',
//     fixCasingTypo: true,
//   });
//
// Then pass `transform` to deploy.mjs via a small wrapper file:
//   // wrapper.mjs
//   export { default } from '.../insertIntoUserDefinedFields.mjs?...'  // (or re-export the configured fn)

/**
 * Build a transform that inserts a key into `userDefinedFields`.
 *
 * @param {object} opts
 * @param {string} opts.key            JSONata key to insert (e.g., "externalid").
 * @param {string} opts.expression     JSONata expression producing the value (string content; quoted by caller if needed).
 * @param {string} [opts.comment]      Optional comment to drop above the inserted line.
 * @param {boolean} [opts.fixCasingTypo=true]  If true, also rename `userdefinedfields` (lowercase) → `userDefinedFields` before inserting.
 * @returns {(original: string, recordId: string) => { newJsonata: string, notes: string[] }}
 */
export function insertIntoUserDefinedFields({ key, expression, comment, fixCasingTypo = true }) {
  if (!key || typeof key !== 'string') throw new Error('insertIntoUserDefinedFields: `key` is required');
  if (!expression || typeof expression !== 'string') throw new Error('insertIntoUserDefinedFields: `expression` is required');

  return function transform(original, recordId) {
    const notes = [];
    let s = original;

    const lowercaseRegex = /"userdefinedfields"\s*:\s*\{/;
    const camelRegex = /"userDefinedFields"\s*:\s*\{/;

    if (lowercaseRegex.test(s) && !camelRegex.test(s)) {
      if (fixCasingTypo) {
        s = s.replace(lowercaseRegex, '"userDefinedFields": {');
        notes.push('Fixed casing: userdefinedfields -> userDefinedFields');
      } else {
        throw new Error(
          `Record ${recordId}: lowercase userdefinedfields (broken) and fixCasingTypo is false`,
        );
      }
    }

    if (!camelRegex.test(s)) {
      throw new Error(`Record ${recordId}: no userDefinedFields block found, cannot insert ${key}`);
    }

    // Idempotency check: refuse if the key is already present in any userDefinedFields block.
    // This keeps re-runs safe.
    const existingKeyRegex = new RegExp(`"${escapeRegex(key)}"\\s*:`);
    if (existingKeyRegex.test(s)) {
      throw new Error(`Record ${recordId}: key "${key}" already present — refusing to double-insert`);
    }

    const insertion = (comment ? `    /* ${comment} */\n` : '') + `    "${key}": ${expression},`;

    s = s.replace(camelRegex, (match) => `${match}\n${insertion}\n    `);

    if (!s.includes(`"${key}"`)) {
      throw new Error(`Record ${recordId}: replacement did not insert "${key}"`);
    }

    notes.push(`Inserted "${key}" at top of userDefinedFields`);
    return { newJsonata: s, notes };
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
