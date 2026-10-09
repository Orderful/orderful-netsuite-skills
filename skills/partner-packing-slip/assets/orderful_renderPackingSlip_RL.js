// Copyright (c) 2026 Orderful, Inc.

/* global define */

/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * Render a packing slip PDF for an Item Fulfillment using a given Advanced
 * PDF/HTML template, returned base64-encoded. Read-only: renders and returns,
 * writes nothing.
 *
 * POST { "fulfillmentId": 123, "templateId": 456 }
 *   -> { "status": "success", "bytes": 12345, "pdfBase64": "..." }
 *
 * Deploy this per customer via SDF while the SuiteApp's agent RESTlet has no
 * native render action. It exists so a packing slip template can be iterated
 * against real data without a UI round-trip.
 */
define(['N/render', 'N/record'], function (render, record) {
  function post(context) {
    try {
      var fulfillmentId = context.fulfillmentId;
      var templateId = context.templateId;

      if (!fulfillmentId || !templateId) {
        return { status: 'error', message: 'fulfillmentId and templateId are required' };
      }

      var fulfillment = record.load({
        type: record.Type.ITEM_FULFILLMENT,
        id: Number(fulfillmentId),
      });

      var renderer = render.create();
      renderer.setTemplateById({ id: Number(templateId) });
      renderer.addRecord({ templateName: 'record', record: fulfillment });

      // A packing slip template sources most of its data from the originating
      // Sales Order (`salesorder.*`). NetSuite's own print flow binds that for
      // us; render.create() does not, and without it every salesorder.* field
      // renders blank with no error.
      var createdFrom = fulfillment.getValue({ fieldId: 'createdfrom' });
      if (createdFrom) {
        renderer.addRecord({
          templateName: 'salesorder',
          record: record.load({ type: record.Type.SALES_ORDER, id: Number(createdFrom) }),
        });
      }

      var contents = renderer.renderAsPdf().getContents();
      return { status: 'success', bytes: contents.length, pdfBase64: contents };
    } catch (e) {
      return {
        status: 'error',
        name: e.name,
        message: e.message,
        stack: String(e.stack || '').split('\n').slice(0, 6),
      };
    }
  }

  return { post: post };
});
