/* =============================================================================
   schemaIr.js — the software-domain model of record  (window.GxSchema)
   =============================================================================

   PUBLIC SHAPE ONLY, deliberately — per `.ai/AGENTS.md`'s IP-BOUNDARY STANDARD
   a fork must be able to construct and validate a model, exactly like
   `GxScene` and `GxTables` on the other domains. The POLICY that decides how a
   model is produced (the promotion ladder, the pipeline translator) lives in
   the private root (`assets/schema-editor/domains/software/promote.js`) and is
   injected, not shipped here.

   What this is FOR (architecture/software-design-model.md §2):

     - The record that GENERATES the symbol is the same record the rules read.
       `Column.id`, the SVG `data-pin="col:<id>:left"`, and the id an SRC rule
       resolves a foreign key against are three spellings of ONE identity, and
       if they drift every connection rule silently produces zero findings.
       This file is the shape all three derive from.

     - `candidate` is REQUIRED with no default — an entity the user drew is
       trusted; one inferred from a scanned table is a guess. A default picks a
       side silently.

     - `origin` rides on entities AND columns, and a partial address is rejected
       rather than carried (region ids restart per page, so page alone or
       regionId alone resolves to the wrong table silently).

     - `nullable` is three-state: true / false / null = unknown.

   `validate()` returns an array of error strings and never throws, so a
   malformed model from one tool cannot take down the receiving one. Same
   contract shape as GxTables.validate and GxScene.validate.
   ============================================================================= */

