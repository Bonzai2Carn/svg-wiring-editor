/* ============================================================
   ginexys-schema-engine — Geometry Engine
   @public-api  Part of the open engine. See engine.js for the
                CDN entry point exposing KDTree2D / QuadTree2D /
                CameraMatrix as standalone classes.

   This file is a MobileSVGEditor prototype mixin. It adds a
   4-phase SVG topology analysis pipeline to any host that
   extends MobileSVGEditor.

   Phase 1 — Canonicalization
     • Matrix de-nesting → global coordinate space
     • Compound path segregation (split at extra M commands)
     • Bézier flattening (De Casteljau, ε-adaptive)

   Phase 2 — Geometric Classification
     • Isoperimetric Quotient  C = 4πA / P²  (circularity)
     • Linearity ratio  = endpoint-span / path-length
     • BBox aspect ratio (supplementary)

   Phase 3 — Topology
     • All edge endpoints into KD-Tree
     • Vertex snapping within ε (heals shattered PDF coords)
     • Port discovery: edge endpoints on node perimeters

   Phase 4 — Adjacency Graph
     • ComponentNode, JunctionNode, WireEdge
     • this.graph { nodes, edges, adjacency }
   ============================================================ */

/* ── Embedded path-data utility ─────────────────────────────
   Converts SVG path `d` strings into structured command arrays.
   All output commands are absolute; H/V are expanded to L.
   ────────────────────────────────────────────────────────── */
const PathData = {

    /** Parse `d` → [{cmd, args}] – all absolute, H/V → L */
    parse(d) {
        // Tokenize into command letters and numbers
        const TOKEN = /([MmZzLlHhVvCcSsQqTtAa])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
        const tokens = [];
        let m;
        while ((m = TOKEN.exec(d)) !== null)
            tokens.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));

        const cmds = [];
        let i = 0, cx = 0, cy = 0, sx = 0, sy = 0;

        const nums = () => {
            const a = [];
            while (i < tokens.length && typeof tokens[i] === 'number') a.push(tokens[i++]);
            return a;
        };

        while (i < tokens.length) {
            const cmd = tokens[i++];
            if (typeof cmd !== 'string') continue;
            const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
            const k   = cmd.toUpperCase();

            switch (k) {
                case 'M': {
                    let first = true;
                    const a = nums();
                    for (let j = 0; j < a.length; j += 2) {
                        cx = rel && !first ? cx + a[j] : (rel ? cx + a[j] : a[j]);
                        cy = rel && !first ? cy + a[j+1] : (rel ? cy + a[j+1] : a[j+1]);
                        if (first) { sx = cx; sy = cy; first = false;
                            cmds.push({ cmd: 'M', args: [cx, cy] }); }
                        else cmds.push({ cmd: 'L', args: [cx, cy] });
                    }
                    break;
                }
                case 'L': {
                    const a = nums();
                    for (let j = 0; j < a.length; j += 2) {
                        cx = rel ? cx + a[j] : a[j];
                        cy = rel ? cy + a[j+1] : a[j+1];
                        cmds.push({ cmd: 'L', args: [cx, cy] });
                    }
                    break;
                }
                case 'H': {     // expand to L (needs current Y)
                    const a = nums();
                    for (const v of a) {
                        cx = rel ? cx + v : v;
                        cmds.push({ cmd: 'L', args: [cx, cy] });
                    }
                    break;
                }
                case 'V': {     // expand to L (needs current X)
                    const a = nums();
                    for (const v of a) {
                        cy = rel ? cy + v : v;
                        cmds.push({ cmd: 'L', args: [cx, cy] });
                    }
                    break;
                }
                case 'C': {
                    const a = nums();
                    for (let j = 0; j < a.length; j += 6) {
                        const x1 = rel ? cx+a[j]   : a[j],   y1 = rel ? cy+a[j+1] : a[j+1];
                        const x2 = rel ? cx+a[j+2] : a[j+2], y2 = rel ? cy+a[j+3] : a[j+3];
                        cx = rel ? cx+a[j+4] : a[j+4]; cy = rel ? cy+a[j+5] : a[j+5];
                        cmds.push({ cmd: 'C', args: [x1, y1, x2, y2, cx, cy] });
                    }
                    break;
                }
                case 'Q': {
                    const a = nums();
                    for (let j = 0; j < a.length; j += 4) {
                        const x1 = rel ? cx+a[j]   : a[j],   y1 = rel ? cy+a[j+1] : a[j+1];
                        cx = rel ? cx+a[j+2] : a[j+2]; cy = rel ? cy+a[j+3] : a[j+3];
                        cmds.push({ cmd: 'Q', args: [x1, y1, cx, cy] });
                    }
                    break;
                }
                // S, T, A — approximate to line-to endpoint
                case 'S': { const a = nums();
                    for (let j = 0; j < a.length; j += 4) {
                        cx = rel ? cx+a[j+2] : a[j+2]; cy = rel ? cy+a[j+3] : a[j+3];
                        cmds.push({ cmd: 'L', args: [cx, cy] }); } break; }
                case 'T': { const a = nums();
                    for (let j = 0; j < a.length; j += 2) {
                        cx = rel ? cx+a[j] : a[j]; cy = rel ? cy+a[j+1] : a[j+1];
                        cmds.push({ cmd: 'L', args: [cx, cy] }); } break; }
                case 'A': { const a = nums();
                    for (let j = 0; j < a.length; j += 7) {
                        cx = rel ? cx+a[j+5] : a[j+5]; cy = rel ? cy+a[j+6] : a[j+6];
                        cmds.push({ cmd: 'L', args: [cx, cy] }); } break; }
                case 'Z':
                    cmds.push({ cmd: 'Z', args: [] });
                    cx = sx; cy = sy; break;
            }
        }
        return cmds;
    },

    /** Split parsed commands at each extra M → array of subpath command arrays */
    splitSubpaths(cmds) {
        const subs = [];
        let cur = [];
        for (const c of cmds) {
            if (c.cmd === 'M' && cur.length) { subs.push(cur); cur = []; }
            cur.push(c);
        }
        if (cur.length) subs.push(cur);
        return subs;
    },

    /** Serialize command array back to `d` string */
    serialize(cmds) {
        return cmds.map(({ cmd, args }) => args.length ? `${cmd} ${args.join(' ')}` : cmd).join(' ');
    },

    /** Apply DOMMatrix to all coordinates in a parsed command array */
    transformCmds(cmds, matrix) {
        const T = (x, y) => {
            const p = new DOMPoint(x, y).matrixTransform(matrix);
            return [+p.x.toFixed(3), +p.y.toFixed(3)];
        };
        return cmds.map(({ cmd, args }) => {
            if (cmd === 'Z') return { cmd: 'Z', args: [] };
            const out = [];
            for (let i = 0; i < args.length; i += 2) out.push(...T(args[i], args[i + 1]));
            return { cmd, args: out };
        });
    },

    // ── De Casteljau flatten ─────────────────────────────────
    _flatCubic(x0, y0, x1, y1, x2, y2, x3, y3, eps, pts) {
        const d1 = Math.abs((x1-x0)*(y3-y0) - (x3-x0)*(y1-y0));
        const d2 = Math.abs((x2-x0)*(y3-y0) - (x3-x0)*(y2-y0));
        if ((d1+d2)*(d1+d2) < eps*eps*16) { pts.push(x3, y3); return; }
        const mx1=(x0+x1)/2, my1=(y0+y1)/2, mx2=(x1+x2)/2, my2=(y1+y2)/2,
              mx3=(x2+x3)/2, my3=(y2+y3)/2, mx4=(mx1+mx2)/2, my4=(my1+my2)/2,
              mx5=(mx2+mx3)/2, my5=(my2+my3)/2, cx=(mx4+mx5)/2, cy=(my4+my5)/2;
        this._flatCubic(x0,y0,mx1,my1,mx4,my4,cx,cy,eps,pts);
        this._flatCubic(cx,cy,mx5,my5,mx3,my3,x3,y3,eps,pts);
    },

    _flatQuad(x0, y0, x1, y1, x2, y2, eps, pts) {
        const d = Math.abs((x1-x0)*(y2-y0) - (x2-x0)*(y1-y0));
        if (d*d < eps*eps*4) { pts.push(x2, y2); return; }
        const mx1=(x0+x1)/2, my1=(y0+y1)/2, mx2=(x1+x2)/2, my2=(y1+y2)/2,
              cx=(mx1+mx2)/2, cy=(my1+my2)/2;
        this._flatQuad(x0,y0,mx1,my1,cx,cy,eps,pts);
        this._flatQuad(cx,cy,mx2,my2,x2,y2,eps,pts);
    },

    /** Convert a command array to a flat [x,y,x,y,...] coordinate list */
    toPoints(cmds, eps = 0.5) {
        const flat = [];
        let cx = 0, cy = 0, sx = 0, sy = 0;
        for (const { cmd, args } of cmds) {
            switch (cmd) {
                case 'M': cx=args[0]; cy=args[1]; sx=cx; sy=cy; flat.push(cx,cy); break;
                case 'L': cx=args[0]; cy=args[1]; flat.push(cx,cy); break;
                case 'C':
                    this._flatCubic(cx,cy,args[0],args[1],args[2],args[3],args[4],args[5],eps,flat);
                    cx=args[4]; cy=args[5]; break;
                case 'Q':
                    this._flatQuad(cx,cy,args[0],args[1],args[2],args[3],eps,flat);
                    cx=args[2]; cy=args[3]; break;
                case 'Z': flat.push(sx,sy); cx=sx; cy=sy; break;
            }
        }
        return flat;   // [x0,y0, x1,y1, ...]
    },
};

