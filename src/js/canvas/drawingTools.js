/* ============================================================
   Schematics Editor — Drawing Tools
   Pen, Line, Rectangle, Ellipse, Polygon, Text
   Each tool: preview on drag → commit on mouseup/dblclick
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Tool activation ───────────────────────────────────────
    initDrawingTools() {
        this._drawState = null;   // active draw operation
        this._drawPreview = null;   // ghost/preview element
        this._toolLock = false;   // Q toggles: keep the drawing tool active after a commit

        // Default style for new elements
        this._drawStyle = {
            stroke: '#4facfe',
            strokeWidth: '2',
            fill: 'none',
            fillOpacity: '1',
            strokeDasharray: 'none',
        };

        // Wire endpoint styles (draw.io-style relational endpoints)
        this._wireEndStyle = { start: 'none', end: 'none' };

        this._bindDrawEvents();
        this._bindPenPointerEvents();
    },

    // ── Wire endpoint markers ─────────────────────────────────
    _WIRE_END_STYLES: ['none', 'arrow', 'triangle', 'diamond', 'circle', 'many'],

    _ensureWireMarkers() {
        const svg = this.$svgDisplay[0];
        if (svg.querySelector('#_gxWireMarkers')) return;
        const defs = document.createElementNS(this.SVG_NS, 'defs');
        defs.id = '_gxWireMarkers';
        defs.dataset.seSystem = 'true';
        // context-stroke inherits the wire's stroke color (falls back to #666)
        const shapes = {
            arrow:    '<path d="M0,0 L8,4 L0,8" fill="none" stroke="context-stroke"/>',
            triangle: '<path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"/>',
            diamond:  '<path d="M0,4 L4,0 L8,4 L4,8 Z" fill="context-stroke"/>',
            circle:   '<circle cx="4" cy="4" r="3" fill="context-stroke"/>',
            many:     '<path d="M8,0 L0,4 L8,8 M0,4 L8,4" fill="none" stroke="context-stroke"/>',
        };
        defs.innerHTML = Object.entries(shapes).map(([k, body]) =>
            `<marker id="gxw-${k}" viewBox="0 0 8 8" refX="7" refY="4" ` +
            `markerWidth="8" markerHeight="8" orient="auto-start-reverse" ` +
            `markerUnits="strokeWidth">${body}</marker>`
        ).join('');
        svg.insertBefore(defs, svg.firstChild);
    },

    _applyWireEndMarkers(el) {
        const { start, end } = this._wireEndStyle;
        if (start === 'none' && end === 'none') return;
        this._ensureWireMarkers();
        if (start !== 'none') el.setAttribute('marker-start', `url(#gxw-${start})`);
        if (end   !== 'none') el.setAttribute('marker-end',   `url(#gxw-${end})`);
    },

    // Small floating picker shown only while the wire tool is active
    _toggleWireStyleBar(show) {
        let bar = document.getElementById('gxWireStyleBar');
        if (!show) { bar?.remove(); return; }
        if (bar) return;
        bar = document.createElement('div');
        bar.id = 'gxWireStyleBar';
        const labels = { none: '— none', arrow: '→ arrow', triangle: '▶ triangle',
                         diamond: '◆ diamond', circle: '● circle', many: '⑃ many (crow\'s foot)' };
        const opts = this._WIRE_END_STYLES.map(s => `<option value="${s}">${labels[s]}</option>`).join('');
        bar.innerHTML =
            `<label>Start <select data-endpoint="start">${opts}</select></label>` +
            `<label>End <select data-endpoint="end">${opts}</select></label>`;
        bar.style.cssText =
            'position:fixed;bottom:118px;left:50%;transform:translateX(-50%);display:flex;gap:12px;' +
            'padding:6px 12px;background:rgba(20,24,32,.92);color:#dfe6ee;' +
            'border:1px solid rgba(255,255,255,.14);border-radius:8px;font-size:12px;z-index:900;';
        bar.querySelectorAll('select').forEach(sel => {
            sel.value = this._wireEndStyle[sel.dataset.endpoint];
            sel.addEventListener('change', () => {
                this._wireEndStyle[sel.dataset.endpoint] = sel.value;
            });
        });
        document.body.appendChild(bar);
    },

    // A tool is a one-shot action, not a mode: after it draws something it hands
    // the canvas back to select so the next click manipulates what was just made.
    // Q pins the tool for repeat drawing (Excalidraw's tool lock).
    _DRAW_TOOLS: ['pen', 'line', 'rect', 'ellipse', 'polygon', 'text', 'wire'],

    // Tools that manipulate existing objects rather than creating them.
    _OBJECT_TOOLS: ['select'],

    _isObjectTool() { return this._OBJECT_TOOLS.includes(this.activeTool); },

    _revertToSelectTool() {
        if (this._toolLock) return;
        if (this.activeTool === 'select') return;
        if (!this._DRAW_TOOLS.includes(this.activeTool)) return;
        this.setActiveTool('select', { silent: true });
    },

    toggleToolLock() {
        this._toolLock = !this._toolLock;
        $('#toolLockBtn').toggleClass('active', this._toolLock);
        this.showToast(this._toolLock
            ? 'Tool lock ON — the active tool stays selected after each draw'
            : 'Tool lock OFF — tools return to select after one draw', 'success');
    },

    setActiveTool(tool, { silent = false } = {}) {
        this.activeTool = tool;

        // Update toolbar active state
        $('.draw-tool-btn').removeClass('active');
        $(`#tool_${tool}`).addClass('active');

        // Cursor
        const cursors = {
            select: 'default',
            hand: 'grab',
            pen: 'crosshair',
            line: 'crosshair',
            rect: 'crosshair',
            ellipse: 'crosshair',
            polygon: 'crosshair',
            text: 'text',
            wire: 'crosshair',
        };
        this.$svgContainer.css('cursor', cursors[tool] || 'default');

        // If leaving draw mode, cancel any in-progress draw
        if (!this._DRAW_TOOLS.includes(tool)) {
            this._cancelDraw();
        }

        // Wire endpoint style bar only shows while the wire tool is active
        this._toggleWireStyleBar?.(tool === 'wire');

        // Quick usage hint per tool (Excalidraw-style)
        const hints = {
            select:  'Select — click an item, drag empty canvas to marquee, dbl-click enters a group. Hold Space to pan',
            hand:    'Hand — drag anywhere to pan the canvas (H). Holding Space picks this up temporarily',
            pen:     'Pen — draw freehand; strokes smooth on release. Esc cancels',
            line:    'Line — drag from start to end; snaps to grid and edges',
            rect:    'Rectangle — drag a corner to the opposite corner',
            ellipse: 'Ellipse — drag from center outward',
            polygon: 'Polygon — click each vertex, double-click to close',
            text:    'Text — click to place, then type in the panel',
            wire:    'Wire — click waypoints, dbl-click/Enter commits, Esc cancels. Pick endpoint style below',
        };
        if (silent) return;
        const suffix = (!this._toolLock && this._DRAW_TOOLS.includes(tool))
            ? '  ·  Q locks the tool for repeat draws'
            : '';
        this.showToast((hints[tool] || tool) + suffix, 'success');
    },

    // ── Main draw event binding ───────────────────────────────
    _bindDrawEvents() {
        this.$svgContainer.on('mousedown.draw', (e) => {
            const drawTools = ['pen', 'line', 'rect', 'ellipse', 'polygon', 'text', 'wire'];
            if (!drawTools.includes(this.activeTool)) return;
            if (this.activeTool === 'pen') return;   // pen uses pointer events (capture + coalescing)
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const pt = this.screenToSVG(e.clientX, e.clientY);
            const snapped = this.smartSnap(pt.x, pt.y);

            switch (this.activeTool) {
                case 'line': this._lineStart(snapped); break;
                case 'rect': this._rectStart(snapped); break;
                case 'ellipse': this._ellipseStart(snapped); break;
                case 'polygon': this._polygonClick(snapped); break;
                case 'text': this._textPlace(snapped); break;
                case 'wire': this._wireClick(snapped); break;
            }
        });

        $(document).on('mousemove.draw', (e) => {
            if (!this._drawState) return;
            const pt = this.screenToSVG(e.clientX, e.clientY);
            const snapped = this.smartSnap(pt.x, pt.y);

            switch (this.activeTool) {
                case 'line': this._lineMove(snapped); break;
                case 'rect': this._rectMove(snapped); break;
                case 'ellipse': this._ellipseMove(snapped); break;
                case 'wire': this._wireMove(snapped); break;
            }
        });

        $(document).on('mouseup.draw', (e) => {
            if (!this._drawState) return;

            switch (this.activeTool) {
                case 'line': this._lineEnd(); break;
                case 'rect': this._rectEnd(); break;
                case 'ellipse': this._ellipseEnd(); break;
                // wire: click-to-commit; no action on mouseup (committed by dblclick/Enter)
            }
        });

        // Double-click: finish polygon or commit wire
        this.$svgContainer.on('dblclick.draw', (e) => {
            if (!this._drawState) return;
            e.preventDefault();
            if (this.activeTool === 'polygon') this._polygonClose();
            if (this.activeTool === 'wire')    this._wireCommit(e.clientX, e.clientY);
        });

        // Escape cancels; Enter commits; Backspace retracts last waypoint.
        // (Escape also drops back to the select tool — owned by the global
        // keydown handler in svgEditor.js, unconditionally, lock or no lock.)
        $(document).on('keydown.draw', (e) => {
            if (!this._drawState) return;
            if (e.key === 'Escape') { e.preventDefault(); this._cancelDraw(); }
            if (e.key === 'Enter' && this.activeTool === 'wire') { e.preventDefault(); this._wireCommit(); }
            if (e.key === 'Backspace' && this.activeTool === 'wire' && this._drawState.points?.length > 1) {
                e.preventDefault();
                this._drawState.points.pop();
                this._drawState.pinTo = null;
                this._clearPinSnap();
                const d = this._wirePathFromPoints(this._drawState.points);
                this._drawPreview?.setAttribute('d', d);
            }
        });
    },

    // ── Drawing style helpers ─────────────────────────────────
    _applyDrawStyle(el) {
        const s = this._drawStyle;
        el.setAttribute('stroke', s.stroke);
        el.setAttribute('stroke-width', s.strokeWidth);
        el.setAttribute('fill', s.fill);
        if (s.fill !== 'none') el.setAttribute('fill-opacity', s.fillOpacity);
        if (s.strokeDasharray !== 'none') el.setAttribute('stroke-dasharray', s.strokeDasharray);
        // Bake into the SVG attribute so exported files render consistently
        el.setAttribute('vector-effect', 'non-scaling-stroke');
    },

    _makePreview(tagName) {
        this._drawPreview?.remove();
        const el = document.createElementNS(this.SVG_NS, tagName);
        el.classList.add('draw-preview');
        el.setAttribute('pointer-events', 'none');
        this._applyDrawStyle(el);
        this._contentRoot.appendChild(el);
        this._drawPreview = el;
        return el;
    },

    _commitElement(el) {
        this._drawPreview?.remove();
        this._drawPreview = null;
        // Assign unique id
        el.id = `el_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        this._applyDrawStyle(el);
        // Tag lines/wires as geo wires in electrical mode for live GeoEngine analysis.
        // Pen strokes are ink — never wires/components — so doodles can't pollute the netlist.
        if (this.activeTool === 'pen') {
            el.setAttribute('data-geo-class', 'ink');
        } else if (this.activeMode === 'electrical') {
            const wireTools = new Set(['line', 'wire']);
            el.setAttribute('data-geo-class', wireTools.has(this.activeTool) ? 'wire' : 'component');
        }
        this._contentRoot.appendChild(el);
        const after = this._captureFullState();
        this.pushHistory('Draw', this._drawState?.before || '', after);
        this._drawState = null;
        this.selectEl(el);
        this._refreshPropertyPanel();
        if (typeof this.buildLayersTree === 'function') this.buildLayersTree();
        if (typeof this._scheduleGeoAnalysis === 'function') this._scheduleGeoAnalysis();
        this._revertToSelectTool();
        return el;
    },

    _cancelDraw() {
        this._drawPreview?.remove();
        this._drawPreview = null;
        this._drawState = null;
        this._penStroke = null;
    },

    // ── PEN (freehand) ────────────────────────────────────────
    // Pointer events (not mouse): setPointerCapture keeps the stroke alive
    // when the cursor leaves the container, getCoalescedEvents gives full-rate
    // sampling on high-Hz input. Points are NEVER grid-snapped mid-stroke;
    // on commit the stroke is RDP-simplified then rendered as a true
    // Catmull-Rom spline (cubic beziers), so freehand no longer staircases.
    _bindPenPointerEvents() {
        const container = this.$svgContainer[0];
        this._penStroke = null;

        container.addEventListener('pointerdown', (e) => {
            if (this.activeTool !== 'pen') return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            try { container.setPointerCapture(e.pointerId); } catch (_) {}
            container.style.touchAction = 'none';

            const pt = this.screenToSVG(e.clientX, e.clientY);
            this._penStroke = {
                pointerId: e.pointerId,
                before: this._captureFullState(),
                points: [pt],
                minDist: 0.75 / (this.zoom || 1),
            };
            this._drawState = this._penStroke;   // lets Escape (_cancelDraw) abort the stroke
            const el = this._makePreview('path');
            el.setAttribute('d', `M ${pt.x} ${pt.y}`);
        });

        container.addEventListener('pointermove', (e) => {
            const s = this._penStroke;
            if (!s || e.pointerId !== s.pointerId || !this._drawState) return;
            const events = e.getCoalescedEvents?.() || [e];
            let added = false;
            for (const ev of events) {
                const pt = this.screenToSVG(ev.clientX, ev.clientY);
                const last = s.points[s.points.length - 1];
                if (Math.hypot(pt.x - last.x, pt.y - last.y) < s.minDist) continue;
                s.points.push(pt);
                added = true;
            }
            if (added && this._drawPreview) {
                this._drawPreview.setAttribute('d', this._catmullRomPath(s.points));
            }
        });

        const finish = (e) => {
            const s = this._penStroke;
            if (!s || e.pointerId !== s.pointerId) return;
            try { container.releasePointerCapture(e.pointerId); } catch (_) {}
            container.style.touchAction = '';
            this._penStroke = null;
            if (!this._drawState || s.points.length < 2) { this._cancelDraw(); return; }

            const simplified = this._rdpSimplify(s.points, s.minDist);
            const el = document.createElementNS(this.SVG_NS, 'path');
            el.setAttribute('d', this._catmullRomPath(simplified));
            el.setAttribute('data-ink', 'true');
            this._commitElement(el);
        };
        container.addEventListener('pointerup', finish);
        container.addEventListener('pointercancel', finish);
    },

    // Ramer–Douglas–Peucker simplification (iterative, stack-based).
    _rdpSimplify(pts, eps) {
        if (pts.length < 3) return pts;
        const keep = new Uint8Array(pts.length);
        keep[0] = keep[pts.length - 1] = 1;
        const stack = [[0, pts.length - 1]];
        while (stack.length) {
            const [a, b] = stack.pop();
            const A = pts[a], B = pts[b];
            const dx = B.x - A.x, dy = B.y - A.y;
            const len = Math.hypot(dx, dy) || 1e-9;
            let maxDist = 0, maxIdx = -1;
            for (let i = a + 1; i < b; i++) {
                const d = Math.abs(dy * (pts[i].x - A.x) - dx * (pts[i].y - A.y)) / len;
                if (d > maxDist) { maxDist = d; maxIdx = i; }
            }
            if (maxDist > eps && maxIdx > 0) {
                keep[maxIdx] = 1;
                stack.push([a, maxIdx], [maxIdx, b]);
            }
        }
        return pts.filter((_, i) => keep[i]);
    },

    // Catmull-Rom spline through all points, emitted as cubic beziers.
    _catmullRomPath(pts) {
        if (!pts.length) return '';
        const r = (n) => Math.round(n * 100) / 100;
        if (pts.length === 1) return `M ${r(pts[0].x)} ${r(pts[0].y)}`;
        if (pts.length === 2) return `M ${r(pts[0].x)} ${r(pts[0].y)} L ${r(pts[1].x)} ${r(pts[1].y)}`;
        let d = `M ${r(pts[0].x)} ${r(pts[0].y)}`;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] || pts[i];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = pts[i + 2] || p2;
            d += ` C ${r(p1.x + (p2.x - p0.x) / 6)} ${r(p1.y + (p2.y - p0.y) / 6)}`
               + ` ${r(p2.x - (p3.x - p1.x) / 6)} ${r(p2.y - (p3.y - p1.y) / 6)}`
               + ` ${r(p2.x)} ${r(p2.y)}`;
        }
        return d;
    },

    // ── LINE ──────────────────────────────────────────────────
    _lineStart(pt) {
        this._drawState = {
            before: this._captureFullState(),
            x1: pt.x, y1: pt.y,
        };
        const el = this._makePreview('line');
        el.setAttribute('x1', pt.x); el.setAttribute('y1', pt.y);
        el.setAttribute('x2', pt.x); el.setAttribute('y2', pt.y);
    },

    _lineMove(pt) {
        if (!this._drawPreview) return;
        this._drawPreview.setAttribute('x2', pt.x);
        this._drawPreview.setAttribute('y2', pt.y);
    },

    _lineEnd() {
        if (!this._drawState) return;
        const p = this._drawPreview;
        if (
            parseFloat(p.getAttribute('x1')) === parseFloat(p.getAttribute('x2')) &&
            parseFloat(p.getAttribute('y1')) === parseFloat(p.getAttribute('y2'))
        ) { this._cancelDraw(); return; }

        const el = document.createElementNS(this.SVG_NS, 'line');
        el.setAttribute('x1', p.getAttribute('x1'));
        el.setAttribute('y1', p.getAttribute('y1'));
        el.setAttribute('x2', p.getAttribute('x2'));
        el.setAttribute('y2', p.getAttribute('y2'));
        this._commitElement(el);
    },

    // ── RECTANGLE ─────────────────────────────────────────────
    _rectStart(pt) {
        this._drawState = {
            before: this._captureFullState(),
            x: pt.x, y: pt.y,
        };
        const el = this._makePreview('rect');
        el.setAttribute('x', pt.x); el.setAttribute('y', pt.y);
        el.setAttribute('width', '0'); el.setAttribute('height', '0');
    },

    _rectMove(pt) {
        if (!this._drawPreview || !this._drawState) return;
        const x = Math.min(this._drawState.x, pt.x);
        const y = Math.min(this._drawState.y, pt.y);
        const w = Math.abs(pt.x - this._drawState.x);
        const h = Math.abs(pt.y - this._drawState.y);
        this._drawPreview.setAttribute('x', x);
        this._drawPreview.setAttribute('y', y);
        this._drawPreview.setAttribute('width', w);
        this._drawPreview.setAttribute('height', h);
    },

    _rectEnd() {
        if (!this._drawState) return;
        const p = this._drawPreview;
        if (parseFloat(p.getAttribute('width')) < 4 ||
            parseFloat(p.getAttribute('height')) < 4) { this._cancelDraw(); return; }

        const el = document.createElementNS(this.SVG_NS, 'rect');
        ['x', 'y', 'width', 'height'].forEach(a => el.setAttribute(a, p.getAttribute(a)));
        this._commitElement(el);
    },

    // ── ELLIPSE ───────────────────────────────────────────────
    _ellipseStart(pt) {
        this._drawState = {
            before: this._captureFullState(),
            cx: pt.x, cy: pt.y,
        };
        const el = this._makePreview('ellipse');
        el.setAttribute('cx', pt.x); el.setAttribute('cy', pt.y);
        el.setAttribute('rx', '0'); el.setAttribute('ry', '0');
    },

    _ellipseMove(pt) {
        if (!this._drawPreview || !this._drawState) return;
        const rx = Math.abs(pt.x - this._drawState.cx);
        const ry = Math.abs(pt.y - this._drawState.cy);
        this._drawPreview.setAttribute('rx', rx);
        this._drawPreview.setAttribute('ry', ry);
    },

    _ellipseEnd() {
        if (!this._drawState) return;
        const p = this._drawPreview;
        if (parseFloat(p.getAttribute('rx')) < 2 ||
            parseFloat(p.getAttribute('ry')) < 2) { this._cancelDraw(); return; }

        const el = document.createElementNS(this.SVG_NS, 'ellipse');
        ['cx', 'cy', 'rx', 'ry'].forEach(a => el.setAttribute(a, p.getAttribute(a)));
        this._commitElement(el);
    },

    // ── POLYGON (click vertices, dblclick to close) ───────────
    _polygonClick(pt) {
        if (!this._drawState) {
            this._drawState = {
                before: this._captureFullState(),
                points: [pt],
            };
            const el = this._makePreview('polyline');
            el.setAttribute('points', `${pt.x},${pt.y}`);
        } else {
            this._drawState.points.push(pt);
            const pts = this._drawState.points.map(p => `${p.x},${p.y}`).join(' ');
            this._drawPreview.setAttribute('points', pts);
        }
    },

    _polygonClose() {
        if (!this._drawState || this._drawState.points.length < 3) {
            this._cancelDraw(); return;
        }
        const el = document.createElementNS(this.SVG_NS, 'polygon');
        el.setAttribute('points',
            this._drawState.points.map(p => `${p.x},${p.y}`).join(' ')
        );
        this._commitElement(el);
    },

    // ── TEXT ──────────────────────────────────────────────────
    _textPlace(pt) {
        const before = this._captureFullState();
        const NS = this.SVG_NS;

        const el = document.createElementNS(NS, 'text');
        el.setAttribute('x', pt.x);
        el.setAttribute('y', pt.y);
        el.setAttribute('font-family', 'Inter, sans-serif');
        el.setAttribute('font-size', '14');
        el.setAttribute('fill', this._drawStyle.stroke);
        el.textContent = 'Text';
        el.id = `el_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        this._contentRoot.appendChild(el);

        this.pushHistory('Text', before, this._captureFullState());
        this.selectEl(el);
        this._refreshPropertyPanel();
        // Immediately open edit in property panel
        setTimeout(() => this._startInlineTextEdit(el), 50);
        this._revertToSelectTool();
    },

    _startInlineTextEdit(textEl) {
        // Focus text content input in property panel
        const $input = $('#prop-text-content');
        if ($input.length) {
            $input.val(textEl.textContent).trigger('focus').trigger('select');
        }
    },

    // ── WIRE (click-to-commit, Manhattan routing, snap-to-port) ──
    //   Click: add waypoint.  Dblclick / Enter: commit.  Escape: cancel.
    //   _smoothTrace toggles Manhattan vs straight mid-draw without restart.
    _wireClick(pt) {
        const snapped = this._wireSnapToPort(pt);
        const pin = this._lastSnappedPin;
        const pinInfo = pin ? {
            symId: pin.closest('.domain-symbol')?.id ?? null,
            pinId: pin.dataset.pin ?? '0',
        } : null;

        if (!this._drawState) {
            // First click — start a new wire, record origin pin
            this._drawState = {
                before: this._captureFullState(),
                tool: 'wire',
                points: [snapped],
                pinFrom: pinInfo,
                pinTo: null,
            };
            const el = this._makePreview('path');
            el.setAttribute('d', `M ${snapped.x} ${snapped.y}`);
            el.setAttribute('stroke', this._drawStyle.stroke || '#4facfe');
            el.setAttribute('stroke-width', '2');
            el.setAttribute('fill', 'none');
        } else {
            // Subsequent clicks — add waypoint, update terminal pin (last click wins)
            this._drawState.points.push(snapped);
            this._drawState.pinTo = pinInfo;
            const d = this._wirePathFromPoints(this._drawState.points);
            this._drawPreview?.setAttribute('d', d);
            // Landing on a pin terminates the wire — every EDA auto-commits here,
            // and making the user press Enter after reaching a pin reads as a bug.
            if (pinInfo) this._wireCommit();
        }
    },

    _wireMove(pt) {
        if (!this._drawPreview || !this._drawState) return;
        const snapped = this._wireSnapToPort(pt);
        const snapPin = this._lastSnappedPin;

        // Highlight pin being approached
        this._contentRoot?.querySelectorAll('.pin-point.pin-snap').forEach(p => {
            if (p !== snapPin) p.classList.remove('pin-snap');
        });
        if (snapPin) snapPin.classList.add('pin-snap');

        // Live preview: committed waypoints + ghost segment to cursor
        const d = this._wirePathFromPoints([...this._drawState.points, snapped]);
        this._drawPreview.setAttribute('d', d);
    },

    // clientX/Y supplied by dblclick handler; undefined when committed via Enter key.
    _wireCommit(clientX, clientY) {
        if (!this._drawState || !this._drawState.points || this._drawState.points.length < 2) {
            this._cancelDraw(); return;
        }
        const { points, pinFrom, pinTo } = this._drawState;
        // Degenerate wire (double-click on one pin) — nothing to keep
        const span = points.reduce((s, p) =>
            Math.max(s, Math.hypot(p.x - points[0].x, p.y - points[0].y)), 0);
        if (span < 2) { this._cancelDraw(); return; }
        const lastPt = points[points.length - 1];

        const d = this._wirePathFromPoints(points);
        const el = document.createElementNS(this.SVG_NS, 'path');
        el.setAttribute('d', d);
        el.setAttribute('fill', 'none');
        this._applyWireEndMarkers(el);

        // Store pin-connection metadata so wires can follow symbols when dragged
        if (pinFrom?.symId) {
            el.setAttribute('data-from-sym', pinFrom.symId);
            el.setAttribute('data-from-pin', pinFrom.pinId);
        }
        if (pinTo?.symId) {
            el.setAttribute('data-to-sym', pinTo.symId);
            el.setAttribute('data-to-pin', pinTo.pinId);
        }

        this._commitElement(el);
        // T-junction: if the terminal point lands on another wire's body, split it
        this._checkWireTJunction?.(el, lastPt);
        this._clearPinSnap();

        // Only show picker when the terminal end is dangling (no symbol snapped)
        if (clientX != null && !pinTo?.symId) {
            this._showSymbolPicker(lastPt, el, clientX, clientY);
        }
    },

    // Build SVG path string from waypoints.  Manhattan mode reads _smoothTrace live
    // so toggling mid-draw immediately reflects in the preview.
    _wirePathFromPoints(pts) {
        if (!pts.length) return '';
        let d = `M ${pts[0].x} ${pts[0].y}`;
        for (let i = 1; i < pts.length; i++) {
            const prev = pts[i - 1], curr = pts[i];
            if (this._smoothTrace) {
                d += ` L ${curr.x} ${curr.y}`;
            } else {
                // Manhattan: horizontal-first elbow
                d += ` L ${prev.x} ${curr.y} L ${curr.x} ${curr.y}`;
            }
        }
        return d;
    },

    // Snap pt to a nearby .pin-point circle within 16 screen pixels (converted to SVG units
    // at the current zoom so snap radius feels constant regardless of zoom level).
    // Side-effect: sets this._lastSnappedPin to the matched DOM element (or null).
    _wireSnapToPort(pt) {
        // Clamp so the radius can't balloon into a huge world-space area at low zoom
        const THRESHOLD = Math.min(16 / (this.zoom || 1), 32);
        let best = null, bestDist = THRESHOLD, bestPin = null;
        this._contentRoot?.querySelectorAll('.pin-point').forEach(pin => {
            const cx = parseFloat(pin.getAttribute('cx') || 0);
            const cy = parseFloat(pin.getAttribute('cy') || 0);
            // Transform pin center to document-local space via its own CTM chain
            let m = new DOMMatrix();
            let node = pin;
            const svg = this.$svgDisplay[0];
            while (node && node !== svg && node.id !== '_cameraRotGroup') {
                const tv = node.transform?.baseVal;
                if (tv?.length) {
                    const lm = tv.consolidate()?.matrix;
                    if (lm) m = new DOMMatrix([lm.a, lm.b, lm.c, lm.d, lm.e, lm.f]).multiply(m);
                }
                node = node.parentElement;
            }
            const wp = new DOMPoint(cx, cy).matrixTransform(m);
            const dist = Math.hypot(wp.x - pt.x, wp.y - pt.y);
            if (dist < bestDist) { bestDist = dist; best = { x: wp.x, y: wp.y }; bestPin = pin; }
        });
        this._lastSnappedPin = bestPin;
        return best || pt;
    },

    _clearPinSnap() {
        this._contentRoot?.querySelectorAll('.pin-point.pin-snap').forEach(p => p.classList.remove('pin-snap'));
    },

    // ── Symbol picker popover (shown after wire commit to free endpoint) ──
    // seg2Ref is only supplied by _splitWireAtClick (insert-in-series feature):
    // when set, the chosen symbol's exit pin is also wired to seg2's start.
    _showSymbolPicker(svgPt, wirePath, clientX, clientY, seg2Ref = null) {
        let picker = document.getElementById('se-sym-picker');
        if (!picker) {
            picker = document.createElement('div');
            picker.id = 'se-sym-picker';
            picker.className = 'se-sym-picker';
            picker.innerHTML = `
                <div class="se-sym-picker-header">
                    <span class="se-sym-picker-title">Place symbol</span>
                    <input type="text" class="se-sym-picker-search" placeholder="Search…" autocomplete="off" />
                    <button class="se-sym-picker-close" title="Close (Esc)">×</button>
                </div>
                <div class="se-sym-picker-body"></div>
            `;
            document.body.appendChild(picker);
            picker.querySelector('.se-sym-picker-close').addEventListener('click', () => this._closeSymbolPicker());
            picker.querySelector('.se-sym-picker-search').addEventListener('input', (ev) => this._filterSymbolPicker(ev.target.value));
        }

        const body = picker.querySelector('.se-sym-picker-body');
        body.innerHTML = '';
        picker.querySelector('.se-sym-picker-search').value = '';

        const kit = this._domainKits?.[this.activeMode];
        if (!kit?.symbols?.length) return;

        const groups = {};
        kit.symbols.forEach(sym => {
            const g = sym.group || 'General';
            if (!groups[g]) groups[g] = [];
            groups[g].push(sym);
        });

        Object.entries(groups).forEach(([groupName, syms]) => {
            const label = document.createElement('div');
            label.className = 'se-sym-picker-group';
            label.textContent = groupName;
            body.appendChild(label);

            const row = document.createElement('div');
            row.className = 'se-sym-picker-row';
            syms.forEach(sym => {
                const vb = sym.previewViewBox || '0 0 65 52';
                const item = document.createElement('div');
                item.className = 'se-sym-picker-item';
                item.dataset.symId = sym.id;
                item.title = sym.label;
                item.innerHTML = `
                    <div class="se-sym-picker-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="100%" height="100%">${sym.svgPreview}</svg>
                    </div>
                    <div class="se-sym-picker-label">${sym.label}</div>
                `;
                item.addEventListener('click', () => {
                    // Parse the symbol's own SVG to find its pin-point elements (local coords)
                    const symParser = new DOMParser();
                    const symDoc = symParser.parseFromString(
                        `<svg xmlns="http://www.w3.org/2000/svg">${sym.svgContent || sym.svgPreview}</svg>`,
                        'image/svg+xml'
                    );
                    const symPins = [...symDoc.querySelectorAll('.pin-point')];

                    let entryPinCx = 0, entryPinCy = 0, entryPinId = '0';
                    let chosen = symPins[0] || null;

                    if (symPins.length > 0) {
                        // Determine wire approach direction from its last two path coordinates
                        const wireD = wirePath?.getAttribute('d') || '';
                        const wPts = [...wireD.matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/g)]
                            .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));

                        chosen = symPins[0];
                        if (wPts.length >= 2) {
                            // Approach vector: direction the wire was travelling into svgPt
                            const prev = wPts[wPts.length - 2];
                            const adx = prev.x - svgPt.x;
                            const ady = prev.y - svgPt.y;
                            // Pick the pin whose local offset most aligns with the approach direction
                            // (highest dot product = pin faces the incoming wire)
                            let bestDot = -Infinity;
                            symPins.forEach(p => {
                                const dot = adx * parseFloat(p.getAttribute('cx') || 0)
                                          + ady * parseFloat(p.getAttribute('cy') || 0);
                                if (dot > bestDot) { bestDot = dot; chosen = p; }
                            });
                        }

                        entryPinCx = parseFloat(chosen.getAttribute('cx') || 0);
                        entryPinCy = parseFloat(chosen.getAttribute('cy') || 0);
                        entryPinId = chosen.getAttribute('data-pin') ?? '0';
                    }

                    // Offset placement so the entry pin lands exactly on the wire endpoint
                    const placed = this._placeSymbol(sym, svgPt.x - entryPinCx, svgPt.y - entryPinCy);

                    // Link wire's open end directly — no setTimeout, _placeSymbol now returns the element
                    if (placed && wirePath) {
                        wirePath.setAttribute('data-to-sym', placed.id);
                        wirePath.setAttribute('data-to-pin', entryPinId);
                    }

                    // Split-insert: the far half of the cut is deliberately left
                    // alone. Auto-wiring it to the exit pin meant rewriting its `d`,
                    // which is how wires ended up drawn straight through the symbol
                    // that had just been dropped on them. Its cut end is a connector;
                    // the user drags it onto the exit pin when they want that link,
                    // and the geometry they drew stays the geometry they drew.
                    if (placed && seg2Ref) {
                        this.showToast('Symbol inserted — drag the open connector onto its exit pin to finish the run', 'success');
                    }
                    this._closeSymbolPicker();
                });
                row.appendChild(item);
            });
            body.appendChild(row);
        });

        // Position near cursor, keep within viewport
        const W = 280, maxH = 360;
        const vw = window.innerWidth, vh = window.innerHeight;
        let left = clientX + 14, top = clientY - 16;
        if (left + W > vw - 8) left = clientX - W - 14;
        if (top + maxH > vh - 8) top = vh - maxH - 8;
        if (top < 8) top = 8;
        picker.style.cssText = `display:flex; left:${left}px; top:${top}px;`;

        // Outside-click → close
        const onOutside = (ev) => {
            if (!picker.contains(ev.target)) this._closeSymbolPicker();
        };
        picker._onOutside = onOutside;
        document.addEventListener('mousedown', onOutside, true);

        // Escape → close
        const onKey = (ev) => { if (ev.key === 'Escape') this._closeSymbolPicker(); };
        picker._onKey = onKey;
        document.addEventListener('keydown', onKey, true);

        setTimeout(() => picker.querySelector('.se-sym-picker-search')?.focus(), 40);
    },

    _filterSymbolPicker(query) {
        const picker = document.getElementById('se-sym-picker');
        if (!picker) return;
        const q = query.toLowerCase().trim();
        picker.querySelectorAll('.se-sym-picker-item').forEach(item => {
            item.style.display = (!q || item.title.toLowerCase().includes(q)) ? '' : 'none';
        });
        picker.querySelectorAll('.se-sym-picker-row').forEach(row => {
            const anyVisible = [...row.children].some(c => c.style.display !== 'none');
            const lbl = row.previousElementSibling;
            row.style.display = anyVisible ? '' : 'none';
            if (lbl?.classList.contains('se-sym-picker-group')) lbl.style.display = anyVisible ? '' : 'none';
        });
    },

    _closeSymbolPicker() {
        const picker = document.getElementById('se-sym-picker');
        if (!picker || picker.style.display === 'none') return;
        picker.style.display = 'none';
        if (picker._onOutside) { document.removeEventListener('mousedown', picker._onOutside, true); picker._onOutside = null; }
        if (picker._onKey)     { document.removeEventListener('keydown',   picker._onKey,     true); picker._onKey = null; }
    },
});