(function () {
    'use strict';

    var G = (typeof globalThis !== 'undefined') ? globalThis : window;

    var SCHEMA = 'gx-schema/1';
    var KIND = ['table', 'view', 'weak', 'external'];
    var CONSTRAINT_KIND = ['check', 'unique', 'not-null'];
    var RELATION_KIND = ['fk', 'derives', 'union'];
    var CARDINALITY = ['1:1', '1:N', '0:1', '0:N'];
    var STATE_KIND = ['initial', 'normal', 'final', 'choice', 'composite'];
    var PARTICIPANT_KIND = ['actor', 'system'];
    var MESSAGE_KIND = ['call', 'return', 'self'];
    var DEPLOYMENT = ['monolithic', 'tiered', 'sharded', 'replicated', 'multi-db'];
    var TENANCY = ['single', 'shared-schema', 'schema-per-tenant', 'db-per-tenant'];
    var CONSISTENCY = ['strong', 'eventual'];

    function _isNum(v) { return typeof v === 'number' && isFinite(v); }
    function _isBool(v) { return typeof v === 'boolean'; }
    function _isInt0(v) { return _isNum(v) && v >= 0 && Math.floor(v) === v; }

    /* ── construction ─────────────────────────────────────────── */

    /** One attribute row. `id` is the load-bearing identity: it is what the
        SVG pin (`data-pin="col:<id>:left"`), the FK resolver, and the column
        attributes all agree on. */
    function createColumn(opts) {
        opts = opts || {};
        var col = {
            id: opts.id != null ? String(opts.id) : null,
            name: opts.name != null ? String(opts.name) : null,
            type: opts.type != null ? String(opts.type) : null,
            pk: !!opts.pk,
            identity: !!opts.identity,
            unique: !!opts.unique,
            nullable: opts.nullable === true ? true : (opts.nullable === false ? false : null),
            fk: opts.fk && typeof opts.fk === 'object'
                ? { entity: opts.fk.entity, column: opts.fk.column, schema: opts.fk.schema || null }
                : null,
            generated: opts.generated && typeof opts.generated === 'object'
                ? { expr: opts.generated.expr, sources: (opts.generated.sources || []).slice() }
                : null,
            default: opts.default != null ? String(opts.default) : null,
            comment: opts.comment != null ? String(opts.comment) : null,
            origin: opts.origin && typeof opts.origin === 'object' ? origin(opts.origin) : null,
            inferred: !!opts.inferred,
            confidence: _isNum(opts.confidence) ? opts.confidence : null,
        };
        return col;
    }

    function createEntity(opts) {
        opts = opts || {};
        if (typeof opts.candidate !== 'boolean') {
            throw new Error('GxSchema.createEntity: candidate (boolean) is required — ' +
                'an entity the user drew is trusted, one inferred from a scanned table is a guess, ' +
                'and there is no honest default between them (software-design-model.md §2)');
        }
        return {
            id: opts.id != null ? String(opts.id) : null,
            name: opts.name != null ? String(opts.name) : null,
            schemaName: opts.schemaName != null ? String(opts.schemaName) : null,
            kind: opts.kind || 'table',
            columns: (opts.columns || []).map(createColumn),
            constraints: (opts.constraints || []).map(createConstraint),
            origin: opts.origin && typeof opts.origin === 'object' ? origin(opts.origin) : null,
            candidate: opts.candidate,
            confidence: _isNum(opts.confidence) ? opts.confidence : null,
        };
    }

    function createConstraint(opts) {
        opts = opts || {};
        return {
            id: opts.id != null ? String(opts.id) : null,
            kind: opts.kind || 'check',
            expr: opts.expr != null ? String(opts.expr) : null,
            columns: (opts.columns || []).map(String),
            origin: opts.origin && typeof opts.origin === 'object' ? origin(opts.origin) : null,
            inferred: !!opts.inferred,
        };
    }

    function createRelation(opts) {
        opts = opts || {};
        return {
            id: opts.id != null ? String(opts.id) : null,
            kind: opts.kind || 'fk',
            from: opts.from ? { entity: opts.from.entity, column: opts.from.column || null } : null,
            to: opts.to ? { entity: opts.to.entity, column: opts.to.column || null } : null,
            cardinality: opts.cardinality || null,
            onDelete: opts.onDelete != null ? String(opts.onDelete) : null,
            inferred: !!opts.inferred,
        };
    }

    function createStats(opts) {
        opts = opts || {};
        return {
            columnId: opts.columnId != null ? String(opts.columnId) : null,
            rows: _isNum(opts.rows) ? opts.rows : null,
            distinct: _isNum(opts.distinct) ? opts.distinct : null,
            nulls: _isNum(opts.nulls) ? opts.nulls : null,
            min: opts.min != null ? opts.min : null,
            max: opts.max != null ? opts.max : null,
            maxLen: _isNum(opts.maxLen) ? opts.maxLen : null,
        };
    }

    function createState(opts) {
        opts = opts || {};
        return {
            id: opts.id != null ? String(opts.id) : null,
            name: opts.name != null ? String(opts.name) : null,
            kind: opts.kind || 'normal',
            parent: opts.parent != null ? String(opts.parent) : null,
            entry: (opts.entry || []).map(String),
            exit: (opts.exit || []).map(String),
        };
    }

    function createTransition(opts) {
        opts = opts || {};
        return {
            id: opts.id != null ? String(opts.id) : null,
            from: opts.from != null ? String(opts.from) : null,
            to: opts.to != null ? String(opts.to) : null,
            event: opts.event != null ? String(opts.event) : null,
            guard: opts.guard != null ? String(opts.guard) : null,
            actions: (opts.actions || []).map(String),
        };
    }

    function createParticipant(opts) {
        opts = opts || {};
        return {
            id: opts.id != null ? String(opts.id) : null,
            name: opts.name != null ? String(opts.name) : null,
            kind: opts.kind || 'actor',
            order: _isInt0(opts.order) ? opts.order : null,
        };
    }

    function createMessage(opts) {
        opts = opts || {};
        return {
            id: opts.id != null ? String(opts.id) : null,
            from: opts.from != null ? String(opts.from) : null,
            to: opts.to != null ? String(opts.to) : null,
            label: opts.label != null ? String(opts.label) : null,
            kind: opts.kind || 'call',
            seq: _isInt0(opts.seq) ? opts.seq : null,
        };
    }

    function createPosture(opts) {
        opts = opts || {};
        return {
            deployment: opts.deployment || 'monolithic',
            tenancy: opts.tenancy || 'single',
            boundaries: (opts.boundaries || []).map(function (b) {
                return { name: b.name, entities: (b.entities || []).map(String) };
            }),
            shardKey: opts.shardKey != null ? String(opts.shardKey) : null,
            tenantKey: opts.tenantKey != null ? String(opts.tenantKey) : null,
            consistency: opts.consistency || 'strong',
            scale: opts.scale || null,
        };
    }

    /** `origin` is the address `GxTables` already carries. BOTH page and
        regionId are required to address anything; region ids restart per page,
        so a bare regionId resolves to whichever page comes first. Half an
        address is rejected by validate(), never carried. */
    /**
     * A return address, in whichever of its two forms the producer has.
     *
     *   page + regionId   a table extracted from a PDF. Region ids restart per
     *                     page, so a regionId alone resolves to whichever page
     *                     comes first — both halves are required together.
     *   sheetId (+nodeId) a node or sheet in TAFNE. The sheet id is already
     *                     unique; there is no page to qualify it with.
     *
     * `sheetId` and `nodeId` were dropped by this normaliser while the pipeline
     * path was emitting them, which made every pipeline-promoted column
     * unaddressable: a rename came back as an un-appliable note and read as the
     * feature not working. A normaliser that silently discards a field is worse
     * than one that rejects it.
     */
    function origin(opts) {
        opts = opts || {};
        return {
            tool: opts.tool || null,
            doc: opts.doc || null,
            page: _isNum(opts.page) ? opts.page : null,
            regionId: opts.regionId != null ? String(opts.regionId) : null,
            sheetId: opts.sheetId != null ? String(opts.sheetId) : null,
            nodeId: opts.nodeId != null ? String(opts.nodeId) : null,
        };
    }

    function createModel(opts) {
        opts = opts || {};
        return {
            schema: SCHEMA,
            meta: {
                source: opts.source != null ? String(opts.source) : null,
                title: opts.title != null ? String(opts.title) : null,
            },
            entities: (opts.entities || []).map(createEntity),
            relations: (opts.relations || []).map(createRelation),
            stats: (opts.stats || []).map(createStats),
            states: (opts.states || []).map(createState),
            transitions: (opts.transitions || []).map(createTransition),
            participants: (opts.participants || []).map(createParticipant),
            messages: (opts.messages || []).map(createMessage),
            posture: opts.posture && typeof opts.posture === 'object' ? createPosture(opts.posture) : null,
        };
    }

    /* ── validate ─────────────────────────────────────────────── */

    function _checkOrigin(originVal, errs, where) {
        if (originVal == null) return;
        if (typeof originVal !== 'object') {
            errs.push(where + ': origin must be an object or null');
            return;
        }
        // Two valid forms, and a PARTIAL of either is refused. The PDF form
        // needs both halves because region ids repeat across pages, so either
        // alone resolves to the wrong table silently. The TAFNE form needs only
        // the sheet id, which is already unique.
        var pdfForm = originVal.page != null && originVal.regionId != null;
        var sheetForm = originVal.sheetId != null;
        if (!pdfForm && !sheetForm) {
            errs.push(where + ': origin must carry BOTH page and regionId, or a sheetId ' +
                '(region ids repeat across pages, so either alone is not an address)');
        }
    }

    function validate(model) {
        var errs = [];
        if (!model || typeof model !== 'object') return ['model is not an object'];
        if (model.schema !== SCHEMA) errs.push('model.schema must be "' + SCHEMA + '"');
        if (!Array.isArray(model.entities)) errs.push('model.entities must be an array');

        var entityIds = {};
        var colIdsByEntity = {};
        var stateIds = {};
        var participantIds = {};

        (Array.isArray(model.entities) ? model.entities : []).forEach(function (e, ei) {
            var where = 'entities[' + ei + '] "' + (e && e.name) + '"';
            if (!e || typeof e !== 'object') { errs.push(where + ': not an object'); return; }
            if (!e.id) { errs.push(where + ': missing id'); return; }
            if (entityIds[e.id]) errs.push('duplicate entity id "' + e.id + '"');
            entityIds[e.id] = true;
            if (KIND.indexOf(e.kind) < 0) errs.push(where + ': kind must be one of ' + KIND.join('/'));
            if (typeof e.candidate !== 'boolean') {
                errs.push(where + ': candidate must be boolean (required, no default)');
            }
            if (e.confidence != null && (!_isNum(e.confidence) || e.confidence < 0 || e.confidence > 1)) {
                errs.push(where + ': confidence must be null or 0..1');
            }
            _checkOrigin(e.origin, errs, where);

            if (!Array.isArray(e.columns)) { errs.push(where + ': columns is not an array'); return; }
            var seenCols = {};
            colIdsByEntity[e.id] = {};
            e.columns.forEach(function (c, ci) {
                var cw = where + ' column[' + ci + '] "' + (c && c.id) + '"';
                if (!c || typeof c !== 'object') { errs.push(cw + ': not an object'); return; }
                if (!c.id) { errs.push(cw + ': missing id'); return; }
                if (seenCols[c.id]) errs.push(where + ': duplicate column id "' + c.id + '"');
                seenCols[c.id] = true;
                colIdsByEntity[e.id][c.id] = true;
                if (!c.name) errs.push(cw + ': missing name');
                if (!c.type) errs.push(cw + ': missing type');
                if (c.nullable != null && typeof c.nullable !== 'boolean') {
                    errs.push(cw + ': nullable must be true, false, or null (=unknown)');
                }
                if (c.confidence != null && (!_isNum(c.confidence) || c.confidence < 0 || c.confidence > 1)) {
                    errs.push(cw + ': confidence must be null or 0..1');
                }
                if (c.fk) {
                    if (!c.fk.entity || !c.fk.column) {
                        errs.push(cw + ': fk must name both entity and column');
                    }
                }
                if (c.generated && (!c.generated.expr || !Array.isArray(c.generated.sources))) {
                    errs.push(cw + ': generated must carry expr and a sources array');
                }
                _checkOrigin(c.origin, errs, cw);
            });

            (e.constraints || []).forEach(function (con, ci) {
                var cw = where + ' constraint[' + ci + ']';
                if (!con || typeof con !== 'object') { errs.push(cw + ': not an object'); return; }
                if (CONSTRAINT_KIND.indexOf(con.kind) < 0) {
                    errs.push(cw + ': kind must be one of ' + CONSTRAINT_KIND.join('/'));
                }
                (con.columns || []).forEach(function (cid) {
                    if (!colIdsByEntity[e.id] || !colIdsByEntity[e.id][cid]) {
                        errs.push(cw + ': column "' + cid + '" not on this entity');
                    }
                });
            });
        });

        (model.relations || []).forEach(function (r, ri) {
            var where = 'relations[' + ri + '] "' + (r && r.id) + '"';
            if (!r || typeof r !== 'object') { errs.push(where + ': not an object'); return; }
            if (RELATION_KIND.indexOf(r.kind) < 0) errs.push(where + ': kind must be fk/derives/union');
            if (r.cardinality != null && CARDINALITY.indexOf(r.cardinality) < 0) {
                errs.push(where + ': cardinality must be null or one of ' + CARDINALITY.join('/'));
            }
            [r.from, r.to].forEach(function (end, i) {
                if (!end || !entityIds[end.entity]) {
                    errs.push(where + ': endpoint ' + (i === 0 ? 'from' : 'to') +
                        ' references unknown entity "' + (end && end.entity) + '"');
                } else if (end.column != null) {
                    var c = (model.entities || []).find(function (e) { return e.id === end.entity; });
                    if (c && c.columns && !c.columns.some(function (col) { return col.id === end.column; })) {
                        errs.push(where + ': endpoint column "' + end.column + '" not on entity "' + end.entity + '"');
                    }
                }
            });
        });

        (model.stats || []).forEach(function (s, si) {
            var where = 'stats[' + si + ']';
            if (!s || typeof s !== 'object') { errs.push(where + ': not an object'); return; }
            if (!s.columnId) errs.push(where + ': missing columnId');
            if (s.rows != null && !_isInt0(s.rows)) errs.push(where + ': rows must be a non-negative integer');
            if (s.distinct != null && !_isInt0(s.distinct)) errs.push(where + ': distinct must be a non-negative integer');
        });

        (model.states || []).forEach(function (s, si) {
            var where = 'states[' + si + '] "' + (s && s.id) + '"';
            if (!s || typeof s !== 'object') { errs.push(where + ': not an object'); return; }
            if (!s.id) { errs.push(where + ': missing id'); return; }
            if (stateIds[s.id]) errs.push('duplicate state id "' + s.id + '"');
            stateIds[s.id] = true;
            if (STATE_KIND.indexOf(s.kind) < 0) errs.push(where + ': kind must be one of ' + STATE_KIND.join('/'));
        });

        (model.transitions || []).forEach(function (t, ti) {
            var where = 'transitions[' + ti + '] "' + (t && t.id) + '"';
            if (!t || typeof t !== 'object') { errs.push(where + ': not an object'); return; }
            if (!stateIds[t.from]) errs.push(where + ': from references unknown state "' + t.from + '"');
            if (!stateIds[t.to]) errs.push(where + ': to references unknown state "' + t.to + '"');
        });

        (model.participants || []).forEach(function (p, pi) {
            var where = 'participants[' + pi + '] "' + (p && p.id) + '"';
            if (!p || typeof p !== 'object') { errs.push(where + ': not an object'); return; }
            if (!p.id) { errs.push(where + ': missing id'); return; }
            if (participantIds[p.id]) errs.push('duplicate participant id "' + p.id + '"');
            participantIds[p.id] = true;
            if (PARTICIPANT_KIND.indexOf(p.kind) < 0) errs.push(where + ': kind must be actor/system');
        });

        (model.messages || []).forEach(function (m, mi) {
            var where = 'messages[' + mi + '] "' + (m && m.id) + '"';
            if (!m || typeof m !== 'object') { errs.push(where + ': not an object'); return; }
            if (MESSAGE_KIND.indexOf(m.kind) < 0) errs.push(where + ': kind must be call/return/self');
            if (!participantIds[m.from]) errs.push(where + ': from references unknown participant "' + m.from + '"');
            if (!participantIds[m.to]) errs.push(where + ': to references unknown participant "' + m.to + '"');
        });

        if (model.posture) {
            var p = model.posture;
            if (DEPLOYMENT.indexOf(p.deployment) < 0) errs.push('posture.deployment invalid');
            if (TENANCY.indexOf(p.tenancy) < 0) errs.push('posture.tenancy invalid');
            if (CONSISTENCY.indexOf(p.consistency) < 0) errs.push('posture.consistency invalid');
            (p.boundaries || []).forEach(function (b, bi) {
                (b.entities || []).forEach(function (eid) {
                    if (!entityIds[eid]) errs.push('posture.boundaries[' + bi + ']: unknown entity "' + eid + '"');
                });
            });
            if (p.scale) {
                Object.keys(p.scale).forEach(function (eid) {
                    if (!entityIds[eid]) errs.push('posture.scale: unknown entity "' + eid + '"');
                });
            }
        }

        return errs;
    }

    /* ── round-trip ───────────────────────────────────────────── */
    /** Serialize then re-parse and re-validate; returns {model, errors} where
        errors is [] exactly when the model survives a JSON round trip. */
    function roundTrip(model) {
        var json = JSON.stringify(model);
        var back;
        try { back = JSON.parse(json); }
        catch (e) { return { model: null, errors: ['round trip failed to parse: ' + e.message] }; }
        return { model: back, errors: validate(back) };
    }

    G.GxSchema = {
        SCHEMA: SCHEMA,
        KIND: KIND,
        RELATION_KIND: RELATION_KIND,
        CARDINALITY: CARDINALITY,
        STATE_KIND: STATE_KIND,
        DEPLOYMENT: DEPLOYMENT,
        TENANCY: TENANCY,
        origin: origin,
        createColumn: createColumn,
        createEntity: createEntity,
        createConstraint: createConstraint,
        createRelation: createRelation,
        createStats: createStats,
        createState: createState,
        createTransition: createTransition,
        createParticipant: createParticipant,
        createMessage: createMessage,
        createPosture: createPosture,
        createModel: createModel,
        validate: validate,
        roundTrip: roundTrip,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = G.GxSchema;
})();