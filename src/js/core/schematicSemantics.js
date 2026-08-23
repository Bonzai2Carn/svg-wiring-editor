/* ============================================================
   ginexys-schema-engine — Schematic Semantics  (Phase 5)
   @public-api  Prototype mixin on MobileSVGEditor.

   Phases 1-4 (geometryEngine.js) answer "what shapes are here and
   what touches what". That is topology. It is not yet a schematic:
   a netlist needs NAMES, and names live in the text layer.

   This phase joins the two.

     5a. Layer roles   — which stroke colours are nets vs symbols
     5b. Symbols       — cluster symbol-layer geometry into parts
     5c. Designators   — attach R1 / C7 / IC3 to the part it sits on
     5d. Net names     — attach GND / +5V / RESET to the run they label
     5e. Netlist       — components x nets, with connections

   OUTPUT: this.netlist = {
     components: [{ ref, value, part, bbox, pins, elements }],
     nets:       [{ id, name, source, wireCount, refs: [ref, ...] }],
     unnamed:    { components, nets },
   }
   ============================================================ */

(function () {

// ── Label vocabulary ─────────────────────────────────────────────────────────
//
// Designator prefixes are a real, small, standardised set (IEEE 315 / IEC
// 81346). That matters: without it "A0" and "ADC12" and "PA7" all look exactly
// like designators to a `letters-then-digits` regex, and an Arduino sheet has
// far more pin names than parts. Matching against the alphabet is what makes
// the difference between naming 60 components and naming 167 things that are
// mostly pins.
//
// Longest-first, so RN3 matches RN and not R.
const DESIGNATOR_PREFIXES = [
    'LED', 'ZD', 'RN', 'FB', 'JP', 'SW', 'TP', 'BT', 'VR', 'IC', 'DS',
    'B', 'C', 'D', 'F', 'G', 'J', 'K', 'L', 'M', 'P', 'Q', 'R', 'S', 'T',
    'U', 'V', 'X', 'Y', 'Z',
];
const DESIGNATOR_RE = new RegExp(
    '^(' + DESIGNATOR_PREFIXES.join('|') + ')(\\d{1,4})([A-Z])?$');

// Power and ground names are the one class of net name worth knowing by sight:
// they appear dozens of times across a sheet and they are what a reader looks
// for first.
const POWER_RE = /^(?:[+-]?\d{1,2}V\d?|GND|[ADP]GND|V(?:CC|DD|SS|IN|BUS|REF)|A(?:VCC|REF|GND)|USB(?:VCC|_?5V)|\+?\d?V\d)$/i;

// A component value: a magnitude, an optional SI prefix, an optional unit.
const VALUE_RE = /^\d+(?:[.,]\d+)?\s*(?:[kKMmuµnpR])?\s*(?:[FHR]|Ω|ohm|Hz)?$/;

// A manufacturer part: mixed letters and digits, no spaces, and either long
// enough or carrying a separator. The extra condition is what keeps pin names
// out: XTAL1 and ADC15 are five or six characters of letters-then-digits and
// otherwise look exactly like a part number, while PMV48XP and CD1206-S01575
// do not.
const PART_RE = /^(?=.*[A-Za-z])(?=.*\d)(?:[A-Za-z0-9][A-Za-z0-9_./+-]{6,}|[A-Za-z0-9][A-Za-z0-9]*[_./-][A-Za-z0-9_./-]+)$/;

const PIN_NUMBER_RE = /^\d{1,3}$/;

function classifyLabel(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (DESIGNATOR_RE.test(s)) return 'designator';
    if (POWER_RE.test(s))      return 'power';
    if (PIN_NUMBER_RE.test(s)) return 'pinNumber';
    if (VALUE_RE.test(s))      return 'value';
    if (PART_RE.test(s))       return 'part';
    // Anything short and token-shaped is a candidate net name. Prose is not:
    // a title block disclaimer must never end up naming a net.
    if (s.length <= 16 && !/\s/.test(s)) return 'netName';
    return 'text';
}

// ── Small geometry helpers ───────────────────────────────────────────────────
const _cx = (b) => b.x + b.width / 2;
const _cy = (b) => b.y + b.height / 2;

/** Distance from a point to a box; 0 when inside. */
function pointBoxDistance(px, py, b) {
    const dx = Math.max(b.x - px, 0, px - (b.x + b.width));
    const dy = Math.max(b.y - py, 0, py - (b.y + b.height));
    return Math.hypot(dx, dy);
}

/** Shortest distance from a point to a segment. */
function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    if (!len2) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * vx + (py - ay) * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function boxesNear(a, b, gap) {
    return a.x - gap <= b.x + b.width  && b.x - gap <= a.x + a.width &&
           a.y - gap <= b.y + b.height && b.y - gap <= a.y + a.height;
}

function makeUnionFind() {
    const parent = new Map();
    const find = (k) => {
        if (!parent.has(k)) parent.set(k, k);
        while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); }
        return k;
    };
    return {
        find,
        union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); },
        groups() {
            const g = new Map();
            for (const k of parent.keys()) {
                const r = find(k);
                if (!g.has(r)) g.set(r, []);
                g.get(r).push(k);
            }
            return g;
        },
    };
}