/* ── Geometry Engine mixin ───────────────────────────────── */
Object.assign(MobileSVGEditor.prototype, {

    initGeometryEngine() {
        this._bboxMap   = new Map();   // elementId → {x,y,width,height}
        this.graph      = { nodes: new Map(), edges: new Map(), adjacency: new Map() };
        this._quadTree  = null;        // built lazily if nodes > 500
        this.connectors = [];          // pin-point circles — separate from this.components
    },

    // ══════════════════════════════════════════════════════════
    //  MAIN ORCHESTRATOR  (called from wiringDiagram.js)
    // ══════════════════════════════════════════════════════════
    _runGeometryPipeline() {
        this.wires      = [];
        this.components = [];
        this.connectors = [];
        this.connections= [];
        this.graph      = { nodes: new Map(), edges: new Map(), adjacency: new Map() };
        this._bboxMap   = new Map();

        const svgEl = this.$svgDisplay[0];

        // ── Size guard ────────────────────────────────────────────────────────
        // This used to bail above 1200 elements, on the theory that synchronous
        // analysis would freeze the browser. Measured on a real Arduino MEGA2560
        // sheet (7848 elements) the whole pipeline runs in ~380ms, so the guard
        // was trading the entire feature for a third of a second — and every
        // real schematic exceeds 1200 on import, which meant the analysis
        // effectively never ran on real data.
        //
        // Two changes. Decoration does not count toward the limit: a traced logo
        // can be 6000 elements of a 7800-element sheet, and refusing to analyse
        // a circuit because of a bitmap in the title block is the wrong answer.
        // And when the limit IS hit, say so where a person will see it, rather
        // than logging to a console nobody has open and returning silently.
        const ANALYSIS_ELEMENT_LIMIT = 20000;
        const allEls = svgEl.querySelectorAll('*').length;
        const decorEls = svgEl.querySelectorAll('[data-geo-class="ink"], [data-geo-class="ink"] *').length;
        const elementCount = allEls - decorEls;
        if (elementCount > ANALYSIS_ELEMENT_LIMIT) {
            console.warn(`[GeoEngine] Skipped pipeline: ${elementCount} analysable elements ` +
                `exceeds the ${ANALYSIS_ELEMENT_LIMIT} limit.`);
            this.showToast?.(
                `Too complex to analyse: ${elementCount.toLocaleString()} elements ` +
                `(limit ${ANALYSIS_ELEMENT_LIMIT.toLocaleString()}). ` +
                `Drawing loaded, but wires and components were not detected.`, 'warning');
            const d = this.displays[this.activeDisplayIdx];
            if (d) { d.analyzed = true; d.svgContent = new XMLSerializer().serializeToString(svgEl); }
            if (typeof this.buildLayersTree === 'function' && this.$sidePanel?.hasClass('open'))
                this.buildLayersTree();
            return;
        }

        // Strip hitbox wrappers from a previous run so phases 1-2 see clean geometry
        // We explicitly remove .wire-hitbox / .component-hitbox and promote their visual siblings.
        svgEl.querySelectorAll('.wire-group, .component-group').forEach(g => {
            // Find the visual element (the sibling of the hitbox)
            const visual = g.querySelector(':not(.wire-hitbox):not(.component-hitbox)');
            if (visual) g.parentNode?.insertBefore(visual, g);
            g.remove();
        });
        svgEl.querySelectorAll('.wire-hitbox, .component-hitbox').forEach(h => h.remove());
        svgEl.querySelectorAll('.domain-symbol > .component-hitbox').forEach(h => h.remove());

        // ── Determine epsilon by source format ────────────────
        const fmt = this.displays[this.activeDisplayIdx]?.sourceFormat || 'svg';
        const EPS = fmt === 'pdf' ? 2.0 : 0.5;

        // ── Phase 1: canonicalize ─────────────────────────────
        this._deNestTransforms(svgEl);
        this._segregatePaths(svgEl);
        // (curve flattening happens inside _classifyElements per-element)

        // ── Phase 2: classify ─────────────────────────────────
        const { wireEls, compEls } = this._classifyElements(svgEl);

        // ── Phase 3: topology ─────────────────────────────────
        const { wires, components, ports } = this._buildTopology(wireEls, compEls, EPS);

        // ── Phase 4: graph ────────────────────────────────────
        this._buildAdjacencyGraph(wires, components, ports);

        // ── DOM: create hitbox groups ─────────────────────────
        this._createWireHitboxes(wires);
        this._createComponentHitboxes(components);

        // ── BBox map & optional QuadTree ──────────────────────
        this._buildBBoxMap();
        const totalNodes = this.wires.length + this.components.length;
        if (totalNodes > 500) this._buildQuadTree();

        // ── Phase 5: semantics ────────────────────────────────
        // Topology says what touches what. This says what it is called, which
        // is the difference between a picture of a circuit and a netlist.
        try { this._buildSchematicSemantics?.(); }
        catch (e) { console.warn('[GeoEngine] semantics failed:', e); this.netlist = null; }

        // ── Mark display as analyzed ──────────────────────────
        const d = this.displays[this.activeDisplayIdx];
        if (d) {
            d.analyzed  = true;
            d.svgContent = new XMLSerializer().serializeToString(svgEl);
        }

        console.log(
            `[GeoEngine] wires=${this.wires.length} comps=${this.components.length}` +
            ` junctions=${[...this.graph.nodes.values()].filter(n=>n.kind==='junction').length}` +
            ` eps=${EPS} quadTree=${!!this._quadTree}` +
            (this.netlist
                ? ` | netlist: ${this.netlist.components.length} parts, ${this.netlist.nets.length} named nets`
                : '')
        );

        // Lint pass: mark unconnected pins before rebuilding the layers panel
        // so Structure-tab badges reflect the fresh connectivity state.
        if (typeof this._runLintPass === 'function') this._runLintPass();

        // Refresh layers panel if it's already open
        if (typeof this.buildLayersTree === 'function' &&
            this.$sidePanel?.hasClass('open')) {
            this.buildLayersTree();
        }
    },

    // ── Visual Lint Pass ─────────────────────────────────────────
    // Runs after every geometry pipeline in electrical mode.
    // Marks .pin-point elements whose nearest wire endpoint exceeds
    // EPS_LINT with data-lint-unconnected so the canvas and layers panel
    // can surface Error-Red indicators without re-running the full pipeline.
    _runLintPass() {
        if (this.activeMode !== 'electrical') return;
        const EPS_LINT = 8; // SVG-unit threshold — generous enough to catch snap imprecision

        // Flatten all snapped wire endpoints into one list (world/doc-local coords,
        // same coordinate space as _pinWorldPos output).
        const wireEps = (this.wires || []).flatMap(w => w.endpoints || []);

        this._contentRoot?.querySelectorAll('.pin-point').forEach(pin => {
            const wp = this._pinWorldPos(pin); // canvasEngine.js:822 — on shared prototype
            const connected = wireEps.some(ep =>
                Math.hypot(ep.x - wp.x, ep.y - wp.y) <= EPS_LINT
            );
            pin.toggleAttribute('data-lint-unconnected', !connected);
            pin.classList.toggle('pin-unconnected', !connected);
        });
    },

    // ==========================================================
    //  PHASE 1 — CANONICALIZATION
    // ==========================================================

    /** De-nest <g transform="..."> → apply matrix to children, remove <g>.
     *  Preserves user-created groups (id starts with "group_"). */
    _deNestTransforms(svgEl) {
        let groups = Array.from(svgEl.querySelectorAll('g[transform]'));
        // Iterate until no more transform-carrying groups remain
        let safety = 20;
        while (groups.length && safety-- > 0) {
            for (const g of groups) {
                // Skip user-created groups and all internal _ groups (camera, grid, etc.)
                if (g.id && (g.id.startsWith('group_') || g.id.startsWith('_'))) continue;
                if (g.closest('#_gridLayer, #_gridDefs, #_canvasBg, [data-se-system="true"], .snap-guide, .draw-preview, .selection-handle-group')) continue;
                // Skip editor overlay groups and placed schematic symbols
                if (g.classList.contains('wire-group') ||
                    g.classList.contains('component-group') ||
                    g.classList.contains('selection-handle-group') ||
                    g.classList.contains('domain-symbol')) continue;

                let matrix;
                try { matrix = new DOMMatrix(g.getAttribute('transform')); }
                catch (_) { continue; }

                const parent   = g.parentNode;
                const children = Array.from(g.childNodes);
                for (const child of children) {
                    if (child.nodeType !== 1) { parent.insertBefore(child, g); continue; }
                    this._applyMatrixToElement(child, matrix);
                    parent.insertBefore(child, g);
                }
                parent.removeChild(g);
            }
            groups = Array.from(svgEl.querySelectorAll('g[transform]'))
                         .filter(g => !g.id?.startsWith('group_') &&
                                      !g.id?.startsWith('_') &&
                                      !g.classList.contains('wire-group') &&
                                      !g.classList.contains('component-group') &&
                                      !g.classList.contains('domain-symbol'));
        }
    },

    /** Bake a DOMMatrix into an element's geometry attributes (type-specific). */
    _applyMatrixToElement(el, matrix) {
        const tag = el.tagName?.toLowerCase();
        const T = (x, y) => {
            const p = new DOMPoint(x, y).matrixTransform(matrix);
            return { x: +p.x.toFixed(3), y: +p.y.toFixed(3) };
        };

        try {
            if (tag === 'path') {
                const d = el.getAttribute('d');
                if (d) {
                    const cmds = PathData.parse(d);
                    const tCmds = PathData.transformCmds(cmds, matrix);
                    el.setAttribute('d', PathData.serialize(tCmds));
                }
            } else if (tag === 'line') {
                const p1 = T(+el.getAttribute('x1')||0, +el.getAttribute('y1')||0);
                const p2 = T(+el.getAttribute('x2')||0, +el.getAttribute('y2')||0);
                el.setAttribute('x1',p1.x); el.setAttribute('y1',p1.y);
                el.setAttribute('x2',p2.x); el.setAttribute('y2',p2.y);
            } else if (tag === 'rect') {
                // Transform all four corners, recompute axis-aligned bbox
                const x=+el.getAttribute('x')||0, y=+el.getAttribute('y')||0;
                const w=+el.getAttribute('width')||0, h=+el.getAttribute('height')||0;
                const corners = [T(x,y),T(x+w,y),T(x+w,y+h),T(x,y+h)];
                const xs=corners.map(c=>c.x), ys=corners.map(c=>c.y);
                el.setAttribute('x',     Math.min(...xs).toFixed(3));
                el.setAttribute('y',     Math.min(...ys).toFixed(3));
                el.setAttribute('width', (Math.max(...xs)-Math.min(...xs)).toFixed(3));
                el.setAttribute('height',(Math.max(...ys)-Math.min(...ys)).toFixed(3));
                el.removeAttribute('transform');
            } else if (tag === 'circle' || tag === 'ellipse') {
                const c = T(+el.getAttribute('cx')||0, +el.getAttribute('cy')||0);
                el.setAttribute('cx', c.x); el.setAttribute('cy', c.y);
            } else if (tag === 'polyline' || tag === 'polygon') {
                const pts = (el.getAttribute('points')||'').trim().split(/[\s,]+/).map(Number);
                const out = [];
                for (let j=0;j<pts.length;j+=2) { const p=T(pts[j],pts[j+1]); out.push(p.x,p.y); }
                el.setAttribute('points', out.join(' '));
            }
            // Consolidate remaining transform (matrix chain from parent)
            const existing = el.getAttribute('transform') || '';
            if (existing) {
                try {
                    const m2 = new DOMMatrix(existing);
                    const combined = matrix.multiply(m2);
                    el.setAttribute('transform', combined.toString());
                } catch (_) { el.removeAttribute('transform'); }
            }
        } catch (_) { /* silently skip malformed elements */ }
    },

    /** Split compound <path> elements (multiple M sub-commands) into individual <path>s. */
    _segregatePaths(svgEl) {
        const paths = Array.from(svgEl.querySelectorAll('path'));
        for (const path of paths) {
            if (path.classList.contains('wire-group') ||
                path.classList.contains('draw-preview')) continue;
            if (path.closest('#_gridLayer, #_gridDefs, #_canvasBg, [data-se-system="true"], .snap-guide, .draw-preview, .selection-handle-group')) continue;
            // Decoration is never split: nothing downstream reads its topology,
            // and a traced logo is thousands of subpaths nobody will address.
            if (path.closest('[data-gx-artwork="true"]')) continue;
            const d = path.getAttribute('d') || '';
            const cmds = PathData.parse(d);
            const subs = PathData.splitSubpaths(cmds);
            if (subs.length < 2) continue;

            const parent = path.parentNode;
            // Clone style attributes for each sub-path segment
            for (const sub of subs) {
                const np = document.createElementNS(this.SVG_NS, 'path');
                np.setAttribute('d', PathData.serialize(sub));
                ['stroke','stroke-width','fill','fill-opacity','stroke-dasharray','class','style']
                    .forEach(a => { const v=path.getAttribute(a); if(v) np.setAttribute(a,v); });
                parent.insertBefore(np, path);
            }
            parent.removeChild(path);
        }
    },

    // ==========================================================
    //  PHASE 2 — GEOMETRIC CLASSIFICATION
    // ==========================================================

    _classifyElements(svgEl) {
        const wireEls = [], compEls = [];
        const SKIP = new Set(['defs','script','style','title','desc','linearGradient',
                               'radialGradient','pattern','filter','marker','symbol','use']);

        // Pre-pass: elements explicitly tagged with data-geo-class bypass heuristics
        const taggedEls = new Set();
        svgEl.querySelectorAll('[data-geo-class]').forEach(el => {
            const cls = el.getAttribute('data-geo-class');
            // Ink (freehand pen) is decoration — excluded from wire/component analysis
            if (cls === 'ink') { taggedEls.add(el); return; }
            const score = this._scoreTaggedEl(el);
            if (!score) return;
            taggedEls.add(el);
            if (cls === 'wire') wireEls.push({ el, score });
            else                compEls.push({ el, score }); // 'component', 'junction', 'port'

            // Register pin-point circles as connector endpoints in world space
            if (cls !== 'wire' && el.tagName?.toLowerCase() === 'g') {
                const wm = this._elWorldMatrix(el);
                el.querySelectorAll('.pin-point').forEach(pinEl => {
                    const wp = new DOMPoint(
                        parseFloat(pinEl.getAttribute('cx') || 0),
                        parseFloat(pinEl.getAttribute('cy') || 0)).matrixTransform(wm);
                    const cx = wp.x, cy = wp.y;
                    const r  = parseFloat(pinEl.getAttribute('r')  || 2);
                    compEls.push({ el: pinEl, score: {
                        bbox: { x: cx - r, y: cy - r, width: r * 2, height: r * 2 },
                        aspect: 1, linearity: 0, circularity: 1,
                        pathLen: 0, span: 0, pts: [],
                    }});
                    taggedEls.add(pinEl);
                });
            }
        });

        const iter = document.createNodeIterator(svgEl, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = iter.nextNode())) {
            if (node === svgEl) continue;
            const tag = node.tagName?.toLowerCase();
            if (!tag || SKIP.has(tag)) continue;
            if (node.id === '_cameraRotGroup') continue;
            if (node.id?.startsWith('_') && node.id !== '_cameraRotGroup') continue;
            if (node.closest('#_gridLayer, #_gridDefs, #_canvasBg, [data-se-system="true"], .snap-guide, .draw-preview, .selection-handle-group')) continue;
            if (node.classList.contains('wire-group')  ||
                node.classList.contains('component-group') ||
                node.classList.contains('selection-handle-group') ||
                node.closest?.('.wire-group, .component-group')) continue;
            // Skip elements already handled by the tagged pre-pass (or nested inside them)
            if (taggedEls.has(node) || node.closest?.('[data-geo-class]')) continue;
            // Skip pure container <g>s that have no direct geometry
            if (tag === 'g') continue;

            const score = this._scoreElement(node);
            if (!score) continue;   // degenerate / zero-size

            if (score.linearity >= 0.88) {
                wireEls.push({ el: node, score });
            } else if (score.circularity >= 0.55 || score.linearity < 0.55) {
                compEls.push({ el: node, score });
            } else {
                // Ambiguous — use aspect ratio as tiebreaker
                if (score.aspect >= 4) wireEls.push({ el: node, score });
                else                   compEls.push({ el: node, score });
            }
        }
        return { wireEls, compEls };
    },

    /** Consolidated transform matrix from el's local space to document space
     *  (stops at the camera group so camera pan/zoom never leaks in). */
    _elWorldMatrix(el) {
        let m = new DOMMatrix();
        let node = el;
        const svg = this.$svgDisplay?.[0];
        while (node && node !== svg && node.id !== '_cameraRotGroup') {
            const tv = node.transform?.baseVal;
            if (tv?.length) {
                const lm = tv.consolidate()?.matrix;
                if (lm) m = new DOMMatrix([lm.a, lm.b, lm.c, lm.d, lm.e, lm.f]).multiply(m);
            }
            node = node.parentElement;
        }
        return m;
    },

    /** Score an element that carries data-geo-class — uses getBBox for <g> groups. */
    _scoreTaggedEl(el) {
        const tag = el.tagName?.toLowerCase();
        const cls = el.getAttribute('data-geo-class');
        if (tag === 'g') {
            let b;
            try { b = this._getVisualBBox(el); } catch (_) { return null; }
            if (!b.width && !b.height) return null;
            // Placed symbols keep their translate/rotate transform, so the local
            // getBBox must be projected to document space — wire endpoints live
            // there, and port discovery compares the two directly.
            const wm = this._elWorldMatrix(el);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height],
             [b.x + b.width, b.y + b.height]].forEach(([px, py]) => {
                const tp = new DOMPoint(px, py).matrixTransform(wm);
                minX = Math.min(minX, tp.x); minY = Math.min(minY, tp.y);
                maxX = Math.max(maxX, tp.x); maxY = Math.max(maxY, tp.y);
            });
            const bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
            return {
                bbox,
                aspect:      Math.max(b.width, b.height) / (Math.min(b.width, b.height) || 1),
                linearity:   cls === 'wire' ? 1.0 : 0.0,
                circularity: cls === 'wire' ? 0.0 : 1.0,
                pathLen: 0, span: 0,
                pts: cls === 'wire'
                    ? [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height]
                    : [],
            };
        }
        // Primitive elements: use normal geometric scoring
        return this._scoreElement(el);
    },

    /** Compute geometric scores for any SVG element. Returns null if degenerate. */
    _scoreElement(el) {
        const pts = this._getElementPoints(el);  // flat [x,y,...] in global coords
        if (pts.length < 4) return null;         // need at least 2 points

        const n = pts.length / 2;

        // Bounding box from points
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        for (let i=0;i<pts.length;i+=2) {
            if(pts[i]<minX)minX=pts[i]; if(pts[i]>maxX)maxX=pts[i];
            if(pts[i+1]<minY)minY=pts[i+1]; if(pts[i+1]>maxY)maxY=pts[i+1];
        }
        const bw=maxX-minX, bh=maxY-minY;
        if (bw < 1 && bh < 1) return null;

        const bbox = { x: minX, y: minY, width: bw, height: bh };
        const aspect = bw > 0 && bh > 0 ? Math.max(bw,bh)/Math.min(bw,bh) : Infinity;

        // Path length + endpoint span
        let pathLen = 0;
        for (let i=2;i<pts.length;i+=2)
            pathLen += Math.hypot(pts[i]-pts[i-2], pts[i+1]-pts[i-1]);
        const dx = pts[pts.length-2]-pts[0], dy = pts[pts.length-1]-pts[1];
        const span = Math.hypot(dx, dy);
        const linearity = pathLen > 0 ? span / pathLen : 0;

        // Isoperimetric Quotient (circularity) — only meaningful for closed shapes
        let circularity = 0;
        const closed = pts[0]===pts[pts.length-2] && pts[1]===pts[pts.length-1];
        if (closed && n >= 3) {
            // Shoelace area
            let area = 0;
            for (let i=0;i<pts.length-2;i+=2)
                area += pts[i]*pts[i+3] - pts[i+2]*pts[i+1];
            area = Math.abs(area) / 2;
            if (pathLen > 0) circularity = (4 * Math.PI * area) / (pathLen * pathLen);
        }

        return { bbox, aspect, linearity, circularity, pathLen, span, pts };
    },

    /** Extract a flat [x,y,...] point array from any SVG element (no getBBox). */
    _getElementPoints(el) {
        const tag = el.tagName?.toLowerCase();
        const EPS = 0.5;
        try {
            if (tag === 'path') {
                const cmds = PathData.parse(el.getAttribute('d') || '');
                return PathData.toPoints(cmds, EPS);
            }
            if (tag === 'line') {
                return [+el.getAttribute('x1')||0, +el.getAttribute('y1')||0,
                        +el.getAttribute('x2')||0, +el.getAttribute('y2')||0];
            }
            if (tag === 'polyline' || tag === 'polygon') {
                const raw = (el.getAttribute('points')||'').trim().split(/[\s,]+/).map(Number);
                if (tag === 'polygon' && raw.length >= 2)
                    return [...raw, raw[0], raw[1]];   // close the polygon
                return raw;
            }
            if (tag === 'rect') {
                const x=+el.getAttribute('x')||0, y=+el.getAttribute('y')||0;
                const w=+el.getAttribute('width')||0, h=+el.getAttribute('height')||0;
                return [x,y, x+w,y, x+w,y+h, x,y+h, x,y];
            }
            if (tag === 'circle') {
                const cx=+el.getAttribute('cx')||0, cy=+el.getAttribute('cy')||0;
                const r =+el.getAttribute('r') ||0;
                // 12-point polygon approximation of circle
                const pts=[];
                for(let a=0;a<12;a++){const θ=a*Math.PI/6; pts.push(cx+r*Math.cos(θ),cy+r*Math.sin(θ));}
                pts.push(pts[0],pts[1]);
                return pts;
            }
            if (tag === 'ellipse') {
                const cx=+el.getAttribute('cx')||0, cy=+el.getAttribute('cy')||0;
                const rx=+el.getAttribute('rx')||0, ry=+el.getAttribute('ry')||0;
                const pts=[];
                for(let a=0;a<12;a++){const θ=a*Math.PI/6; pts.push(cx+rx*Math.cos(θ),cy+ry*Math.sin(θ));}
                pts.push(pts[0],pts[1]);
                return pts;
            }
        } catch (_) {}
        return [];
    },

    // ==========================================================
    //  PHASE 3 — TOPOLOGY: KD-Tree + Vertex Snapping + Ports
    // ==========================================================

    _buildTopology(wireEls, compEls, eps) {
        // Extract all wire endpoints into KD-Tree
        const rawEndpoints = [];
        wireEls.forEach(({ el, score }, i) => {
            const pts = score.pts;
            if (pts.length < 4) return;
            // First point
            rawEndpoints.push({ x: pts[0],              y: pts[1],              wireIdx: i, role: 'start' });
            // Last point
            rawEndpoints.push({ x: pts[pts.length - 2], y: pts[pts.length - 1], wireIdx: i, role: 'end'   });
        });

        // Build balanced KD-Tree
        const kdt = rawEndpoints.length
            ? KDTree2D.fromPoints(rawEndpoints)
            : new KDTree2D();

        // Vertex snapping: assign canonical coordinates to clusters
        const canonical = new Float32Array(rawEndpoints.length * 2);
        const assigned  = new Uint8Array(rawEndpoints.length);
        let canonIdx = 0;

        // Each endpoint carries its own index. This used to call
        // rawEndpoints.indexOf(n) for every neighbour of every point, an O(n)
        // scan nested two deep, so snapping was quadratic in the endpoint count
        // — which is what made a real drawing look like it needed a size limit.
        rawEndpoints.forEach((ep, i) => { ep._i = i; });

        rawEndpoints.forEach((ep, i) => {
            if (assigned[i]) return;
            const neighbors = kdt.rangeQuery(ep.x, ep.y, eps);
            // Compute centroid of cluster
            let cx = 0, cy = 0;
            neighbors.forEach(n => { cx += n.x; cy += n.y; });
            cx /= neighbors.length; cy /= neighbors.length;
            // Mark all neighbors with this canonical coord
            neighbors.forEach(n => {
                const ni = n._i;
                if (ni >= 0 && !assigned[ni]) {
                    canonical[ni * 2]     = cx;
                    canonical[ni * 2 + 1] = cy;
                    assigned[ni] = 1;
                }
            });
            canonIdx++;
        });

        // Build wire records with snapped endpoints
        const wires = wireEls.map(({ el, score }, i) => {
            const pts = score.pts;
            const startIdx = i * 2;
            const endIdx   = i * 2 + 1;
            const sx = assigned[startIdx] ? canonical[startIdx*2]   : pts[0];
            const sy = assigned[startIdx] ? canonical[startIdx*2+1] : pts[1];
            const ex = assigned[endIdx]   ? canonical[endIdx*2]     : pts[pts.length-2];
            const ey = assigned[endIdx]   ? canonical[endIdx*2+1]   : pts[pts.length-1];
            return {
                el, id: `wire_${i}`,
                // Prefer SVG attribute; fall back to inline style (imported SVGs often use style only)
                color:  el.getAttribute('stroke') || el.style?.stroke || 'black',
                width:  parseFloat(el.getAttribute('stroke-width') || el.style?.strokeWidth || '1'),
                endpoints: [{ x: sx, y: sy }, { x: ex, y: ey }],
                length:    score.pathLen,
                linearity: score.linearity,
                bbox:      score.bbox,
            };
        });

        // Component records with bbox from geometry (no getBBox call)
        const components = compEls.map(({ el, score }, i) => ({
            el, id: `component_${i}`,
            bbox:        score.bbox,
            circularity: score.circularity,
            type:        this._classifyComponentType(el, score.circularity),
            ports:       [],
        }));

        // Port discovery. Two tiers:
        //  1. Placed symbols expose .pin-point circles — a wire endpoint within
        //     PIN_TOL of a pin's world position is a connection to THAT pin.
        //     This is electrically exact (bbox proximity would count a wire
        //     touching the symbol body as "connected").
        //  2. Analyzed/imported components have no pin metadata — fall back to
        //     the bbox inference zone.
        const ports = [];
        const MARGIN  = eps * 3;
        const PIN_TOL = 8;   // matches _runLintPass — absorbs snap imprecision

        const compPins = components.map(comp => {
            const g = comp.el;
            if (g?.tagName?.toLowerCase() !== 'g' || !g.classList?.contains('domain-symbol')) return null;
            const wm = this._elWorldMatrix(g);
            return [...g.querySelectorAll('.pin-point')].map((pinEl, i) => {
                const wp = new DOMPoint(
                    parseFloat(pinEl.getAttribute('cx') || 0),
                    parseFloat(pinEl.getAttribute('cy') || 0)).matrixTransform(wm);
                return { pinId: pinEl.dataset.pin ?? String(i), x: wp.x, y: wp.y };
            });
        });

        wires.forEach(wire => {
            wire.endpoints.forEach(ep => {
                components.forEach((comp, ci) => {
                    const pins = compPins[ci];
                    let port = null;
                    if (pins?.length) {
                        const hit = pins.find(p => Math.hypot(p.x - ep.x, p.y - ep.y) <= PIN_TOL);
                        if (hit) port = { compId: comp.id, wireId: wire.id, x: ep.x, y: ep.y, pinId: hit.pinId };
                    } else {
                        const b = comp.bbox;
                        // Expand bbox by MARGIN = "inference zone"
                        if (ep.x >= b.x - MARGIN && ep.x <= b.x + b.width  + MARGIN &&
                            ep.y >= b.y - MARGIN && ep.y <= b.y + b.height + MARGIN) {
                            port = { compId: comp.id, wireId: wire.id, x: ep.x, y: ep.y };
                        }
                    }
                    if (port) { comp.ports.push(port); ports.push(port); }
                });
            });
        });

        return { wires, components, ports };
    },

    // ==========================================================
    //  PHASE 4 — GRAPH / ADJACENCY LIST
    // ==========================================================

    _buildAdjacencyGraph(wires, components, ports) {
        const nodes     = this.graph.nodes;
        const edges     = this.graph.edges;
        const adjacency = this.graph.adjacency;

        // Register component nodes
        components.forEach(comp => {
            nodes.set(comp.id, { kind: 'component', ...comp });
            adjacency.set(comp.id, []);
        });

        // Detect junction dots (3+ wires at same snapped point)
        const epMap = new Map();   // "x,y" → [wireId, ...]
        wires.forEach(wire => {
            wire.endpoints.forEach(ep => {
                const key = `${ep.x.toFixed(2)},${ep.y.toFixed(2)}`;
                if (!epMap.has(key)) epMap.set(key, []);
                epMap.get(key).push(wire.id);
            });
        });

        let junctionIdx = 0;
        const junctionAt = new Map();   // "x,y" → junction id
        epMap.forEach((wireIds, key) => {
            if (wireIds.length >= 3) {
                const [x, y] = key.split(',').map(Number);
                const jid = `junction_${junctionIdx++}`;
                nodes.set(jid, { kind: 'junction', id: jid, x, y, degree: wireIds.length });
                adjacency.set(jid, []);
                junctionAt.set(key, jid);
            }
        });

        // Register wire edges and link to component/junction nodes.
        // A wire endpoint resolves to a component (via port match) first,
        // then a junction dot — so connectivity survives T-junctions.
        wires.forEach(wire => {
            const portMatches = ports.filter(p => p.wireId === wire.id);
            const resolve = (ep) =>
                portMatches.find(p => Math.hypot(p.x - ep.x, p.y - ep.y) < 1)?.compId ||
                junctionAt.get(`${ep.x.toFixed(2)},${ep.y.toFixed(2)}`) || null;
            const fromNode = resolve(wire.endpoints[0]);
            const toNode   = resolve(wire.endpoints[1]);

            edges.set(wire.id, {
                id: wire.id, from: fromNode, to: toNode,
                color: wire.color, length: wire.length,
                signalType: null,
            });

            if (fromNode && toNode && fromNode !== toNode) {
                adjacency.get(fromNode)?.push(toNode);
                adjacency.get(toNode)?.push(fromNode);
            }
        });

        this._buildNets(wires, ports);
    },

    // ── Nets via union-find over canonical endpoints ──────────
    // Wires that touch (directly or through junction chains) share a net;
    // components join every net their ports land on. This is what makes
    // hover-highlighting cover the WHOLE electrically-connected run, not
    // just the hovered wire's two immediate neighbors.
    _buildNets(wires, ports) {
        const parent = new Map();
        const find = (k) => {
            while (parent.get(k) !== k) {
                parent.set(k, parent.get(parent.get(k)));
                k = parent.get(k);
            }
            return k;
        };
        const union = (a, b) => {
            if (!parent.has(a)) parent.set(a, a);
            if (!parent.has(b)) parent.set(b, b);
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent.set(ra, rb);
        };
        const key = (p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;

        wires.forEach(w => union(key(w.endpoints[0]), key(w.endpoints[1])));

        const nets = new Map();   // root key → { id, wireIds, compIds }
        let netIdx = 0;
        const netFor = (k) => {
            if (!parent.has(k)) return null;
            const root = find(k);
            if (!nets.has(root)) nets.set(root, { id: `net_${netIdx++}`, wireIds: [], compIds: new Set() });
            return nets.get(root);
        };

        wires.forEach(w => {
            const net = netFor(key(w.endpoints[0]));
            if (net) { net.wireIds.push(w.id); w.net = net; }
        });
        ports.forEach(p => netFor(key(p))?.compIds.add(p.compId));

        this.graph.nets = [...nets.values()];
    },

    // ==========================================================
    //  POST-ANALYSIS: DOM HITBOXES
    // ==========================================================

    _createWireHitboxes(wires) {
        const NS = this.SVG_NS;
        wires.forEach(wire => {
            const { el, id, color } = wire;
            const group = document.createElementNS(NS, 'g');
            group.setAttribute('class', 'wire-group');
            group.setAttribute('data-wire-id', id);

            const visual  = el.cloneNode(true);
            const hitbox  = el.cloneNode(true);
            hitbox.removeAttribute('id'); // Fix: prevent ID collision with visual path
            hitbox.setAttribute('stroke', color);
            hitbox.setAttribute('stroke-opacity', '0');
            hitbox.setAttribute('stroke-width',
                String(Math.max(12, parseFloat(el.getAttribute('stroke-width')||'1') * 6)));
            hitbox.setAttribute('fill', 'none');
            hitbox.setAttribute('class', 'wire-hitbox');
            hitbox.setAttribute('data-wire-id', id);

            group.appendChild(visual);
            group.appendChild(hitbox);
            el.parentNode?.replaceChild(group, el);

            // Update the wire record to point to new DOM nodes
            wire.element  = visual;
            wire.$element = $(visual);
            wire.$hitbox  = $(hitbox);
            wire.$group   = $(group);

            // A selected wire just had its DOM node swapped for the clone —
            // remap the selection so overlay handles keep tracking it.
            const selIdx = this._selection?.indexOf(el);
            if (selIdx >= 0) this._selection[selIdx] = visual;

            this.wires.push(wire);
        });
    },

    _createComponentHitboxes(components) {
        const NS = this.SVG_NS;
        components.forEach(comp => {
            const { el, id, bbox } = comp;
            const tag = el.tagName?.toLowerCase();

            // Pin-point circles are connectors — separate bucket from components.
            if (el.classList.contains('pin-point')) {
                comp.element  = el;
                comp.$element = $(el);
                comp.$hitbox  = $(el);
                comp.$group   = $(el);
                comp.type     = 'connector';
                this.connectors.push(comp);
                return;
            }

            // Domain-symbol <g> elements stay in place — just append a hitbox rect
            // inside the group using local-space coords from getBBox() so the group
            // itself remains the selectable element for the canvas engine.
            if (tag === 'g' && el.classList.contains('domain-symbol')) {
                let lb;
                try { lb = this._getVisualBBox(el); } catch (_) { lb = bbox; }
                const hitbox = document.createElementNS(NS, 'rect');
                hitbox.setAttribute('x',      String(lb.x));
                hitbox.setAttribute('y',      String(lb.y));
                hitbox.setAttribute('width',  String(lb.width));
                hitbox.setAttribute('height', String(lb.height));
                hitbox.setAttribute('fill-opacity',    '0');
                hitbox.setAttribute('stroke-opacity',  '0');
                hitbox.setAttribute('pointer-events',  'all');
                hitbox.setAttribute('class',           'component-hitbox');
                hitbox.setAttribute('data-component-id', id);
                el.appendChild(hitbox);

                comp.element  = el;
                comp.$element = $(el);
                comp.$hitbox  = $(hitbox);
                comp.$group   = $(el);
                this.components.push(comp);
                return;
            }

            const group = document.createElementNS(NS, 'g');
            group.setAttribute('class', 'component-group');
            group.setAttribute('data-component-id', id);

            const visual = el.cloneNode(true);

            let hitbox;
            if (tag === 'g' || bbox.width > 0) {
                hitbox = document.createElementNS(NS, 'rect');
                hitbox.setAttribute('x',      String(bbox.x));
                hitbox.setAttribute('y',      String(bbox.y));
                hitbox.setAttribute('width',  String(bbox.width));
                hitbox.setAttribute('height', String(bbox.height));
            } else {
                hitbox = el.cloneNode(true);
                hitbox.removeAttribute('id'); // Fix: prevent ID collision in snapshot
            }
            hitbox.setAttribute('fill-opacity',   '0');
            hitbox.setAttribute('stroke-opacity',  '0');
            hitbox.setAttribute('pointer-events',  'all');
            hitbox.setAttribute('class',           'component-hitbox');
            hitbox.setAttribute('data-component-id', id);

            group.appendChild(visual);
            group.appendChild(hitbox);
            el.parentNode?.replaceChild(group, el);

            comp.element  = visual;
            comp.$element = $(visual);
            comp.$hitbox  = $(hitbox);
            comp.$group   = $(group);

            this.components.push(comp);
        });
    },

    // ==========================================================
    //  BBox MAP + QuadTree
    // ==========================================================

    _buildBBoxMap() {
        this._bboxMap.clear();
        [...this.wires, ...this.components].forEach(item => {
            if (item.bbox && item.id)
                this._bboxMap.set(item.id, item.bbox);
            // Also index by DOM element id for canvas engine lookups
            const domId = item.element?.id;
            if (domId && item.bbox) this._bboxMap.set(domId, item.bbox);
        });
    },

    _buildQuadTree() {
        const svgEl = this.$svgDisplay[0];
        const vb    = (svgEl.getAttribute('viewBox')||'0 0 2000 2000').split(/\s+/).map(Number);
        const bounds = { x: vb[0]||0, y: vb[1]||0, width: vb[2]||2000, height: vb[3]||2000 };
        this._quadTree = new QuadTree2D(bounds, 8);

        [...this.wires, ...this.components].forEach(item => {
            if (!item.bbox) return;
            const { x, y, width: w, height: h } = item.bbox;
            this._quadTree.insert({ x: x + w/2, y: y + h/2, data: item });
        });
    },

    // ==========================================================
    //  COMPONENT TYPE CLASSIFICATION (geometry-aware)
    // ==========================================================

    _classifyComponentType(el, circularity) {
        const manualClass = el.getAttribute('data-geo-class');
        if (manualClass && manualClass !== 'wire') return manualClass;

        const tag = el.tagName?.toLowerCase();
        const cls = el.getAttribute('class') || '';
        const id  = el.getAttribute('id')    || '';

        // Domain symbols carry their semantic type explicitly
        const symId = el.getAttribute('data-symbol');
        if (symId) return symId;   // 'resistor', 'capacitor', 'npn', etc.

        // Pin-point circles inside symbols are connector endpoints
        if (cls.includes('pin-point')) return 'connector';

        // Semantic hints from class/id
        if (cls.includes('resistor'))  return 'resistor';
        if (cls.includes('capacitor')) return 'capacitor';
        if (cls.includes('switch'))    return 'switch';
        if (id.includes('relay'))      return 'relay';

        // Geometric fallback — avoid over-applying 'connector' to tagged groups
        if (tag === 'circle' && circularity >= 0.7) return 'connector';
        if (tag === 'rect')                          return 'module';
        if (circularity >= 0.45 && tag !== 'g')      return 'connector';
        return 'component';
    },

    // ==========================================================
    //  BACKWARD-COMPATIBLE HELPERS
    // ==========================================================

    /** Returns snapped endpoints for a wire element (was: parsed from path `d`). */
    getWireEndPoints($wire) {
        const el = $wire[0];
        const rec = this.wires.find(w => w.element === el || w.$hitbox?.[0] === el);
        if (rec?.endpoints) return rec.endpoints;

        // Fallback to attribute parsing (for user-drawn wires not in the analysis set)
        if (el.tagName === 'line') {
            return [
                { x: parseFloat($wire.attr('x1')), y: parseFloat($wire.attr('y1')) },
                { x: parseFloat($wire.attr('x2')), y: parseFloat($wire.attr('y2')) },
            ];
        }
        const m = ($wire.attr('d') || '').match(/[\d.]+/g);
        if (m && m.length >= 4)
            return [
                { x: parseFloat(m[0]), y: parseFloat(m[1]) },
                { x: parseFloat(m[m.length-2]), y: parseFloat(m[m.length-1]) },
            ];
        return [];
    },

    /** Graph-based connected component lookup (replaces O(n²) linear scan). */
    highlightConnectedComponents($wireElement) {
        const el    = $wireElement[0];
        const wire  = this.wires.find(w => w.element === el || w.$hitbox?.[0] === el);
        if (!wire) return;

        const highlightComp = (nodeId) => {
            if (!nodeId) return;
            const comp = this.components.find(c => c.id === nodeId);
            comp?.$element?.addClass('component-highlight');
        };

        // Whole-net highlight: every wire and component electrically connected
        // to the hovered wire (transitively, through junctions) lights up.
        const net = wire.net;
        if (!net) return;
        net.wireIds.forEach(wid => {
            const w = this.wires.find(x => x.id === wid);
            w?.$element?.addClass('wire-trace');
        });
        net.compIds.forEach(highlightComp);

        // Highlight connector pin-points near the wire's endpoints (logic lives in highlights.js)
        this.highlightWireEndpoints?.(wire);
    },

    isWire($element) {
        const el = $element[0];
        return this.wires.some(w => w.element === el || w.$hitbox?.[0] === el);
    },
});
