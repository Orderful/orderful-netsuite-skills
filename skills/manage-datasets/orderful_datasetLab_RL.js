/**
 * orderful_datasetLab_RL.js
 *
 * Read/author/test SuiteAnalytics Datasets over REST.
 *
 * NetSuite exposes no REST endpoint for datasets (same gap as saved searches), but
 * N/dataset is available to server scripts and supports the full surface:
 * create / createColumn / createCondition / createJoin / load / list / run / save.
 * This RESTlet wraps that surface so a dataset spec can be iterated from a laptop
 * instead of hand-built in the Analytics UI.
 *
 * Actions (POST body, or GET ?action=list):
 *   list            -> every dataset in the account (id, name, base record)
 *   describe        -> { id }            load a dataset, emit a round-trippable JSON spec
 *   run             -> { id, limit }     execute a saved dataset, return rows
 *   dryRun          -> { spec, limit }   build a dataset from a spec, run it, NEVER save
 *   save            -> { spec }          build from spec and persist
 *   validate        -> { id | spec }     check against the SuiteApp's 856 packaging contract
 *
 * describe -> edit -> dryRun -> save is the intended loop. dryRun mutates nothing.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/dataset', 'N/query', 'N/log', 'N/runtime'], (
  dataset,
  query,
  log,
  runtime,
) => {
  /**
   * Mirrors `columnConfigs` in Models/carton.ts of the Orderful SuiteApp. The SuiteApp
   * matches packaging dataset columns by *label*, case-insensitively — not by field id —
   * so these labels are the actual contract for a Packaging Data Source.
   * Keep in sync with the SuiteApp if that list changes.
   */
  const PACKAGING_COLUMN_CONTRACT = [
    { label: 'Fulfillment', mandatory: true },
    { label: 'Carton', mandatory: true },
    { label: 'Item', mandatory: true },
    { label: 'Quantity', mandatory: true },
    { label: 'Length', mandatory: false },
    { label: 'Width', mandatory: false },
    { label: 'Height', mandatory: false },
    { label: 'Weight', mandatory: false },
    { label: 'IsPallet', mandatory: false },
    { label: 'Parent', mandatory: false },
    { label: 'Pallet', mandatory: false },
    { label: 'Serial', mandatory: false },
    { label: 'Tracking', mandatory: false },
    { label: 'Tiers', mandatory: false },
    { label: 'Blocks', mandatory: false },
    { label: 'SSCC', mandatory: false },
    { label: 'Lot', mandatory: false },
  ];

  /**
   * Mirrors LabelFieldMap from @orderful/platform-types. The label path in the SuiteApp
   * (TransactionHandling/label/datasetMapping.ts) matches dataset columns by label against
   * these exact dotted paths and builds the label API payload from whatever matches.
   * A column whose label isn't on this list is silently dropped — no error, no log — which
   * is the single most common reason a label comes out with blank fields.
   */
  const LABEL_FIELD_PATHS = [
    'shipment.billOfLadingNumber', 'carrier.name', 'carrier.code',
    'carton.number', 'carton.max', 'case.pack',
    'purchaseOrder.customerOrderNumber', 'department.name', 'department.number',
    'distributionCenter.name', 'distributionCenter.number',
    'purchaseOrder.eventCode', 'item.expirationDate', 'shipment.finalDestination',
    'item.gtin', 'case.innerPack', 'item.buyerPartNumber', 'item.color',
    'item.description', 'item.number', 'item.size', 'item.style',
    'item.countryOfOrigin', 'item.lotNumber', 'shipment.locationNumber',
    'purchaseOrder.markForLocationNumber', 'purchaseOrder.suggestedRetailPrice',
    'merchandise.type', 'item.productDate', 'item.upcNumber', 'item.skuNumber',
    'optionalInformation', 'purchaseOrder.number', 'purchaseOrder.type',
    'shipment.proNumber', 'pallet.cubicDimensions', 'pallet.number',
    'pallet.max', 'pallet.weight', 'pallet.units',
    'purchaseOrder.processHandlingCode', 'shipment.sscc-18',
    'shipment.sscc18LastFour', 'shipment.date',
    'shipFrom.name', 'shipFrom.address1', 'shipFrom.address2', 'shipFrom.state',
    'shipFrom.city', 'shipFrom.country', 'shipFrom.zip',
    'shipTo.careOf', 'shipTo.name', 'shipTo.address1', 'shipTo.address2',
    'shipTo.state', 'shipTo.city', 'shipTo.country', 'shipTo.zip',
    'store.number', 'store.name', 'store.address1', 'store.address2',
    'store.state', 'store.city', 'store.country', 'store.zip', 'store.careOf',
    'item.temperatureControl', 'case.unitsPerInnerPack',
    'vendor.number', 'vendor.partNumber', 'shipment.weight',
  ];

  const DEFAULT_ROW_LIMIT = 50;
  const MAX_ROW_LIMIT = 1000;

  // ---------------------------------------------------------------- serializing

  /**
   * Joins nest parent-ward: a column's `join` is the hop closest to the column, and
   * `join.join` walks back toward the base record. Serialization preserves that shape.
   */
  const serializeJoin = (join) => {
    if (!join) return undefined;
    const out = { fieldId: join.fieldId };
    if (join.source) out.source = join.source;
    if (join.target) out.target = join.target;
    const parent = serializeJoin(join.join);
    if (parent) out.join = parent;
    return out;
  };

  const serializeColumn = (column) => {
    if (!column) return undefined;
    const out = {};
    if (column.label) out.label = column.label;
    if (column.alias) out.alias = column.alias;
    if (column.fieldId) out.fieldId = column.fieldId;
    if (column.formula) out.formula = column.formula;
    if (column.type) out.type = column.type;
    const join = serializeJoin(column.join);
    if (join) out.join = join;
    return out;
  };

  const serializeCondition = (condition) => {
    if (!condition) return undefined;
    if (condition.children && condition.children.length > 0) {
      return {
        operator: condition.operator,
        children: condition.children.map(serializeCondition),
      };
    }
    return {
      operator: condition.operator,
      values: condition.values,
      column: serializeColumn(condition.column),
    };
  };

  /** Emits a spec that can be fed straight back into dryRun/save. */
  const serializeDataset = (ds) => ({
    id: ds.id,
    name: ds.name,
    description: ds.description,
    type: ds.type,
    columns: (ds.columns || []).map(serializeColumn),
    condition: serializeCondition(ds.condition),
  });

  // ------------------------------------------------------------------ building

  /** Builds a join chain from a base-first array of hops. */
  const buildJoinFromPath = (path) => {
    let join;
    path.forEach((hop) => {
      const opts = typeof hop === 'string' ? { fieldId: hop } : { ...hop };
      delete opts.join;
      if (join) opts.join = join;
      join = dataset.createJoin(opts);
    });
    return join;
  };

  /**
   * Accepts either the array shorthand (`["custrecord_carton", "item"]`, base-first)
   * or the nested object form that `describe` emits (outermost-first).
   */
  const buildJoin = (spec) => {
    if (!spec) return undefined;
    if (Array.isArray(spec)) return buildJoinFromPath(spec);

    // Flatten the nested form into base-first order.
    const path = [];
    let cursor = spec;
    while (cursor) {
      const hop = { fieldId: cursor.fieldId };
      if (cursor.source) hop.source = cursor.source;
      if (cursor.target) hop.target = cursor.target;
      path.unshift(hop);
      cursor = cursor.join;
    }
    return buildJoinFromPath(path);
  };

  let aliasCounter = 0;

  const buildColumn = (spec) => {
    if (!spec) throw new Error('Column spec is required');
    const opts = {};
    if (spec.fieldId) opts.fieldId = spec.fieldId;
    if (spec.formula) opts.formula = spec.formula;
    if (spec.type) opts.type = spec.type;
    if (spec.label) opts.label = spec.label;
    if (spec.alias) opts.alias = spec.alias;

    // A formula column with no alias fails with a bare "An alias is missing", which gives no
    // hint which column is at fault. Generate one so specs don't have to carry bookkeeping.
    if (opts.formula && !opts.alias) {
      aliasCounter += 1;
      opts.alias = `formula_${aliasCounter}`;
    }
    const join = buildJoin(spec.join || spec.joinPath);
    if (join) opts.join = join;

    if (!opts.fieldId && !opts.formula) {
      throw new Error(
        `Column "${spec.label || '(unlabeled)'}" needs either fieldId or formula`,
      );
    }
    if (opts.formula && !opts.type) {
      throw new Error(
        `Formula column "${spec.label || '(unlabeled)'}" needs an explicit type (e.g. INTEGER, STRING, FLOAT)`,
      );
    }
    return dataset.createColumn(opts);
  };

  /**
   * query.Operator is only live inside entry points, never at define() time, so the
   * operator name is resolved lazily here. Raw operator strings pass through unchanged.
   */
  const resolveOperator = (operator) => {
    if (!operator) throw new Error('Condition operator is required');
    const upper = String(operator).toUpperCase();
    if (upper === 'AND' || upper === 'OR') return upper;
    return query.Operator[upper] !== undefined
      ? query.Operator[upper]
      : operator;
  };

  const buildCondition = (spec, columnsByLabel) => {
    if (!spec) return undefined;

    if (spec.children && spec.children.length > 0) {
      return dataset.createCondition({
        operator: resolveOperator(spec.operator || 'AND'),
        children: spec.children.map((child) =>
          buildCondition(child, columnsByLabel),
        ),
      });
    }

    // Reference a column already declared in spec.columns by label, or inline a new one.
    const column = spec.columnLabel
      ? columnsByLabel[String(spec.columnLabel).toLowerCase()]
      : buildColumn(spec.column);

    if (!column) {
      throw new Error(
        `Condition references unknown column label "${spec.columnLabel}"`,
      );
    }

    return dataset.createCondition({
      column,
      operator: resolveOperator(spec.operator),
      values: spec.values,
    });
  };

  const buildDataset = (spec) => {
    if (!spec) throw new Error('spec is required');
    if (!spec.type) {
      throw new Error(
        'spec.type is required (base record type, e.g. "itemfulfillment", "transaction")',
      );
    }

    const columnSpecs = spec.columns || [];
    const columns = columnSpecs.map(buildColumn);

    const columnsByLabel = {};
    columnSpecs.forEach((columnSpec, index) => {
      if (columnSpec.label) {
        columnsByLabel[String(columnSpec.label).toLowerCase()] = columns[index];
      }
    });

    const createOpts = { type: spec.type, columns };
    if (spec.name) createOpts.name = spec.name;
    if (spec.id) createOpts.id = spec.id;
    if (spec.description) createOpts.description = spec.description;

    const ds = dataset.create(createOpts);

    const condition = buildCondition(spec.condition, columnsByLabel);
    if (condition) ds.condition = condition;

    return ds;
  };

  // ------------------------------------------------------------------- running

  const runRows = (ds, limit) => {
    const rowLimit = Math.min(Number(limit) || DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
    const paged = ds.runPaged({ pageSize: Math.min(rowLimit, MAX_ROW_LIMIT) });

    if (!paged.pageRanges || paged.pageRanges.length === 0) {
      return { totalRowCount: 0, returnedRowCount: 0, rows: [] };
    }

    const page = paged.fetch({ index: 0 });
    const rows = page.data.asMappedResults().slice(0, rowLimit);

    return {
      totalRowCount: paged.count,
      returnedRowCount: rows.length,
      rows,
    };
  };

  // ---------------------------------------------------------------- validating

  /**
   * Reimplements validatePackagingAnalyticsDataSource from the SuiteApp's
   * carton.repository so the lab reports the same pass/fail the 856 path will see.
   */
  const validatePackagingContract = (ds) => {
    const columns = ds.columns || [];
    const findByLabel = (label) =>
      columns.find(
        (column) =>
          column.label &&
          column.label.toLowerCase() === label.toLowerCase(),
      );

    const missingMandatory = PACKAGING_COLUMN_CONTRACT.filter(
      (config) => config.mandatory && !findByLabel(config.label),
    ).map((config) => config.label);

    const matched = {};
    const unrecognized = [];
    PACKAGING_COLUMN_CONTRACT.forEach((config) => {
      const column = findByLabel(config.label);
      if (column) matched[config.label] = serializeColumn(column);
    });
    columns.forEach((column) => {
      const known = PACKAGING_COLUMN_CONTRACT.some(
        (config) =>
          column.label &&
          config.label.toLowerCase() === column.label.toLowerCase(),
      );
      if (!known) unrecognized.push(column.label || '(unlabeled)');
    });

    const problems = [];
    if (missingMandatory.length > 0) {
      problems.push(
        `Missing mandatory columns: ${missingMandatory.join(', ')}`,
      );
    }

    // The SuiteApp filters on the Fulfillment column with ANY_OF against internal ids,
    // so a formula-backed Fulfillment column must return INTEGER or the filter throws.
    const fulfillment = findByLabel('Fulfillment');
    if (fulfillment && fulfillment.formula && fulfillment.type !== 'INTEGER') {
      problems.push(
        `Fulfillment column uses a formula returning ${fulfillment.type} — the SuiteApp requires INTEGER (wrap it, e.g. TO_NUMBER(...) typed INTEGER)`,
      );
    }

    return {
      validated: problems.length === 0,
      problems,
      missingMandatory,
      matchedColumns: matched,
      unrecognizedColumns: unrecognized,
    };
  };

  /**
   * Checks a dataset against the label payload contract. Both the packaging and label
   * paths require a Fulfillment column and enforce the same INTEGER-formula rule, but
   * labels match every *other* column against LABEL_FIELD_PATHS.
   */
  const validateLabelContract = (ds) => {
    const columns = ds.columns || [];
    const problems = [];

    const fulfillment = columns.find(
      (column) =>
        column.label && column.label.toLowerCase() === 'fulfillment',
    );
    if (!fulfillment) {
      problems.push(
        'No "Fulfillment" column — getDatasetMapping returns [] and no labels are produced',
      );
    } else if (fulfillment.formula && fulfillment.type !== 'INTEGER') {
      problems.push(
        `Fulfillment column uses a formula returning ${fulfillment.type} — the label path requires INTEGER`,
      );
    }

    const recognized = [];
    const ignored = [];
    columns.forEach((column) => {
      const label = column.label || '';
      if (label.toLowerCase() === 'fulfillment') return;
      const match = LABEL_FIELD_PATHS.find(
        (path) => path.toLowerCase() === label.toLowerCase(),
      );
      if (match) {
        recognized.push({ label: match, alias: column.alias });
      } else {
        ignored.push(label || '(unlabeled)');
      }
    });

    if (recognized.length === 0) {
      problems.push(
        'No column labels match LabelFieldMap — every label field would render blank',
      );
    }

    return {
      validated: problems.length === 0,
      problems,
      recognizedLabelFields: recognized,
      // Silently dropped by the SuiteApp — usually a typo or a dataset-editor default label.
      ignoredColumns: ignored,
    };
  };

  /** `contract` selects which consumer to check against: packaging (856), label, or both. */
  const buildContracts = (ds, which) => {
    const choice = (which || 'both').toLowerCase();
    const out = {};
    if (choice === 'packaging' || choice === 'both') {
      out.packaging = validatePackagingContract(ds);
    }
    if (choice === 'label' || choice === 'both') {
      out.label = validateLabelContract(ds);
    }
    return out;
  };

  // ------------------------------------------------------------------ handlers

  const actions = {
    list: () => {
      const datasets = dataset.list();
      return { count: datasets.length, datasets };
    },

    describe: (body) => {
      if (!body.id) throw new Error('describe requires "id" (dataset scriptid)');
      const ds = dataset.load({ id: body.id });
      return {
        spec: serializeDataset(ds),
        contracts: buildContracts(ds, body.contract),
      };
    },

    run: (body) => {
      if (!body.id) throw new Error('run requires "id" (dataset scriptid)');
      const ds = dataset.load({ id: body.id });

      // Optional extra filter, applied the same way the SuiteApp narrows by fulfillment.
      if (body.condition) {
        const columnsByLabel = {};
        (ds.columns || []).forEach((column) => {
          if (column.label) {
            columnsByLabel[column.label.toLowerCase()] = column;
          }
        });
        const extra = buildCondition(body.condition, columnsByLabel);
        // AND-wrap whenever the dataset carries any condition, including a single leaf.
        // carton.repository.ts only wraps when condition.children is non-empty, which
        // replaces — and so silently drops — a single-leaf condition. Don't copy that here:
        // this endpoint has to show the rows the real dataset returns, not more of them.
        ds.condition = ds.condition
          ? dataset.createCondition({
              operator: 'AND',
              children: [ds.condition, extra],
            })
          : extra;
      }

      return {
        id: body.id,
        ...runRows(ds, body.limit),
      };
    },

    dryRun: (body) => {
      const ds = buildDataset(body.spec);
      const result = runRows(ds, body.limit);
      return {
        saved: false,
        resolvedSpec: serializeDataset(ds),
        contracts: buildContracts(ds, body.contract),
        ...result,
      };
    },

    save: (body) => {
      const ds = buildDataset(body.spec);
      const contracts = buildContracts(ds, body.contract);

      // save()'s documented signature is inconsistent across NetSuite versions, so try
      // the no-arg form and fall back to the options form, reporting which one took.
      let saveResult;
      let saveSignature;
      let firstError;
      try {
        saveResult = ds.save();
        saveSignature = 'save()';
      } catch (error) {
        firstError = error;
        const opts = {};
        if (body.spec.name) opts.name = body.spec.name;
        if (body.spec.id) opts.id = body.spec.id;
        saveResult = ds.save(opts);
        saveSignature = 'save({name,id})';
      }

      // Confirm it round-trips: a save that "succeeds" but can't be loaded back by
      // scriptid is useless to the SuiteApp at runtime.
      let reloaded = null;
      let reloadError = null;
      const reloadId = body.spec.id || ds.id;
      if (reloadId) {
        try {
          reloaded = serializeDataset(dataset.load({ id: reloadId }));
        } catch (error) {
          reloadError = error.message;
        }
      }

      return {
        saved: true,
        saveSignature,
        saveResult,
        firstAttemptError: firstError ? firstError.message : undefined,
        datasetId: ds.id,
        reloaded,
        reloadError,
        contracts,
        executingUser: runtime.getCurrentUser().id,
        executingRole: runtime.getCurrentUser().role,
      };
    },

    /**
     * Load an existing dataset, mutate it in place, save it back under the same scriptid.
     * Distinct from `save`, which builds a brand-new dataset from a full spec — `patch` keeps
     * everything it isn't told to touch, so it can edit datasets authored in the Analytics UI
     * without having to reconstruct them (formula columns in particular do not fully
     * round-trip through create()).
     *
     * Pass dryRun:true to see before/after plus rows without persisting.
     */
    patch: (body) => {
      if (!body.id) throw new Error('patch requires "id" (dataset scriptid)');
      const ds = dataset.load({ id: body.id });
      const before = serializeDataset(ds);

      const columnsByLabel = {};
      (ds.columns || []).forEach((column) => {
        if (column.label) columnsByLabel[column.label.toLowerCase()] = column;
      });

      const applied = [];

      if (body.removeColumnLabels && body.removeColumnLabels.length > 0) {
        const drop = body.removeColumnLabels.map((l) => String(l).toLowerCase());
        const kept = (ds.columns || []).filter(
          (column) => !column.label || drop.indexOf(column.label.toLowerCase()) === -1,
        );
        applied.push(`removed ${(ds.columns || []).length - kept.length} column(s)`);
        ds.columns = kept;
      }

      if (body.addColumns && body.addColumns.length > 0) {
        const added = body.addColumns.map(buildColumn);
        ds.columns = (ds.columns || []).concat(added);
        body.addColumns.forEach((spec, index) => {
          if (spec.label) columnsByLabel[spec.label.toLowerCase()] = added[index];
        });
        applied.push(`added ${added.length} column(s)`);
      }

      // Clearing matters for real: a baked-in Fulfillment filter is ANDed with the consumer's
      // own filter at runtime, which is what silently zeroes out a label dataset.
      if (body.clearCondition) {
        ds.condition = null;
        applied.push('cleared condition');
      } else if (body.setCondition) {
        ds.condition = buildCondition(body.setCondition, columnsByLabel);
        applied.push('replaced condition');
      }

      // Dataset.name is read-only on a loaded dataset ("Read only property: name"), so a rename
      // can only be requested through the save() options, never by assigning to the object.

      const contracts = buildContracts(ds, body.contract);

      if (body.dryRun) {
        return {
          saved: false,
          applied,
          before,
          after: serializeDataset(ds),
          contracts,
          ...runRows(ds, body.limit),
        };
      }

      // newId saves the mutated copy under a fresh scriptid instead of overwriting. Overwriting
      // in place fails with a bare "Unable to save the dataset."; this distinguishes "cannot
      // overwrite an existing scriptid" from "cannot save a loaded dataset at all".
      const targetId = body.newId || body.id;
      const saveResult = ds.save({
        name: body.name || ds.name,
        id: targetId,
      });

      // Read back from the account rather than trusting the in-memory object.
      let reloaded = null;
      let reloadError = null;
      try {
        reloaded = serializeDataset(dataset.load({ id: targetId }));
      } catch (error) {
        reloadError = error.message;
      }

      return {
        saved: true,
        applied,
        saveResult,
        before,
        after: reloaded,
        reloadError,
        contracts,
      };
    },

    /**
     * Brute-force a join or field path name server-side.
     *
     * NetSuite exposes no way to enumerate the joins available on a record — the Records
     * Catalog is UI-session only, and dataset errors just say the join "was not found". So the
     * only way to discover an internal join id is to try it. Doing that one candidate per HTTP
     * round trip is painfully slow; this runs a whole list in one call and reports which
     * resolve, distinguishing "not a join" from other failures.
     *
     * body: { type, candidates: [string], formulaTemplate, baseColumns?, condition?, pageSize? }
     * formulaTemplate must contain the token __C__, replaced by each candidate.
     */
    probeJoins: (body) => {
      if (!body.type) throw new Error('probeJoins requires "type"');
      if (!body.formulaTemplate || body.formulaTemplate.indexOf('__C__') === -1) {
        throw new Error('probeJoins requires "formulaTemplate" containing __C__');
      }
      const candidates = body.candidates || [];
      if (candidates.length === 0) {
        throw new Error('probeJoins requires a non-empty "candidates" array');
      }

      const pageSize = Math.min(Number(body.pageSize) || 5, 50);
      const results = [];

      candidates.forEach((candidate, index) => {
        const formula = body.formulaTemplate.replace(/__C__/g, candidate);
        try {
          const columns = (body.baseColumns || []).map(buildColumn);
          columns.push(
            dataset.createColumn({
              formula,
              type: body.returnType || 'STRING',
              label: 'probe',
              alias: `probe_${index}`,
            }),
          );

          const columnsByLabel = {};
          (body.baseColumns || []).forEach((spec, i) => {
            if (spec.label) columnsByLabel[spec.label.toLowerCase()] = columns[i];
          });

          const ds = dataset.create({ type: body.type, columns });
          const condition = buildCondition(body.condition, columnsByLabel);
          if (condition) ds.condition = condition;

          const paged = ds.runPaged({ pageSize });
          let sample = null;
          if (paged.pageRanges && paged.pageRanges.length > 0) {
            const rows = paged.fetch({ index: 0 }).data.asMappedResults();
            if (rows.length > 0) sample = rows[0][`probe_${index}`];
          }
          results.push({
            candidate,
            ok: true,
            rowCount: paged.count,
            sample,
          });
        } catch (error) {
          const message = error.message || String(error);
          results.push({
            candidate,
            ok: false,
            notAJoin: message.indexOf('was not found') !== -1,
            error: message.slice(0, 200),
          });
        }
      });

      const resolved = results.filter((r) => r.ok);
      return {
        tried: candidates.length,
        resolvedCount: resolved.length,
        resolved,
        // Full list kept so "not a join" vs "other error" stays visible — an "other error"
        // often means the join name was right and something downstream was wrong.
        all: results,
      };
    },

    validate: (body) => {
      const ds = body.id ? dataset.load({ id: body.id }) : buildDataset(body.spec);
      return {
        id: body.id || ds.id,
        contracts: buildContracts(ds, body.contract),
        spec: serializeDataset(ds),
      };
    },
  };

  const dispatch = (body) => {
    const action = body && body.action;
    if (!action) {
      return {
        ok: false,
        error: {
          message: 'No "action" supplied',
          availableActions: Object.keys(actions),
        },
      };
    }

    const handler = actions[action];
    if (!handler) {
      return {
        ok: false,
        error: {
          message: `Unknown action "${action}"`,
          availableActions: Object.keys(actions),
        },
      };
    }

    try {
      return { ok: true, action, result: handler(body) };
    } catch (error) {
      log.error({
        title: `datasetLab ${action} failed`,
        details: `${error.name}: ${error.message}\n${error.stack}`,
      });
      // Errors come back as a 200 with ok:false so the caller always gets parseable
      // JSON instead of NetSuite's error envelope.
      return {
        ok: false,
        action,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      };
    }
  };

  return {
    get: (params) => dispatch(params || {}),
    post: (body) => dispatch(body || {}),
  };
});
