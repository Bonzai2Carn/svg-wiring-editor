/* ============================================================
   Schematics Editor — Measure Tool
   ------------------------------------------------------------
   Measure is a DRAW TOOL, not a mode with its own private rules.

   It used to be both a tool and its own settings dialog: clicking
   Measure opened a modal, and the tool only started once you pressed
   OK. That coupled two unrelated things. The scale of the drawing is
   a property of the DOCUMENT and you set it once; measuring is an
   ACTION you take repeatedly. Bundling them meant you could not
   re-measure without re-confirming the scale, and the tool sat
   outside the tool system, so it missed everything that system
   provides.

   Now:
     · scale + unit live in the toolbar (settings, set once)
     · measure is registered in _DRAW_TOOLS, so it inherits Escape to
       cancel, Q to lock for repeat measuring, auto-revert to select
       after a commit, and the standard cursor/hint handling
     · a finished measurement is a real element in the document, so it
       persists, serializes, undoes, and can be selected and moved with
       the select tool like anything else
     · distance, angle and Δx/Δy update LIVE during the drag rather
       than only appearing once the second point lands

   Annotations carry data-geo-class="ink" so the geometry pipeline
   treats them as decoration. A measurement must never enter the
   netlist as a wire.
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    initMeasureTool() {
        this._measureUnit        = this._measureUnit || 'px';
        this._measurePxVal       = this._measurePxVal || 1;
        this._measureUnitVal     = this._measureUnitVal || 1;
        this._measureScaleFactor = this._measureScaleFactor || null;
        this._measurePoints      = [];
        this._bindMeasureSettings();
    },

    // ── Settings (toolbar) ────────────────────────────────────
    //   Separate from the tool on purpose: a drawing has one scale, and
    //   you should not have to restate it every time you measure.

    _bindMeasureSettings() {
        $('#measureUnitSel').on('change', (e) => {
            this.setMeasureUnit(e.target.value);
        });
        $('#measureCalibrateBtn').on('click', () => this._showMeasureModal());
        this._syncMeasureSettings();
    },

    setMeasureUnit(unit) {
        this._measureUnit = unit || 'px';
        // px means "no calibration" — the drawing is measured in its own units.
        if (this._measureUnit === 'px') this._measureScaleFactor = null;
        else this._measureScaleFactor = (this._measureUnitVal || 1) / (this._measurePxVal || 1);
        this._syncMeasureSettings();
        this.showToast(this._measureUnit === 'px'
            ? 'Measuring in canvas units'
            : `Measuring in ${this._measureUnit} (1 ${this._measureUnit} = ${(1 / this._measureScaleFactor).toFixed(3)} px)`,
            'success');
    },

    setMeasureScale(pxVal, unitVal) {
        this._measurePxVal   = parseFloat(pxVal)   || 1;
        this._measureUnitVal = parseFloat(unitVal) || 1;
        if (this._measureUnit !== 'px') {
            this._measureScaleFactor = this._measureUnitVal / this._measurePxVal;
        }
        this._syncMeasureSettings();
    },

    _syncMeasureSettings() {
        $('#measureUnitSel').val(this._measureUnit || 'px');
        const label = this._measureUnit === 'px'
            ? 'uncalibrated'
            : `${this._measurePxVal}px = ${this._measureUnitVal}${this._measureUnit}`;
        $('#measureScaleLabel').text(label);
    },

    _showMeasureModal() {
        const $modal = $('#measureModal');
        $modal.addClass('open');
        const unit = this._measureUnit || 'px';
        $modal.find('.measure-unit-btn').removeClass('active');
        $modal.find(`.measure-unit-btn[data-unit="${unit}"]`).addClass('active');
        $('#measurePxVal').val(this._measurePxVal || 1);
        $('#measureUnitVal').val(this._measureUnitVal || 1);

        const system = ['mm', 'cm', 'm'].includes(unit) ? 'metric' : (unit === 'px' ? 'px' : 'imperial');
        $modal.find('.measure-tab').removeClass('active');
        $modal.find(`.measure-tab[data-system="${system}"]`).addClass('active');
        $modal.find('.measure-unit-group').hide();
        $modal.find(`.measure-unit-group[data-system="${system}"]`).show();
        const showScale = system !== 'px';
        $('#measureScaleRow').toggle(showScale);
        if (showScale) $('#measureScaleUnitLabel').text(unit);
    },

    // ── Tool lifecycle ────────────────────────────────────────
    //   Driven by setActiveTool('measure'), same as every other draw
    //   tool. There is no separate on/off flag to fall out of sync.

    _measureBegin() {
        this._measurePoints = [];
        this._clearMeasurePreview();
    },

    _measureEnd() {
        this._measurePoints = [];
        this._drawState = null;
        this._clearMeasurePreview();
    },

    // Waypoints, exactly like the wire tool: click to add, dbl-click or Enter
    // to commit, Backspace to retract, Esc to cancel. A measurement is often a
    // route rather than a straight hop, and the two tools now behave the same.
    _measureClick(pt, target) {
        if (!this._measurePoints.length) {
            const wire = target?.closest?.('path[data-geo-class="wire"], path.wire-path');
            if (wire) { this._measureWire(wire); return; }
            // _drawState is what the shared Escape/Enter handlers watch.
            this._drawState = { tool: 'measure', before: this._captureFullState() };
        }
        this._measurePoints.push({ x: pt.x, y: pt.y });
        this._drawMeasurePreview(this._measurePoints, this._measurePoints[this._measurePoints.length - 1]);
        if (this._measurePoints.length === 1) {
            this.showToast('Point set — click more points, dbl-click or Enter to finish', 'success');
        }
    },

    _measureMove(pt) {
        if (!this._measurePoints.length) return;
        this._drawMeasurePreview(this._measurePoints, pt);
    },

    _measureRetract() {
        if (this._measurePoints.length < 2) return;
        this._measurePoints.pop();
        this._drawMeasurePreview(this._measurePoints, this._measurePoints[this._measurePoints.length - 1]);
    },

    _measureCommit() {
        if (this._measurePoints.length < 2) { this._measureEnd(); return; }
        this._commitMeasurement(this._measurePoints.slice());
    },

    // ── Committing a measurement into the document ────────────

    _commitMeasurement(points) {
        const before = this._drawState?.before || this._captureFullState();
        this._clearMeasurePreview();

        const g = this._buildMeasureAnnotation(points);
        if (!g) { this._measureEnd(); return; }
        this._contentRoot.appendChild(g);

        this._measurePoints = [];
        this._drawState = null;

        this.pushHistory('Measure', before, this._captureFullState());
        if (typeof this.buildLayersTree === 'function') this.buildLayersTree();

        const m = this._measureChainStats(points);
        this.showToast(points.length > 2
            ? `${m.total} total over ${points.length - 1} segments`
            : `${m.total}  Δx ${m.dx}  Δy ${m.dy}  ∠${m.angleAbs}° ${m.angleClass}`, 'success');

        this._revertToSelectTool?.();
    },

    _measureWire(wireEl) {
        try {
            const before = this._captureFullState();
            const rawLen = wireEl.getTotalLength();
            const label  = this._formatMeasureResult(rawLen);
            const pts    = this._parseWirePoints?.(wireEl);
            const segs   = pts ? Math.max(pts.length - 1, 1) : 1;

            let mid = wireEl.getPointAtLength(rawLen / 2);
            const toDoc = this._elToDoc?.(wireEl);
            if (toDoc && !toDoc.isIdentity) mid = new DOMPoint(mid.x, mid.y).matrixTransform(toDoc);

            const g = this._measureGroup({ kind: 'wire', wire: wireEl.id || '', value: label });
            this._appendCallout(g, mid.x, mid.y, `${label} · ${segs} seg${segs !== 1 ? 's' : ''}`);
            this._contentRoot.appendChild(g);

            this.pushHistory('Measure Wire', before, this._captureFullState());
            this.showToast(`Wire: ${label} · ${segs} segment${segs !== 1 ? 's' : ''}`, 'success');
            this._measureEnd();
            this._revertToSelectTool?.();
        } catch (_) {
            this.showToast('Could not measure wire', 'error');
        }
    },

    // ── Geometry + formatting ─────────────────────────────────

    _measureSegStats(a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
        return {
            raw: dist, dx, dy,
            dist: this._formatMeasureResult(dist),
            angle: angleDeg,
            angleAbs: Math.abs(angleDeg).toFixed(1),
            angleClass: this._classifyAngle(angleDeg),
        };
    },

    // Whole-chain summary: total run plus, for a simple two-point measurement,
    // the deltas and bearing that only make sense for a single segment.
    _measureChainStats(pts) {
        let raw = 0;
        for (let i = 1; i < pts.length; i++) raw += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        const a = pts[0], b = pts[pts.length - 1];
        const seg = this._measureSegStats(a, b);
        return {
            raw,
            total: this._formatMeasureResult(raw),
            dx: this._formatMeasureResult(Math.abs(seg.dx)),
            dy: this._formatMeasureResult(Math.abs(seg.dy)),
            angleAbs: seg.angleAbs,
            angleClass: seg.angleClass,
        };
    },

    _formatMeasureResult(distPx) {
        if (!this._measureScaleFactor || this._measureUnit === 'px') {
            return `${distPx.toFixed(1)} px`;
        }
        return `${(distPx * this._measureScaleFactor).toFixed(3)} ${this._measureUnit}`;
    },

    _classifyAngle(deg) {
        const norm = ((deg % 180) + 180) % 180;
        if (norm < 1 || norm > 179)    return 'Straight';
        if (Math.abs(norm - 90) < 1.5) return 'Right';
        if (Math.abs(norm - 45) < 2 || Math.abs(norm - 135) < 2) return 'Diagonal';
        if (norm < 90)                 return 'Acute';
        return 'Obtuse';
    },

    // ── The annotation is its points ──────────────────────────
    //
    //   The vertex list on data-gx-measure is the annotation's SOURCE OF
    //   TRUTH; the child SVG is a rendering of it. That is what lets a node
    //   drag work the way it does on a wire: move a point, re-render, and
    //   every derived label recomputes instead of going stale.

    _isMeasureAnnotation(el) {
        return !!el?.classList?.contains?.('measure-annotation');
    },

    _measureMeta(g) {
        try { return JSON.parse(g.getAttribute('data-gx-measure') || '{}'); }
        catch (_) { return {}; }
    },

    /** Vertices in the annotation's own coordinate space. */
    _measureAnnPoints(g) {
        const pts = this._measureMeta(g).points;
        return Array.isArray(pts) && pts.length >= 2 ? pts : null;
    },

    /** Vertices in document space — what the selection handles need. */
    _measureAnnPointsDoc(g) {
        const pts = this._measureAnnPoints(g);
        if (!pts) return null;
        const m = this._elToDoc(g);
        if (m.isIdentity) return pts.map(p => ({ x: p.x, y: p.y }));
        return pts.map(p => {
            const t = new DOMPoint(p.x, p.y).matrixTransform(m);
            return { x: t.x, y: t.y };
        });
    },

    _setMeasureAnnPoints(g, pts) {
        const meta = this._measureMeta(g);
        meta.points = pts.map(p => ({ x: p.x, y: p.y }));
        meta.value = this._measureChainStats(pts).total;
        g.setAttribute('data-gx-measure', JSON.stringify(meta));
        this._renderMeasureAnnotation(g);
    },

    /** Move one vertex (document space in, element space stored). */
    moveMeasurePoint(g, index, docX, docY) {
        const pts = this._measureAnnPoints(g);
        if (!pts || index < 0 || index >= pts.length) return;
        const inv = this._docToEl(g);
        const lp = inv.isIdentity ? { x: docX, y: docY }
                                  : new DOMPoint(docX, docY).matrixTransform(inv);
        pts[index] = { x: lp.x, y: lp.y };
        this._setMeasureAnnPoints(g, pts);
    },

    /** Insert a vertex on the segment nearest a document-space point. */
    splitMeasureAt(g, docPt) {
        const pts = this._measureAnnPoints(g);
        if (!pts) return false;
        const docPts = this._measureAnnPointsDoc(g);
        let best = -1, bestD = Infinity, bestT = 0;
        for (let i = 0; i < docPts.length - 1; i++) {
            const a = docPts[i], b = docPts[i + 1];
            const vx = b.x - a.x, vy = b.y - a.y;
            const len2 = vx * vx + vy * vy;
            let t = len2 ? ((docPt.x - a.x) * vx + (docPt.y - a.y) * vy) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(a.x + vx * t - docPt.x, a.y + vy * t - docPt.y);
            if (d < bestD) { bestD = d; best = i; bestT = t; }
        }
        if (best < 0) return false;
        const before = this._captureFullState();
        const a = pts[best], b = pts[best + 1];
        pts.splice(best + 1, 0, { x: a.x + (b.x - a.x) * bestT, y: a.y + (b.y - a.y) * bestT });
        this._setMeasureAnnPoints(g, pts);
        this.pushHistory('Split Measurement', before, this._captureFullState());
        this._renderHandles?.();
        return true;
    },

    // ── Annotation construction ───────────────────────────────
    //
    //   Sizes are in DOCUMENT units, not divided by the current zoom. The old
    //   overlay baked the zoom-at-creation into every size, so a measurement
    //   taken at 4x was microscopic back at 1x.

    _measureGroup(meta) {
        const NS = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const g = document.createElementNS(NS, 'g');
        g.id = `measure_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        g.setAttribute('class', 'measure-annotation');
        // Decoration, never a wire — keeps measurements out of the netlist.
        g.setAttribute('data-geo-class', 'ink');
        g.setAttribute('data-gx-measure', JSON.stringify(meta || {}));
        return g;
    },

    _buildMeasureAnnotation(points) {
        if (!points || points.length < 2) return null;
        if (this._measureChainStats(points).raw < 0.5) return null;
        const g = this._measureGroup({
            kind: 'chain',
            points: points.map(p => ({ x: p.x, y: p.y })),
            unit: this._measureUnit || 'px',
        });
        this._renderMeasureAnnotation(g);
        return g;
    },

    /** Rebuild the annotation's children from its vertex list. */
    _renderMeasureAnnotation(g) {
        const NS = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const pts = this._measureAnnPoints(g);
        if (!pts) return;
        while (g.firstChild) g.removeChild(g.firstChild);

        const TICK = 8, OFF = 14, FONT = 11, SMALL = 9;
        const chain = this._measureChainStats(pts);
        const multi = pts.length > 2;

        const el = (tag, cls, attrs, text) => {
            const n = document.createElementNS(NS, tag);
            if (cls) n.setAttribute('class', cls);
            Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
            if (text != null) n.textContent = text;
            g.appendChild(n);
            return n;
        };

        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const seg = this._measureSegStats(a, b);
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            const perp = ang + Math.PI / 2;

            el('line', 'measure-tape measure-tape-final',
               { x1: a.x, y1: a.y, x2: b.x, y2: b.y });

            // Per-segment length. On a chain this is the useful number; the
            // total gets its own label at the end.
            el('text', 'measure-hud measure-hud-dist', {
                x: (a.x + b.x) / 2 + Math.cos(perp) * -OFF,
                y: (a.y + b.y) / 2 + Math.sin(perp) * -OFF,
                'text-anchor': 'middle', 'font-size': multi ? SMALL : FONT,
            }, seg.dist);

            [a, b].forEach(pt => el('line', 'measure-tape', {
                x1: pt.x + Math.cos(perp) * TICK, y1: pt.y + Math.sin(perp) * TICK,
                x2: pt.x - Math.cos(perp) * TICK, y2: pt.y - Math.sin(perp) * TICK,
            }));
        }

        pts.forEach(pt => el('circle', 'measure-point', { cx: pt.x, cy: pt.y, r: 3.5 }));

        // Bearing at the start, turn angle at each interior vertex.
        const first = this._measureSegStats(pts[0], pts[1]);
        this._appendAngleArc(g, pts[0], Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x), first.raw);
        el('text', 'measure-hud measure-hud-angle',
           { x: pts[0].x + 18, y: pts[0].y - 9, 'font-size': SMALL },
           `${first.angleAbs}° ${first.angleClass}`);

        for (let i = 1; i < pts.length - 1; i++) {
            const inA = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
            const outA = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
            let turn = (outA - inA) * 180 / Math.PI;
            turn -= 360 * Math.round(turn / 360);
            el('text', 'measure-hud measure-hud-angle',
               { x: pts[i].x + 12, y: pts[i].y - 8, 'font-size': SMALL },
               `${turn >= 0 ? '+' : ''}${turn.toFixed(0)}°`);
        }

        const last = pts[pts.length - 1];
        if (multi) {
            el('text', 'measure-hud measure-hud-dist',
               { x: last.x + 12, y: last.y + 14, 'font-size': FONT }, `Σ ${chain.total}`);
        } else {
            const a = pts[0], b = pts[1];
            if (Math.abs(b.x - a.x) > 2) {
                el('text', 'measure-hud measure-hud-delta', {
                    x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + 16,
                    'text-anchor': 'middle', 'font-size': SMALL,
                }, `Δx ${chain.dx}`);
            }
            if (Math.abs(b.y - a.y) > 2) {
                el('text', 'measure-hud measure-hud-delta', {
                    x: Math.max(a.x, b.x) + 10, y: (a.y + b.y) / 2 + 3, 'font-size': SMALL,
                }, `Δy ${chain.dy}`);
            }
        }
    },

    _appendAngleArc(g, a, angle, dist) {
        const NS = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const R = Math.min(dist * 0.18, 28);
        if (R <= 4) return;
        const arc = document.createElementNS(NS, 'path');
        arc.setAttribute('class', 'measure-angle-arc');
        arc.setAttribute('d',
            `M ${a.x + R} ${a.y} A ${R} ${R} 0 ${Math.abs(angle) > Math.PI ? 1 : 0} ` +
            `${Math.sin(angle) >= 0 ? 1 : 0} ${a.x + R * Math.cos(angle)} ${a.y + R * Math.sin(angle)}`);
        g.appendChild(arc);
    },

    _appendCallout(g, x, y, text) {
        const NS = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const W = 96, H = 20;
        const bg = document.createElementNS(NS, 'rect');
        bg.setAttribute('class', 'measure-callout-bg');
        bg.setAttribute('x', x - W / 2); bg.setAttribute('y', y - H - 4);
        bg.setAttribute('width', W); bg.setAttribute('height', H);
        bg.setAttribute('rx', 3);
        g.appendChild(bg);
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('class', 'measure-hud measure-hud-dist');
        t.setAttribute('x', x); t.setAttribute('y', y - 8);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('font-size', 10);
        t.textContent = text;
        g.appendChild(t);
    },

    // ── Live preview ──────────────────────────────────────────
    //   Transient and system-owned: excluded from history, export and
    //   selection, unlike the committed annotation.

    _measurePreviewLayer() {
        let g = this._contentRoot?.querySelector('.measure-preview');
        if (!g) {
            const NS = this.SVG_NS || 'http://www.w3.org/2000/svg';
            g = document.createElementNS(NS, 'g');
            g.setAttribute('class', 'measure-preview');
            g.dataset.seSystem = 'true';
            g.setAttribute('pointer-events', 'none');
            this._contentRoot?.appendChild(g);
        }
        return g;
    },

    _clearMeasurePreview() {
        this._contentRoot?.querySelectorAll('.measure-preview').forEach(el => el.remove());
    },

    // Committed waypoints plus a ghost segment to the cursor. Distance, angle
    // and deltas update on every move, not only once the chain is finished.
    _drawMeasurePreview(committed, cursor) {
        const NS = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const g = this._measurePreviewLayer();
        g.innerHTML = '';
        if (!committed.length) return;

        const pts = committed.concat(
            cursor && cursor !== committed[committed.length - 1] ? [cursor] : []);

        const el = (tag, cls, attrs, text) => {
            const n = document.createElementNS(NS, tag);
            if (cls) n.setAttribute('class', cls);
            Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
            if (text != null) n.textContent = text;
            g.appendChild(n);
            return n;
        };

        pts.forEach((p, i) => el('circle',
            'measure-point ' + (i === 0 ? 'measure-point-a' : 'measure-point-b'),
            { cx: p.x, cy: p.y, r: 4 }));

        if (pts.length < 2) return;
        for (let i = 0; i < pts.length - 1; i++) {
            el('line', 'measure-tape',
               { x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
        }

        const a = pts[pts.length - 2], b = pts[pts.length - 1];
        const seg = this._measureSegStats(a, b);
        const chain = this._measureChainStats(pts);
        const perp = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;

        this._appendAngleArc(g, a, Math.atan2(b.y - a.y, b.x - a.x), seg.raw);

        el('text', 'measure-hud measure-hud-dist', {
            x: (a.x + b.x) / 2 + Math.cos(perp) * -14,
            y: (a.y + b.y) / 2 + Math.sin(perp) * -14,
            'text-anchor': 'middle', 'font-size': 11,
        }, seg.dist);

        el('text', 'measure-hud measure-hud-angle',
           { x: b.x + 12, y: b.y - 10, 'font-size': 9 },
           `∠${seg.angleAbs}° ${seg.angleClass}  ·  Δx ${this._formatMeasureResult(Math.abs(seg.dx))}` +
           `  Δy ${this._formatMeasureResult(Math.abs(seg.dy))}` +
           (pts.length > 2 ? `  ·  Σ ${chain.total}` : ''));
    },

    // Legacy name kept: other modules call it on teardown.
    _clearMeasureTape() {
        this._clearMeasurePreview();
        this._contentRoot?.querySelectorAll('.measure-overlay').forEach(el => el.remove());
        this._measureOverlay = null;
    },

    // Remove every committed measurement from the document.
    clearMeasurements() {
        const found = this._contentRoot?.querySelectorAll('.measure-annotation') || [];
        if (!found.length) { this.showToast('No measurements to clear', 'error'); return; }
        const before = this._captureFullState();
        found.forEach(el => el.remove());
        this.pushHistory('Clear Measurements', before, this._captureFullState());
        this.showToast(`Cleared ${found.length} measurement${found.length > 1 ? 's' : ''}`, 'success');
        if (typeof this.buildLayersTree === 'function') this.buildLayersTree();
    },
});