Object.assign(MobileSVGEditor.prototype, {

    /**
     * PHASE 5 — turn topology into a named netlist.
     * Safe to call on any analysed document; returns null when there is
     * nothing nameable, which is the honest answer for a plain drawing.
     */
    _buildSchematicSemantics() {
        const labels = this._harvestLabels();
        const layers = this._classifyStrokeLayers();

        // No text means no names. Say so rather than inventing part numbers
        // from geometry, which is what "auto-designation" would amount to.
        if (!labels.length) {
            this.netlist = null;
            this._semanticsNote = 'no text layer: nothing to name';
            return null;
        }

        const symbols = this._clusterSymbols(layers);
        this._nameSymbols(symbols, labels);

        const nets = this._buildNamedNets(layers, labels, symbols);

        const named = symbols.filter(s => s.ref);

        // No named parts means this is not a schematic. A text-bearing PDF will
        // always yield a stray token that sits near a line, so without this gate
        // a 23-page paper reports a netlist of one net and no components, which
        // is a confident answer to a question nobody asked.
        if (!named.length) {
            this.netlist = null;
            this._semanticsNote = 'no component designators found: not a schematic';
            return null;
        }

        this.netlist = {
            components: named.map(s => ({
                ref: s.ref, value: s.value || null, part: s.part || null,
                bbox: s.bbox, elementCount: s.elements.length,
            })).sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true })),
            nets: nets
                .filter(n => n.name)
                .map(n => ({ id: n.id, name: n.name, source: n.source,
                             wireCount: n.wireIds.length, segments: n.segments || 1,
                             refs: [...n.refs].sort() }))
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
            // Reported as evidence, not as a score. `symbols.length - named.length`
            // was the obvious statistic and it was misleading: most clusters are
            // junction dots and pin stubs, so it read as "115 components we
            // failed to name" when the document contains only 36 designators in
            // total. What a reader needs to know is how much of the naming
            // evidence was actually consumed.
            coverage: {
                designatorsInDocument: labels.filter(l => l.kind === 'designator').length,
                designatorsResolved: named.length,
                unresolvedDesignators: labels
                    .filter(l => l.kind === 'designator' && !l.usedBy)
                    .map(l => l.text),
                symbolClusters: symbols.length,
                unnamedNets: nets.filter(n => !n.name).length,
            },
            layers: layers.summary,
        };
        this._symbols = symbols;
        this._stampSemantics(symbols);
        return this.netlist;
    },

    // ── 5a. Which stroke colours carry nets? ─────────────────────────────────
    /**
     * Separate net geometry from symbol geometry WITHOUT hardcoding a palette.
     *
     * In every CAD schematic export the two live on different layers and come
     * out in different colours, but which colour means what is a per-tool, and
     * frequently per-user, setting. What is invariant is the SHAPE of the two
     * populations:
     *
     *   a net connects things that are far apart, so its segments chain into
     *   runs that span the sheet;
     *   a symbol outline stays inside its own symbol, so its segments chain
     *   into runs a few millimetres across.
     *
     * Measured on an Arduino MEGA2560 sheet: the net colour's connected runs
     * have a median diameter of 57.6pt, the symbol colour's 8.0pt, the frame
     * colour's 3.7pt. That gap is not marginal and it is not colour-specific.
     */
    _classifyStrokeLayers() {
        const wires = this.wires || [];
        const byColor = new Map();
        wires.forEach(w => {
            const c = w.color || 'unknown';
            if (!byColor.has(c)) byColor.set(c, []);
            byColor.get(c).push(w);
        });

        const page = this._pageViewBox?.()?.split(/[\s,]+/).map(Number);
        const pageSpan = (page && page.length === 4)
            ? Math.hypot(page[2], page[3]) : 1000;
        // A run has to cross a meaningful part of the sheet to read as a net.
        // 2% of the diagonal is about 28pt on A3, comfortably above symbol
        // outlines (8pt) and comfortably below real nets (58pt).
        const NET_SPAN = pageSpan * 0.02;

        const summary = [];
        const netWires = [], symbolWires = [];
        byColor.forEach((ws, color) => {
            const uf = makeUnionFind();
            const key = (p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
            ws.forEach(w => uf.union(key(w.endpoints[0]), key(w.endpoints[1])));
            const diams = [];
            uf.groups().forEach(keys => {
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                keys.forEach(k => {
                    const [x, y] = k.split(',').map(Number);
                    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
                    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
                });
                diams.push(Math.hypot(x1 - x0, y1 - y0));
            });
            diams.sort((a, b) => a - b);
            const median = diams.length ? diams[diams.length >> 1] : 0;
            const isNet = median >= NET_SPAN;
            summary.push({ color, segments: ws.length, medianRun: +median.toFixed(1), role: isNet ? 'net' : 'symbol' });
            (isNet ? netWires : symbolWires).push(...ws);
        });

        // A single-colour export (mono print) gives no separation to find. Then
        // every stroke is a net candidate — worse naming, but honest, and it
        // beats declaring the whole sheet to be symbol outlines.
        if (!netWires.length && symbolWires.length) {
            summary.forEach(s => { s.role = 'net (no colour separation)'; });
            return { netWires: symbolWires.slice(), symbolWires: [], summary, separated: false };
        }
        return { netWires, symbolWires, summary, separated: true };
    },

    // ── 5b. Group loose geometry into parts ──────────────────────────────────
    /**
     * A symbol is a spatial cluster of symbol-layer geometry.
     *
     * EAGLE draws a symbol body as four independent stroked segments, so there
     * is no element in the file that IS the resistor — only the four sides of
     * its box, its two pin stubs and its filled pin dots. Clustering by
     * proximity is what reassembles them into the thing a person would point
     * at and call R1.
     */
    _clusterSymbols(layers) {
        const parts = [];
        const page = this._pageViewBox?.()?.split(/[\s,]+/).map(Number);
        const pw = (page && page[2]) || 1200, ph = (page && page[3]) || 800;
        // The sheet frame and its title-block ruling are geometry too, and they
        // would otherwise cluster into one symbol containing the whole drawing.
        //
        // EITHER dimension, not both. A frame is four straight segments, so each
        // one is 1167x0 — full width and zero height. Requiring both to be large
        // let every frame line through, and because a frame line runs the length
        // of the sheet it chained every part it passed within 2.5pt of into one
        // blob that then claimed a share of every net on the page.
        const isFrame = (b) => b.width > pw * 0.6 || b.height > ph * 0.6;

        (layers.symbolWires || []).forEach((w, i) => {
            if (w.bbox && !isFrame(w.bbox)) parts.push({ key: `sw${i}`, bbox: w.bbox, el: w.element || w.el });
        });
        (this.components || []).forEach((c, i) => {
            if (c.bbox && !isFrame(c.bbox)) parts.push({ key: `c${i}`, bbox: c.bbox, el: c.element || c.el });
        });
        if (!parts.length) return [];

        // Proximity clustering. The gap is deliberately small: a symbol's own
        // strokes touch, while two neighbouring parts on a schematic are
        // separated by the wire between them.
        const GAP = 2.5;
        const uf = makeUnionFind();
        parts.forEach(p => uf.find(p.key));
        // Bucket by grid cell so this stays near-linear instead of comparing
        // every part against every other one.
        const CELL = 24;
        const grid = new Map();
        parts.forEach(p => {
            const gx0 = Math.floor((p.bbox.x - GAP) / CELL), gx1 = Math.floor((p.bbox.x + p.bbox.width + GAP) / CELL);
            const gy0 = Math.floor((p.bbox.y - GAP) / CELL), gy1 = Math.floor((p.bbox.y + p.bbox.height + GAP) / CELL);
            for (let gx = gx0; gx <= gx1; gx++) {
                for (let gy = gy0; gy <= gy1; gy++) {
                    const k = `${gx}:${gy}`;
                    if (!grid.has(k)) grid.set(k, []);
                    grid.get(k).push(p);
                }
            }
        });
        grid.forEach(bucket => {
            for (let i = 0; i < bucket.length; i++) {
                for (let j = i + 1; j < bucket.length; j++) {
                    if (boxesNear(bucket[i].bbox, bucket[j].bbox, GAP)) uf.union(bucket[i].key, bucket[j].key);
                }
            }
        });

        const byKey = new Map(parts.map(p => [p.key, p]));
        const symbols = [];
        uf.groups().forEach((keys, root) => {
            const members = keys.map(k => byKey.get(k)).filter(Boolean);
            if (!members.length) return;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            members.forEach(m => {
                x0 = Math.min(x0, m.bbox.x); y0 = Math.min(y0, m.bbox.y);
                x1 = Math.max(x1, m.bbox.x + m.bbox.width); y1 = Math.max(y1, m.bbox.y + m.bbox.height);
            });
            const bbox = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            // A cluster spanning most of the sheet is a clustering failure, not
            // a part. The bound is deliberately generous: a large microcontroller
            // body legitimately covers half the sheet height, and an earlier
            // third-of-the-page cap silently dropped the ATmega2560 — the one
            // part on the board a reader would look for first.
            if (bbox.width > pw * 0.6 || bbox.height > ph * 0.75) return;
            symbols.push({
                id: `sym_${symbols.length}`, root, bbox,
                elements: members.map(m => m.el).filter(Boolean),
                ref: null, value: null, part: null,
            });
        });
        return symbols;
    },

    // ── 5c. Attach designators, values and part numbers ──────────────────────
    /**
     * Assignment is global and greedy by distance, not per-symbol nearest.
     *
     * Per-symbol nearest is the obvious loop and it double-books: two parts
     * sitting side by side both claim the one designator between them, and the
     * second part ends up with a name that belongs to its neighbour. Sorting
     * every (label, symbol) pair by distance and consuming both sides as they
     * match gives each label exactly one owner.
     */
    _nameSymbols(symbols, labels) {
        if (!symbols.length) return;
        const page = this._pageViewBox?.()?.split(/[\s,]+/).map(Number);
        const pageSpan = (page && page.length === 4) ? Math.hypot(page[2], page[3]) : 1000;
        const MAX_DIST = pageSpan * 0.02;   // a designator sits ON its symbol

        const assign = (kind, field) => {
            const pool = labels.filter(l => l.kind === kind && !l.usedBy);
            const pairs = [];
            pool.forEach(l => {
                symbols.forEach(s => {
                    if (s[field]) return;
                    const d = pointBoxDistance(l.cx, l.cy, s.bbox);
                    if (d <= MAX_DIST) pairs.push({ d, l, s });
                });
            });
            pairs.sort((a, b) => a.d - b.d);
            for (const { l, s } of pairs) {
                if (l.usedBy || s[field]) continue;
                s[field] = l.text;
                l.usedBy = s.id;
            }
        };

        // Designator first: it is the identity, and a symbol with no designator
        // should not be given a value that belongs to the part next to it.
        assign('designator', 'ref');
        const withRef = symbols.filter(s => s.ref);
        const hidden = symbols.filter(s => !s.ref);
        hidden.forEach(s => { s._skip = true; });
        // Values and parts only attach to something already identified.
        const restore = hidden.map(s => s.bbox);
        hidden.forEach(s => { s.bbox = { x: -1e9, y: -1e9, width: 0, height: 0 }; });
        assign('value', 'value');
        assign('part', 'part');
        hidden.forEach((s, i) => { s.bbox = restore[i]; delete s._skip; });
        return withRef.length;
    },

    // ── 5d. Nets, named from the labels sitting on them ──────────────────────
    /**
     * Nets are rebuilt here over NET-LAYER wires only.
     *
     * graph.nets (phase 4) unions every wire in the document, symbol outlines
     * included, so two unrelated parts whose bodies happen to touch the same
     * stroke land on one "net". That is the right answer for hover
     * highlighting, which is what it feeds, and the wrong answer for a netlist.
     */
    _buildNamedNets(layers, labels, symbols) {
        const wires = layers.netWires || [];
        if (!wires.length) return [];
        const uf = makeUnionFind();
        const key = (p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
        wires.forEach(w => uf.union(key(w.endpoints[0]), key(w.endpoints[1])));

        const nets = new Map();
        wires.forEach(w => {
            const root = uf.find(key(w.endpoints[0]));
            if (!nets.has(root)) {
                nets.set(root, { id: `n_${nets.size}`, wireIds: [], wires: [],
                                 refs: new Set(), name: null, source: null });
            }
            const n = nets.get(root);
            n.wireIds.push(w.id); n.wires.push(w);
        });

        // Name each net from the nearest label that sits on one of its wires.
        // Power names outrank ordinary net names: a rail crossing a sheet is
        // labelled at every stub, so it wins on evidence as well as on rank.
        const page = this._pageViewBox?.()?.split(/[\s,]+/).map(Number);
        const pageSpan = (page && page.length === 4) ? Math.hypot(page[2], page[3]) : 1000;
        const MAX_DIST = pageSpan * 0.012;
        const RANK = { power: 0, netName: 1, part: 2 };

        const candidates = labels.filter(l => !l.usedBy && RANK[l.kind] !== undefined);
        const pairs = [];
        candidates.forEach(l => {
            nets.forEach(n => {
                let best = Infinity;
                for (const w of n.wires) {
                    const d = pointSegmentDistance(l.cx, l.cy,
                        w.endpoints[0].x, w.endpoints[0].y, w.endpoints[1].x, w.endpoints[1].y);
                    if (d < best) best = d;
                    if (best === 0) break;
                }
                if (best <= MAX_DIST) pairs.push({ d: best, rank: RANK[l.kind], l, n });
            });
        });
        pairs.sort((a, b) => a.rank - b.rank || a.d - b.d);
        for (const { l, n } of pairs) {
            if (n.name) continue;
            n.name = l.text;
            n.source = l.kind;
            // A power label is reused at every stub of the same rail, so it is
            // deliberately NOT consumed. A one-off net name is.
            if (l.kind !== 'power') l.usedBy = n.id;
        }

        // Which parts does each net reach?
        const TOL = 4;
        const named = symbols.filter(s => s.ref);
        nets.forEach(n => {
            n.wires.forEach(w => {
                w.endpoints.forEach(ep => {
                    named.forEach(s => {
                        if (pointBoxDistance(ep.x, ep.y, s.bbox) <= TOL) n.refs.add(s.ref);
                    });
                });
            });
        });

        return this._mergeNetsByName([...nets.values()]);
    },

    /**
     * Two runs carrying the same label ARE one net.
     *
     * This is the defining rule of a schematic and it has no geometric
     * equivalent: a designer writes GND on eight stubs precisely so they do not
     * have to draw a wire between them, and +5V crosses a sheet without a single
     * continuous conductor anywhere on it. Geometry alone therefore reports the
     * most important nets on the board as the most fragmented — our first run
     * found +5V eight separate times and +3V3 four.
     *
     * Merging by name is what turns "165 named runs" into a netlist, because it
     * is the step that recovers connections the drawing deliberately omitted.
     */
    _mergeNetsByName(nets) {
        const byName = new Map();
        const out = [];
        nets.forEach(n => {
            if (!n.name) { out.push(n); return; }
            const existing = byName.get(n.name);
            if (!existing) {
                byName.set(n.name, n);
                out.push(n);
                return;
            }
            existing.wireIds.push(...n.wireIds);
            existing.wires.push(...n.wires);
            n.refs.forEach(r => existing.refs.add(r));
            // Kept so a reader can see the rail was assembled from separate
            // drawn runs rather than traced as one conductor.
            existing.segments = (existing.segments || 1) + 1;
        });
        return out;
    },

    // ── Label harvesting ─────────────────────────────────────────────────────
    _harvestLabels() {
        const svg = this.$svgDisplay?.[0];
        if (!svg) return [];
        const out = [];
        svg.querySelectorAll('[data-gx-label]').forEach(el => {
            const text = (el.getAttribute('data-gx-label') || '').trim();
            const kind = classifyLabel(text);
            if (!kind || kind === 'text') return;
            let b;
            try { b = el.getBBox(); } catch (_) { return; }
            if (!b || (!b.width && !b.height)) return;
            // getBBox is local; the text carries its own matrix, so the anchor
            // has to be projected or every label reports as sitting at the page
            // origin and the nearest-symbol search becomes a lottery.
            const m = this._elWorldMatrix ? this._elWorldMatrix(el) : null;
            let cx = _cx(b), cy = _cy(b);
            if (m) {
                const p = new DOMPoint(cx, cy).matrixTransform(m);
                cx = p.x; cy = p.y;
            }
            out.push({ text, kind, cx, cy, el, usedBy: null });
        });
        return out;
    },

    /** Write the names back onto the DOM so panels and exports can read them. */
    _stampSemantics(symbols) {
        symbols.forEach(s => {
            if (!s.ref) return;
            s.elements.forEach(el => {
                if (!el || !el.setAttribute) return;
                el.setAttribute('data-gx-ref', s.ref);
                if (s.value) el.setAttribute('data-gx-value', s.value);
                if (s.part)  el.setAttribute('data-gx-part', s.part);
            });
        });
    },
});

