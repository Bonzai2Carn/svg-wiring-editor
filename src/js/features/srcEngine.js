/* ============================================================
   GINEXYS — SRC (Software Rule Check) — window.GxSrcEngine
   tools/schema-editor/src/js/features/srcEngine.js   submodule (public).

   The software-domain rule layer, tiered like the electrical side
   (software-design-model.md §7):

     Tier 1  structural   — graph properties only. The multimeter.
     Tier 2  semantic     — needs types as a lattice + column stats.
                             The continuity + values layer.
     Tier 3  architecture — needs a DECLARED posture. The logic analyzer.

   `ctx = { entities, columns, relations, constraints, states, transitions,
            stats, dialects, posture }` — dialects are injected by the
   caller (type-dialects.js is private and stays out of this forkable
   file), so a fork needs no dialect vocabulary to run the engine.

   The ercEngine.js contract is preserved verbatim: `_runRulePack(rules,
   ctx, findings)` runs every rule through try/catch so one broken rule
   cannot kill the run; a finding may set its own `severity` to override
   the rule default; findings carry `elementIds` for flyToElement.

   `runSrcStructured()` returns `coverage` computed here, never accepted
   from the caller, and `null` — not `0` — for a pack that could not run:
   "no tenancy findings" over a model with no declared posture must not
   read as "tenancy is fine".
   ============================================================ */