// Exposed for tests and for tools that want the vocabulary without the editor.
window.GxSchematicVocab = { classifyLabel, DESIGNATOR_RE, POWER_RE, VALUE_RE, PART_RE };

})();

/* ── Export ──────────────────────────────────────────────────────────────── */
Object.assign(MobileSVGEditor.prototype, {

    /**
     * Write the netlist out as JSON plus a human-readable summary.
     *
     * The summary is not decoration. A netlist is a claim about a circuit, and
     * a reader needs to see how much of it rests on evidence before trusting
     * it — which designators were found, which were not, and how the net and
     * symbol layers were told apart. A file that reports only its successes
     * cannot be checked.
     */
    exportNetlist() {
        const n = this.netlist;
        if (!n) {
            this.showToast(this._semanticsNote
                ? `No netlist: ${this._semanticsNote}`
                : 'No netlist: run analysis on a schematic first', 'error');
            return;
        }
        const d = this.displays?.[this.activeDisplayIdx];
        const base = (d?.name || 'schematic').replace(/\.[^.]+$/, '');

        const payload = {
            schema: 'gx-netlist/1',
            source: d?.name || null,
            generated: new Date().toISOString(),
            components: n.components,
            nets: n.nets,
            coverage: n.coverage,
            strokeLayers: n.layers,
        };
        this._triggerDownload(JSON.stringify(payload, null, 2),
            `${base}__netlist.json`, 'application/json');

        this.showToast(
            `Netlist: ${n.components.length} parts, ${n.nets.length} nets ` +
            `(${n.coverage.designatorsResolved}/${n.coverage.designatorsInDocument} designators)`,
            'success');
        this._trackExport?.();
    },

    /** The netlist as readable text — the same data, for a person. */
    netlistToText() {
        const n = this.netlist;
        if (!n) return '';
        const L = [];
        L.push('COMPONENTS');
        n.components.forEach(c => {
            L.push(`  ${c.ref.padEnd(8)} ${(c.value || '').padEnd(10)} ${c.part || ''}`.trimEnd());
        });
        L.push('', 'NETS');
        n.nets.forEach(x => {
            const drawn = x.segments > 1 ? `  [${x.segments} drawn runs joined by name]` : '';
            L.push(`  ${x.name.padEnd(14)} ${x.refs.join(', ') || '(no part endpoints resolved)'}${drawn}`);
        });
        L.push('', 'COVERAGE');
        L.push(`  designators in document : ${n.coverage.designatorsInDocument}`);
        L.push(`  designators resolved    : ${n.coverage.designatorsResolved}`);
        if (n.coverage.unresolvedDesignators.length) {
            L.push(`  unresolved              : ${n.coverage.unresolvedDesignators.join(', ')}`);
        }
        L.push(`  nets with no label      : ${n.coverage.unnamedNets}`);
        L.push('', 'STROKE LAYERS (net vs symbol, by median connected-run span)');
        (n.layers || []).forEach(l => {
            L.push(`  ${l.color.padEnd(16)} ${String(l.segments).padStart(5)} segs  ` +
                   `median run ${String(l.medianRun).padStart(6)}pt  -> ${l.role}`);
        });
        return L.join('\n');
    },
});