(function () {
    'use strict';

    var G = (typeof globalThis !== 'undefined') ? globalThis : window;

    /* ── shared helpers ──────────────────────────────────────── */

    function f(entityId, columnId, severity, message) {
        var out = { message: message, elementIds: [] };
        if (entityId != null) out.entityId = entityId;
        if (columnId != null) out.columnId = columnId;
        return out;
    }

    var PK_NAME = /^(id|.*_id)$/i;
    var EMAIL_LIKE = /^(email|e-mail|username|nickname?|login|handle)$/i;
    var MONEY_NAME = /(^|_)(price|amount|total|balance|cost|fee|salary|revenue)(_|$)/i;
    var PII_NAME = /(^|_)(email|e-mail|phone|ssn|dob|birth|passport|credit_card|bank_account)(_|$)/i;
    var BOOL_PREFIX = /^is_/;
    var SNAKE = /^[a-z0-9_]+$/;
    var CAMEL = /^[a-z][a-zA-Z0-9]*$/;
    var PASCAL = /^[A-Z][a-zA-Z0-9]*$/;

    /* ── Tier 1 — structural ─────────────────────────────────── */

    var TIER1 = [
        {
            id: 'entity-no-primary-key', severity: 'error',
            check: function (ctx) {
                return ctx.entities
                    .filter(function (e) { return e.kind !== 'external' && !e.columns.some(function (c) { return c.pk; }); })
                    .map(function (e) { return f(e.id, null, 'error', 'Entity "' + e.name + '" has no primary key'); });
            },
        },
        {
            id: 'fk-target-missing', severity: 'error',
            check: function (ctx) {
                var out = [];
                ctx.relations.forEach(function (r) {
                    if (r.kind !== 'fk') return;
                    var from = ctx.entities.find(function (e) { return e.id === r.from.entity; });
                    var to = ctx.entities.find(function (e) { return e.id === r.to.entity; });
                    if (!to) { out.push(f(r.from.entity, null, 'error', 'FK ' + r.id + ': target entity "' + r.to.entity + '" does not exist')); return; }
                    if (!from) { out.push(f(r.to.entity, null, 'error', 'FK ' + r.id + ': source entity "' + r.from.entity + '" does not exist')); return; }
                    if (r.from.column && !from.columns.some(function (c) { return c.id === r.from.column; })) {
                        out.push(f(from.id, null, 'error', 'FK ' + r.id + ': source column "' + r.from.column + '" does not exist on "' + from.name + '"'));
                    }
                    if (r.to.column && !to.columns.some(function (c) { return c.id === r.to.column; })) {
                        out.push(f(from.id, null, 'error', 'FK ' + r.id + ': target column "' + r.to.column + '" does not exist on "' + to.name + '"'));
                    }
                });
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        if (!c.fk) return;
                        var to = ctx.entities.find(function (x) { return x.id === c.fk.entity; });
                        if (!to || (c.fk.column && !to.columns.some(function (x) { return x.id === c.fk.column; }))) {
                            out.push(f(e.id, c.id, 'error', 'Column "' + c.name + '" references a missing target ' + c.fk.entity + (c.fk.column ? '.' + c.fk.column : '')));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'fk-type-mismatch', severity: 'error',
            check: function (ctx) {
                var out = [];
                var dial = ctx.dialects;
                if (!dial || typeof dial.sameClass !== 'function') return out;
                ctx.relations.forEach(function (r) {
                    if (r.kind !== 'fk') return;
                    var from = ctx.entities.find(function (e) { return e.id === r.from.entity; });
                    var to = ctx.entities.find(function (e) { return e.id === r.to.entity; });
                    if (!from || !to) return;
                    var fc = from.columns.find(function (c) { return c.id === r.from.column; });
                    var tc = to.columns.find(function (c) { return c.id === r.to.column; });
                    if (!fc || !tc) return;
                    if (dial.sameClass(fc.type, tc.type) === false) {
                        out.push(f(from.id, fc.id, 'error', 'FK ' + r.id + ': type mismatch ' + fc.type + ' \u2192 ' + tc.type + ' (' + fc.name + ' \u2192 ' + tc.name + ')'));
                    }
                });
                return out;
            },
        },
        {
            id: 'fk-not-unique-target', severity: 'error',
            check: function (ctx) {
                var out = [];
                ctx.relations.forEach(function (r) {
                    if (r.kind !== 'fk') return;
                    var to = ctx.entities.find(function (e) { return e.id === r.to.entity; });
                    if (!to || !r.to.column) return;
                    var tc = to.columns.find(function (c) { return c.id === r.to.column; });
                    if (!tc) return;
                    if (!tc.pk && !tc.unique) {
                        out.push(f(r.from.entity, r.from.column, 'error', 'FK ' + r.id + ' references "' + tc.name + '" which is neither a primary key nor unique'));
                    }
                });
                return out;
            },
        },
        {
            id: 'duplicate-column-name', severity: 'error',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    var seen = new Set();
                    e.columns.forEach(function (c) {
                        var key = String(c.name).toLowerCase();
                        if (seen.has(key)) out.push(f(e.id, c.id, 'error', 'Duplicate column "' + c.name + '" on "' + e.name + '"'));
                        seen.add(key);
                    });
                });
                return out;
            },
        },
        {
            id: 'duplicate-entity-name', severity: 'error',
            check: function (ctx) {
                var out = [];
                var seen = new Set();
                ctx.entities.forEach(function (e) {
                    var key = String(e.name).toLowerCase();
                    if (seen.has(key)) out.push(f(e.id, null, 'error', 'Duplicate entity name "' + e.name + '"'));
                    seen.add(key);
                });
                return out;
            },
        },
        {
            id: 'orphan-entity', severity: 'info',
            check: function (ctx) {
                if (!ctx.relations.length) return [];
                var touched = new Set();
                ctx.relations.forEach(function (r) { touched.add(r.from.entity); touched.add(r.to.entity); });
                return ctx.entities
                    .filter(function (e) { return e.kind !== 'external' && !touched.has(e.id); })
                    .map(function (e) { return f(e.id, null, 'info', 'Entity "' + e.name + '" is not referenced by any relation'); });
            },
        },
    ];

    /* ── Tier 2 — semantic ───────────────────────────────────── */

    /** FK cycles. A cycle of NOT NULL FK columns cannot be inserted in any
        order — valid DDL, undeployable schema. */
    function fkCycles(ctx) {
        var rels = ctx.relations.filter(function (r) { return r.kind === 'fk' && r.to.entity && r.from.entity; });
        var adj = {};
        rels.forEach(function (r) {
            if (!adj[r.from.entity]) adj[r.from.entity] = [];
            adj[r.from.entity].push(r);
        });
        var cycles = [];
        var stack = [];
        var onStack = {};
        var done = {};
        var edgesByPair = {};
        rels.forEach(function (r) { edgesByPair[r.from.entity + '|' + r.to.entity] = r; });
        var dfs = function (node) {
            onStack[node] = true;
            stack.push(node);
            var edges = adj[node] || [];
            for (var i = 0; i < edges.length; i++) {
                var e = edges[i];
                if (onStack[e.to.entity]) {
                    var start = stack.indexOf(e.to.entity);
                    var cycleEdges = [];
                    for (var j = start; j < stack.length; j++) {
                        var from = stack[j];
                        var to = (j + 1 < stack.length) ? stack[j + 1] : e.to.entity;
                        var edge = edgesByPair[from + '|' + to];
                        if (edge) cycleEdges.push(edge);
                    }
                    cycles.push(cycleEdges);
                } else if (!done[e.to.entity]) {
                    dfs(e.to.entity);
                }
            }
            stack.pop();
            onStack[node] = false;
            done[node] = true;
        };
        ctx.entities.forEach(function (e) { if (!done[e.id]) dfs(e.id); });
        return cycles;
    }

    var TIER2 = [
        {
            id: 'money-as-float', severity: 'error',
            check: function (ctx) {
                var out = [];
                var dial = ctx.dialects;
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        if (!MONEY_NAME.test(c.name)) return;
                        var fam = dial ? dial.family(c.type) : null;
                        if (fam === 'float') {
                            out.push(f(e.id, c.id, 'error', 'Money column "' + c.name + '" is ' + c.type + ' (float) \u2014 approximate arithmetic on money (' + (dial ? dial.className(c.type) : c.type) + ')'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'cyclic-fk-all-non-nullable', severity: 'error',
            check: function (ctx) {
                var out = [];
                var edgeNullable = function (r) {
                    var from = ctx.entities.find(function (e) { return e.id === r.from.entity; });
                    var col = from && r.from.column && from.columns.find(function (c) { return c.id === r.from.column; });
                    return col ? col.nullable : null;
                };
                fkCycles(ctx).forEach(function (cycle) {
                    var allNotNull = cycle.every(function (r) { return edgeNullable(r) === false; });
                    if (allNotNull) {
                        out.push(f(cycle[0].from.entity, null, 'error',
                            'FK cycle ' + cycle.map(function (r) { return r.from.entity; }).join(' \u2192 ') + ' is all NOT NULL \u2014 no row can be inserted first'));
                    }
                });
                return out;
            },
        },
        {
            id: 'repeating-group', severity: 'warning',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    var groups = {};
                    e.columns.forEach(function (c) {
                        var m = /^(.+)_([1-9]\d*)$/.exec(c.name);
                        if (!m) return;
                        if (!groups[m[1]]) groups[m[1]] = [];
                        groups[m[1]].push(c);
                    });
                    Object.keys(groups).forEach(function (stem) {
                        var cols = groups[stem];
                        if (cols.length >= 2) {
                            out.push(f(e.id, cols[0].id, 'warning',
                                'Repeating group "' + stem + '_N" on "' + e.name + '" \u2014 ' + cols.map(function (c) { return c.name; }).join(', ') + ' should be a child table (first normal form)'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'derived-column-stored', severity: 'warning',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        if (c.generated && c.generated.expr && (c.generated.sources || []).length) {
                            out.push(f(e.id, c.id, 'warning',
                                'Column "' + c.name + '" is a stored derived value (' + c.generated.expr + ') with no generated-column expression emitted \u2014 it will drift'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'natural-key-as-pk', severity: 'warning',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        if (c.pk && EMAIL_LIKE.test(c.name)) {
                            out.push(f(e.id, c.id, 'warning',
                                'Column "' + c.name + '" is the primary key of "' + e.name + '" \u2014 natural keys change, and every FK to it must change too'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'enum-as-text', severity: 'warning',
            check: function (ctx) {
                var out = [];
                if (!ctx.stats || !ctx.stats.length) return out;
                var statsByCol = {};
                ctx.stats.forEach(function (s) { statsByCol[s.columnId] = s; });
                var dial = ctx.dialects;
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        if (c.pk || !c.type || !dial || dial.family(c.type) !== 'character') return;
                        var s = statsByCol[c.id];
                        if (s && s.rows >= 50 && s.distinct != null && s.distinct <= 12) {
                            out.push(f(e.id, c.id, 'warning',
                                'Text column "' + c.name + '" has ' + s.distinct + ' distinct values over ' + s.rows + ' rows \u2014 a lookup table or enum, not free text'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'junction-missing-composite-unique', severity: 'warning',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    var fkCols = e.columns.filter(function (c) { return c.fk; });
                    if (fkCols.length < 2) return;
                    var hasComposite = e.constraints.some(function (c) {
                        return c.kind === 'unique' && fkCols.every(function (fc) { return c.columns.includes(fc.id); });
                    });
                    if (!hasComposite) {
                        out.push(f(e.id, null, 'warning',
                            'Junction "' + e.name + '" (FKs: ' + fkCols.map(function (c) { return c.name; }).join(', ') + ') has no unique constraint across the pair \u2014 duplicate edges admitted'));
                    }
                });
                return out;
            },
        },
        {
            id: 'boolean-state-triplet', severity: 'warning',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    var isActive = e.columns.some(function (c) { return BOOL_PREFIX.test(c.name) && /active|enabled/.test(c.name); });
                    var isDeleted = e.columns.some(function (c) { return c.name === 'is_deleted' || c.name === 'deleted'; });
                    var status = e.columns.some(function (c) { return c.name === 'status'; });
                    if (isActive && isDeleted && status) {
                        out.push(f(e.id, null, 'warning',
                            '"' + e.name + '" wears a state machine as three booleans (is_active + is_deleted + status) \u2014 promote to an FSM'));
                    }
                });
                return out;
            },
        },
        {
            id: 'nullable-fk-in-junction', severity: 'warning',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    var fkCols = e.columns.filter(function (c) { return c.fk; });
                    if (fkCols.length < 2) return;
                    fkCols.forEach(function (c) {
                        if (c.nullable === true) {
                            out.push(f(e.id, c.id, 'warning',
                                'Junction "' + e.name + '" has a nullable FK "' + c.name + '" \u2014 a relationship edge that may point nowhere'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'soft-delete-inconsistent', severity: 'warning',
            check: function (ctx) {
                var out = [];
                var hasSoft = function (e) { return e.columns.some(function (c) { return c.name === 'deleted_at' || c.name === 'is_deleted'; }); };
                if (!ctx.entities.some(hasSoft)) return out;
                ctx.entities.forEach(function (e) {
                    if (e.kind === 'external' || hasSoft(e)) return;
                    out.push(f(e.id, null, 'warning',
                        '"' + e.name + '" has no soft-delete column but siblings do \u2014 joins across the boundary are wrong in one direction'));
                });
                return out;
            },
        },
        {
            id: 'audit-columns-inconsistent', severity: 'info',
            check: function (ctx) {
                var out = [];
                var hasAudit = function (e) {
                    return e.columns.some(function (c) { return c.name === 'created_at'; }) &&
                        e.columns.some(function (c) { return c.name === 'updated_at'; });
                };
                if (!ctx.entities.some(hasAudit)) return out;
                ctx.entities.forEach(function (e) {
                    if (e.kind === 'external' || hasAudit(e)) return;
                    out.push(f(e.id, null, 'info', '"' + e.name + '" lacks created_at/updated_at that siblings carry'));
                });
                return out;
            },
        },
        {
            id: 'pii-untagged', severity: 'info',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        if (!PII_NAME.test(c.name)) return;
                        if (!/(pii|sensitive|classified|retention)/i.test(c.comment || '')) {
                            out.push(f(e.id, c.id, 'info',
                                'Column "' + c.name + '" holds personal data with no classification \u2014 the hook a retention policy needs'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'identity-not-pk', severity: 'info',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        if (c.identity && !c.pk) {
                            out.push(f(e.id, c.id, 'info', 'Identity column "' + c.name + '" is not the primary key'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'unique-nullable', severity: 'info',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        if (c.unique && c.nullable === true) {
                            out.push(f(e.id, c.id, 'info', 'Column "' + c.name + '" is UNIQUE but nullable \u2014 multiple NULLs are allowed in most dialects'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'timestamp-without-tz', severity: 'info',
            check: function (ctx) {
                var out = [];
                var dial = ctx.dialects;
                ctx.entities.forEach(function (e) {
                    e.columns.forEach(function (c) {
                        var base = dial ? dial.normalize(c.type).base : String(c.type).toLowerCase();
                        if (base === 'timestamp' || base === 'timestamp without time zone') {
                            out.push(f(e.id, c.id, 'info', 'Column "' + c.name + '" is ' + c.type + ' (no time zone) \u2014 consider timestamptz for cross-timezone correctness'));
                        }
                    });
                });
                return out;
            },
        },
        {
            id: 'naming-inconsistent', severity: 'info',
            check: function (ctx) {
                var out = [];
                ctx.entities.forEach(function (e) {
                    var names = e.columns.map(function (c) { return c.name; }).concat([e.name]).filter(Boolean);
                    var styles = new Set();
                    names.forEach(function (n) {
                        if (SNAKE.test(n)) styles.add('snake');
                        else if (CAMEL.test(n)) styles.add('camel');
                        else if (PASCAL.test(n)) styles.add('pascal');
                    });
                    if (styles.size >= 2) {
                        out.push(f(e.id, null, 'info', 'Naming is inconsistent in "' + e.name + '" \u2014 mixes ' + Array.from(styles).join(' + ')));
                    }
                });
                return out;
            },
        },
    ];

    /* ── Tier 3 — architecture (needs a DECLARED posture) ────── */

    var TIER3 = [
        {
            id: 'tenant-column-missing', severity: 'error',
            condition: function (ctx) { return ctx.posture && ctx.posture.tenancy === 'shared-schema' && ctx.posture.tenantKey; },
            check: function (ctx) {
                var tk = ctx.posture.tenantKey;
                return ctx.entities
                    .filter(function (e) { return e.kind !== 'external' && !e.columns.some(function (c) { return c.name === tk; }); })
                    .map(function (e) { return f(e.id, null, 'error', 'Shared-schema tenant: "' + e.name + '" has no tenant column "' + tk + '"'); });
            },
        },
        {
            id: 'unique-not-tenant-scoped', severity: 'error',
            condition: function (ctx) { return ctx.posture && ctx.posture.tenancy === 'shared-schema' && ctx.posture.tenantKey; },
            check: function (ctx) {
                var out = [];
                var tk = ctx.posture.tenantKey;
                ctx.entities.forEach(function (e) {
                    if (e.kind === 'external') return;
                    if (!e.columns.some(function (c) { return c.name === tk; })) return;
                    e.columns.forEach(function (c) {
                        if (!c.unique || c.name === tk) return;
                        out.push(f(e.id, c.id, 'error',
                            'UNIQUE(' + c.name + ') is not tenant-scoped in shared-schema \u2014 one tenant\u2019s ' + c.name + ' blocks another\u2019s'));
                    });
                    e.constraints.forEach(function (c) {
                        if (c.kind !== 'unique') return;
                        if (c.columns.length === 1 && c.columns[0] === tk) return;
                        out.push(f(e.id, null, 'error', 'UNIQUE(' + c.columns.join(', ') + ') is not tenant-scoped in shared-schema'));
                    });
                });
                return out;
            },
        },
        {
            id: 'fk-crosses-tenant', severity: 'error',
            condition: function (ctx) { return ctx.posture && ctx.posture.tenancy === 'shared-schema' && ctx.posture.tenantKey; },
            check: function (ctx) {
                var out = [];
                var tk = ctx.posture.tenantKey;
                ctx.relations.forEach(function (r) {
                    if (r.kind !== 'fk') return;
                    var from = ctx.entities.find(function (e) { return e.id === r.from.entity; });
                    var to = ctx.entities.find(function (e) { return e.id === r.to.entity; });
                    if (!from || !to) return;
                    var fromTenant = from.columns.some(function (c) { return c.name === tk; });
                    var toTenant = to.columns.some(function (c) { return c.name === tk; });
                    if (!fromTenant || !toTenant) return;
                    var fc = from.columns.find(function (c) { return c.id === r.from.column; });
                    var tc = to.columns.find(function (c) { return c.id === r.to.column; });
                    var fromIsTenant = fc && fc.name === tk;
                    var toIsTenant = tc && tc.name === tk;
                    if (!fromIsTenant && !toIsTenant) {
                        out.push(f(from.id, r.from.column, 'error',
                            'FK ' + r.id + ' crosses tenants: ' + from.name + '.' + (fc ? fc.name : '?') + ' \u2192 ' + to.name + '.' + (tc ? tc.name : '?') + ' without the tenant key'));
                    }
                });
                return out;
            },
        },
        {
            id: 'fk-crosses-shard', severity: 'error',
            condition: function (ctx) { return ctx.posture && ctx.posture.deployment === 'sharded' && ctx.posture.shardKey; },
            check: function (ctx) {
                var out = [];
                var sk = ctx.posture.shardKey;
                ctx.relations.forEach(function (r) {
                    if (r.kind !== 'fk') return;
                    var from = ctx.entities.find(function (e) { return e.id === r.from.entity; });
                    var to = ctx.entities.find(function (e) { return e.id === r.to.entity; });
                    if (!from || !to) return;
                    var fromSk = from.columns.find(function (c) { return c.name === sk; });
                    var toSk = to.columns.find(function (c) { return c.name === sk; });
                    if (fromSk && toSk && fromSk.id !== toSk.id) {
                        out.push(f(from.id, r.from.column, 'error',
                            'FK ' + r.id + ' crosses shards: ' + from.name + ' and ' + to.name + ' shard on different columns'));
                    } else if (fromSk && !toSk) {
                        out.push(f(from.id, r.from.column, 'error',
                            'FK ' + r.id + ': ' + to.name + ' has no shard key \u2014 the database cannot enforce the FK across machines'));
                    }
                });
                return out;
            },
        },
        {
            id: 'shard-key-missing', severity: 'error',
            condition: function (ctx) { return ctx.posture && ctx.posture.deployment === 'sharded' && ctx.posture.shardKey; },
            check: function (ctx) {
                var sk = ctx.posture.shardKey;
                return ctx.entities
                    .filter(function (e) { return e.kind !== 'external' && !e.columns.some(function (c) { return c.name === sk; }); })
                    .map(function (e) { return f(e.id, null, 'error', 'Sharded: "' + e.name + '" has no shard key "' + sk + '"'); });
            },
        },
        {
            id: 'cross-shard-join-implied', severity: 'warning',
            condition: function (ctx) { return ctx.posture && ctx.posture.deployment === 'sharded' && ctx.posture.shardKey; },
            check: function (ctx) {
                var out = [];
                var sk = ctx.posture.shardKey;
                ctx.relations.forEach(function (r) {
                    if (r.kind !== 'fk') return;
                    var from = ctx.entities.find(function (e) { return e.id === r.from.entity; });
                    var to = ctx.entities.find(function (e) { return e.id === r.to.entity; });
                    if (!from || !to) return;
                    var fromSk = from.columns.find(function (c) { return c.name === sk; });
                    var toSk = to.columns.find(function (c) { return c.name === sk; });
                    if (fromSk && toSk && fromSk.id !== toSk.id) {
                        out.push(f(from.id, null, 'warning',
                            'FK ' + r.id + ' implies a join across shards (' + from.name + '.' + sk + ' \u2260 ' + to.name + '.' + sk + ')'));
                    }
                });
                return out;
            },
        },
        {
            id: 'fk-crosses-service-boundary', severity: 'error',
            condition: function (ctx) {
                return ctx.posture && ctx.posture.deployment === 'tiered' && ctx.posture.boundaries && ctx.posture.boundaries.length;
            },
            check: function (ctx) {
                var out = [];
                var bd = ctx.posture.boundaries || [];
                var homeOf = function (entityId) { return bd.find(function (b) { return (b.entities || []).includes(entityId); }); };
                ctx.relations.forEach(function (r) {
                    if (r.kind !== 'fk') return;
                    var a = homeOf(r.from.entity);
                    var b = homeOf(r.to.entity);
                    if (a && b && a.name !== b.name) {
                        out.push(f(r.from.entity, null, 'error',
                            'FK ' + r.id + ' crosses service boundary "' + a.name + '" \u2192 "' + b.name + '" \u2014 a hard FK where the architecture requires a soft reference'));
                    }
                });
                return out;
            },
        },
        {
            id: 'entity-in-two-boundaries', severity: 'error',
            condition: function (ctx) { return ctx.posture && ctx.posture.boundaries && ctx.posture.boundaries.length; },
            check: function (ctx) {
                var out = [];
                var bd = ctx.posture.boundaries || [];
                var owners = {};
                bd.forEach(function (b) {
                    (b.entities || []).forEach(function (e) {
                        if (!owners[e]) owners[e] = [];
                        owners[e].push(b.name || 'unnamed');
                    });
                });
                Object.keys(owners).forEach(function (eid) {
                    if (owners[eid].length > 1) {
                        out.push(f(eid, null, 'error', 'Entity owned by ' + owners[eid].length + ' boundaries (' + owners[eid].join(', ') + ')'));
                    }
                });
                return out;
            },
        },
        {
            id: 'boundary-has-no-owner', severity: 'warning',
            condition: function (ctx) { return ctx.posture && ctx.posture.boundaries && ctx.posture.boundaries.length; },
            check: function (ctx) {
                return (ctx.posture.boundaries || [])
                    .filter(function (b) { return !b.name || !String(b.name).trim(); })
                    .map(function (b) { return f(null, null, 'warning', 'A service boundary has no owner name'); });
            },
        },
        {
            id: 'read-after-write-on-replica', severity: 'info',
            condition: function (ctx) { return ctx.posture && ctx.posture.deployment === 'replicated'; },
            check: function (ctx) {
                var out = [];
                if (ctx.posture.consistency === 'strong') {
                    out.push(f(null, null, 'info', 'Strong consistency on a replicated deployment means reads must round-trip the primary'));
                }
                return out;
            },
        },
        {
            id: 'cross-boundary-transaction-implied', severity: 'warning',
            condition: function (ctx) { return ctx.posture && ctx.posture.consistency === 'eventual'; },
            check: function (ctx) {
                var out = [];
                var bd = ctx.posture.boundaries || [];
                if (!bd.length) return out;
                var homeOf = function (entityId) { return bd.find(function (b) { return (b.entities || []).includes(entityId); }); };
                var rels = ctx.relations.filter(function (r) { return r.kind === 'fk'; });
                rels.forEach(function (ra) {
                    var a = homeOf(ra.from.entity);
                    var b = homeOf(ra.to.entity);
                    if (!a || !b || a.name === b.name) return;
                    var reverse = rels.some(function (rb) { return rb.from.entity === ra.to.entity && rb.to.entity === ra.from.entity; });
                    if (reverse) {
                        out.push(f(ra.from.entity, null, 'warning',
                            'Mutual non-nullable FK between "' + a.name + '" and "' + b.name + '" implies a transaction across an eventually-consistent boundary'));
                    }
                });
                return out;
            },
        },
    ];

    /* ── FSM pack ────────────────────────────────────────────── */
    /* No states → coverage.fsm null, fires nothing — the busCoverage rule. */

    var FSM_RULES = [
        {
            id: 'no-initial-state', severity: 'error',
            check: function (ctx) {
                if (!ctx.states || !ctx.states.length) return [];
                if (!ctx.states.some(function (s) { return s.kind === 'initial'; })) {
                    return [f(null, null, 'error', 'State machine has no initial state')];
                }
                return [];
            },
        },
        {
            id: 'multiple-initial-states', severity: 'error',
            check: function (ctx) {
                var initials = (ctx.states || []).filter(function (s) { return s.kind === 'initial'; });
                if (initials.length > 1) {
                    return [f(null, null, 'error',
                        initials.length + ' initial states (' + initials.map(function (s) { return s.name; }).join(', ') + ') \u2014 a machine starts in one place')];
                }
                return [];
            },
        },
        {
            id: 'unreachable-state', severity: 'error',
            check: function (ctx) {
                var states = ctx.states || [];
                if (!states.length) return [];
                var start = states.find(function (s) { return s.kind === 'initial'; });
                if (!start) return [];
                var reachable = new Set([start.id]);
                var changed = true;
                while (changed) {
                    changed = false;
                    (ctx.transitions || []).forEach(function (t) {
                        if (reachable.has(t.from) && !reachable.has(t.to)) { reachable.add(t.to); changed = true; }
                    });
                }
                return states
                    .filter(function (s) { return !reachable.has(s.id); })
                    .map(function (s) { return f(null, null, 'error', 'State "' + s.name + '" is unreachable from the initial state'); });
            },
        },
        {
            id: 'dead-end-state', severity: 'warning',
            check: function (ctx) {
                var states = ctx.states || [];
                if (!states.length) return [];
                var hasOut = new Set((ctx.transitions || []).map(function (t) { return t.from; }));
                return states
                    .filter(function (s) { return s.kind !== 'final' && !hasOut.has(s.id); })
                    .map(function (s) { return f(null, null, 'warning', 'State "' + s.name + '" has no outgoing transition and is not final'); });
            },
        },
        {
            id: 'transition-missing-event', severity: 'warning',
            check: function (ctx) {
                return (ctx.transitions || [])
                    .filter(function (t) { return !t.event; })
                    .map(function (t) { return f(null, null, 'warning', 'Transition ' + t.from + ' \u2192 ' + t.to + ' has no event \u2014 it will fire unconditionally'); });
            },
        },
        {
            id: 'guard-without-fallback', severity: 'warning',
            check: function (ctx) {
                var out = [];
                (ctx.states || []).forEach(function (s) {
                    var outs = (ctx.transitions || []).filter(function (t) { return t.from === s.id; });
                    var guarded = outs.filter(function (t) { return t.guard; });
                    var unguarded = outs.filter(function (t) { return !t.guard; });
                    if (guarded.length && !unguarded.length) {
                        out.push(f(null, null, 'warning',
                            'State "' + s.name + '" has ' + guarded.length + ' guarded transition(s) and no unguarded fallback \u2014 a guard that is never true stalls the machine'));
                    }
                });
                return out;
            },
        },
        {
            id: 'nondeterministic-transition', severity: 'error',
            check: function (ctx) {
                var out = [];
                var keys = {};
                (ctx.transitions || []).forEach(function (t) {
                    if (t.guard) return;
                    var key = t.from + '|' + t.event;
                    if (!keys[key]) keys[key] = [];
                    keys[key].push(t);
                });
                Object.keys(keys).forEach(function (key) {
                    var ts = keys[key];
                    if (ts.length > 1) {
                        out.push(f(null, null, 'error',
                            'State ' + ts[0].from + ' on event "' + ts[0].event + '" has ' + ts.length + ' unguarded targets (' + ts.map(function (t) { return t.to; }).join(', ') + ')'));
                    }
                });
                return out;
            },
        },
    ];

    /* ── rule pack runner (the ercEngine contract) ───────────── */

    function _runRulePack(rules, ctx, findings) {
        (rules || []).forEach(function (rule) {
            try {
                if (rule.condition && !rule.condition(ctx)) return;
                rule.check.call(this, ctx).forEach(function (fnd) {
                    findings.push(Object.assign({}, fnd, {
                        ruleId: rule.id,
                        severity: fnd.severity || rule.severity,
                    }));
                });
            } catch (_) { /* one broken rule must not kill the run */ }
        });
    }

    /* ── coverage — computed here, never accepted from a caller ─ */

    function _coverage(ctx) {
        var structural = {
            entities: ctx.entities.length,
            columns: ctx.entities.reduce(function (n, e) { return n + e.columns.length; }, 0),
            fkCandidates: ctx.entities.reduce(function (n, e) { return n + e.columns.filter(function (c) { return PK_NAME.test(c.name); }).length; }, 0),
            fkResolved: ctx.relations.filter(function (r) { return r.kind === 'fk'; }).length,
        };
        var semantic = (ctx.stats && ctx.stats.length) ? {
            columnsWithStats: ctx.stats.length,
            columnsTyped: ctx.entities.reduce(function (n, e) { return n + e.columns.filter(function (c) { return c.type; }).length; }, 0),
            detectorsMatched: 0,
        } : null;
        var posture = ctx.posture ? {
            declared: true,
            entitiesInBoundaries: (ctx.posture.boundaries || []).reduce(function (n, b) { return n + (b.entities || []).length; }, 0),
            entitiesTotal: ctx.entities.length,
        } : null;
        var fsm = (ctx.states && ctx.states.length) ? {
            states: ctx.states.length,
            statesWithEvents: new Set((ctx.transitions || []).map(function (t) { return t.from; })).size,
        } : null;
        return { structural: structural, semantic: semantic, posture: posture, fsm: fsm };
    }

    function _buildCtx(model) {
        var entities = model.entities || [];
        return {
            entities: entities,
            columns: entities.reduce(function (a, e) { return a.concat(e.columns); }, []),
            relations: model.relations || [],
            constraints: entities.reduce(function (a, e) { return a.concat(e.constraints); }, []),
            states: model.states || [],
            transitions: model.transitions || [],
            stats: model.stats || [],
            dialects: null,
            posture: model.posture || null,
        };
    }

    /** Full SRC run over a GxSchema model. `dialects` (GxTypeDialects) is
        injected — without it the type-sensitive rules skip rather than guess. */
    function runSrcStructured(model, dialects) {
        var ctx = _buildCtx(model);
        ctx.dialects = dialects || null;
        var findings = [];
        _runRulePack(TIER1, ctx, findings);
        _runRulePack(TIER2, ctx, findings);
        _runRulePack(TIER3, ctx, findings);
        _runRulePack(FSM_RULES, ctx, findings);
        var errors = findings.filter(function (fnd) { return fnd.severity === 'error'; }).length;
        var warnings = findings.filter(function (fnd) { return fnd.severity === 'warning'; }).length;
        return {
            findings: findings,
            errorCount: errors,
            warningCount: warnings,
            total: findings.length,
            coverage: _coverage(ctx),
        };
    }

    /* ── toolkit surface ─────────────────────────────────────── */

    G.GxSrcEngine = {
        SCHEMA: 'gx-schema/1',
        runSrcStructured: runSrcStructured,
        _runRulePack: _runRulePack,
        _coverage: _coverage,
        TIER1: TIER1,
        TIER2: TIER2,
        TIER3: TIER3,
        FSM_RULES: FSM_RULES,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = G.GxSrcEngine;
})();