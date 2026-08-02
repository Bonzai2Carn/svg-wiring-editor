/* ============================================================
   Schematics Editor — Canvas Engine
   Selection manager, bounding-box handles, drag-move,
   resize (8 handles), rotate, delete, group/ungroup
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Init ──────────────────────────────────────────────────
    initCanvasEngine() {
        this._selection = [];        // array of SVG elements
        this._selectionBox = null;      // <g> overlay with handles
        this._dragState = null;      // drag operation state
        this._resizeState = null;      // resize operation state
        this._rotateState = null;      // rotate operation state
        this._useCanvasHandles = false; // set true in initCameraOverlay once overlay ready

        this._bindCanvasEvents();
        this.initCameraOverlay();
    },

    // ── Canvas overlay init (Step 3) ────────────────────────────────
    //   Sized to match #svgDisplay; re-sized on ResizeObserver.
    //   Not drawing yet — rendering wired in Steps 7–10.
    initCameraOverlay() {
        this._overlayCanvas = document.getElementById('overlayCanvas');
        if (!this._overlayCanvas) return;
        this._overlayCtx = this._overlayCanvas.getContext('2d');
        this._overlayHandleZones = [];
        this._overlayRafHandle = null;
        this._resizeOverlayCanvas();
        const ro = new ResizeObserver(() => this._resizeOverlayCanvas());
        ro.observe(this.$svgDisplay[0]);
        // Enable canvas-based handle rendering
        this._useCanvasHandles = true;
    },

    _resizeOverlayCanvas() {
        if (!this._overlayCanvas) return;
        const r = this.$svgDisplay[0].getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this._overlayCanvas.width = r.width * dpr;
        this._overlayCanvas.height = r.height * dpr;
        this._overlayCanvas.style.width = r.width + 'px';
        this._overlayCanvas.style.height = r.height + 'px';
        // setTransform resets — do NOT use ctx.scale() which accumulates on each resize
        this._overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._scheduleOverlayRender();
    },

    _scheduleOverlayRender() {
        if (!this._overlayCtx) return;
        if (this._overlayRafHandle) return;
        this._overlayRafHandle = requestAnimationFrame(() => {
            this._overlayRafHandle = null;
            this._renderOverlay();
        });
    },

    // ── Selection API ─────────────────────────────────────────

    getSelection() { return [...this._selection]; },

    selectEl(svgEl, additive = false) {
        if (!svgEl) return;
        // Hitboxes are invisible click targets — select their visual sibling instead
        if (svgEl.classList.contains('wire-hitbox') || svgEl.classList.contains('component-hitbox')) {
            const prev = svgEl.previousElementSibling;
            if (prev) svgEl = prev; else return;
        }
        if (!additive) {
            this._selection.forEach(el => el.classList.remove('se-selected'));
            this._selection = [];
        }
        if (!this._selection.includes(svgEl)) {
            this._selection.push(svgEl);
            svgEl.classList.add('se-selected');
        }
        this._renderHandles();
        this._refreshPropertyPanel();
        // Toast on multi-select so the user gets canvas-level feedback immediately,
        // independent of which side-panel tab is active.
        if (additive && this._selection.length >= 2) {
            this.showToast(`${this._selection.length} selected — batch edits apply to all`, 'success');
        }
        // Sync selection back to the layers panel if it's open and the
        // selection didn't originate FROM the panel (avoid feedback loop).
        if (!additive) this._revealInLayersPanel(svgEl);
    },

    // Highlight and scroll to the layer-panel row matching svgEl.
    // No-op if the element was already selected via the panel itself.
    _revealInLayersPanel(svgEl) {
        if (!this.$sidePanel?.hasClass('open') || !this._layerPanelMode) return;
        // If this element is already in the panel selection it came FROM the panel — skip.
        if (this._layerSelectedItems?.has(svgEl)) return;

        this._clearLayerSelection?.();

        // 1. Try id-based lookup (fast path)
        let $row = svgEl.id ? $(`#layersPanel [data-element-id="${CSS.escape(svgEl.id)}"]`).first() : $();

        // 2. Fall back: scan all rows for a stored _svgEl reference (Structure view rows)
        if (!$row.length) {
            $('#layersPanel .layer-item').each(function () {
                if (this._svgEl === svgEl) { $row = $(this); return false; }
            });
        }

        if (!$row.length) return;

        if (!this._layerSelectedItems) this._layerSelectedItems = new Map();
        this._layerSelectedItems.set(svgEl, $row);
        $row.addClass('layer-selected active');
        $row[0]?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    },

    selectAll() {
        this._selection.forEach(el => el.classList.remove('se-selected'));
        this._selection = [];
        this.$svgDisplay.find('*').not(
            '#_cameraRotGroup, [data-se-system="true"], [data-se-system="true"] *, .snap-guide, .draw-preview, ' +
            '.selection-handle-group, .selection-handle, .rotation-handle'
        ).each((_, el) => {
            try {
                const bb = el.getBBox();
                if (bb.width > 0 || bb.height > 0) {
                    this._selection.push(el);
                    el.classList.add('se-selected');
                }
            } catch (_) { }
        });
        this._renderHandles();
        this._refreshPropertyPanel();
    },

    deselectAll() {
        this._selection.forEach(el => el.classList.remove('se-selected'));
        this._selection = [];
        this._removeHandles();
        this._clearPropertyPanel();
    },

    deleteSelected() {
        if (!this._selection.length) return;
        const unlocked = this._selection.filter(
            el => el.dataset?.locked !== 'true' &&
                  el.dataset?.seSystem !== 'true' &&
                  !el.id?.startsWith('_') // extra safety against deleting system layers
        );
        if (unlocked.length < this._selection.length)
            this.showToast('Locked or system elements skipped', 'error');
        if (!unlocked.length) return;
        const before = this._captureFullState();
        unlocked.forEach(el => {
            const group = el.closest('.wire-group, .component-group');
            if (group) group.remove();
            else el.remove();
        });
        this._selection = [];
        this._removeHandles();
        // Prune detached refs; keep topology for elements still in the DOM so the
        // layers panel stays in topology-mode (not flat-fallback) after a partial delete.
        // _scheduleGeoAnalysis will re-run and catch any structural changes.
        this.wires      = (this.wires      || []).filter(w => w.element?.isConnected);
        this.components = (this.components || []).filter(c => c.element?.isConnected);
        this.connectors = (this.connectors || []).filter(c => c.element?.isConnected);
        this._scheduleGeoAnalysis?.();
        const after = this._captureFullState();
        this.pushHistory('Delete', before, after);
        this.showToast('Deleted', 'success');
        // Let MutationObserver rebuild the layers tree after 150 ms so the geo
        // analysis has time to run first — avoids the "blank defs" flash.
        // (The observer is already watching _contentRoot; no explicit call needed.)
    },

    // ── Group / Ungroup ───────────────────────────────────────

    groupSelected() {
        if (this._selection.length < 2) {
            this.showToast('Select 2+ elements to group', 'error');
            return;
        }
        const before = this._captureFullState();
        const NS = this.SVG_NS;
        const g = document.createElementNS(NS, 'g');
        g.id = `group_${Date.now()}`;
        const parent = this._selection[0].parentNode;
        parent.insertBefore(g, this._selection[0]);
        this._selection.forEach(el => g.appendChild(el));
        const after = this._captureFullState();
        this.pushHistory('Group', before, after);
        this.selectEl(g);
        this.showToast('Grouped', 'success');
        if (typeof this.buildLayersTree === 'function') this.buildLayersTree();
    },

    ungroupSelected() {
        const groups = this._selection.filter(el => el.tagName.toLowerCase() === 'g');
        if (!groups.length) { this.showToast('No groups selected', 'error'); return; }
        const before = this._captureFullState();
        const newSel = [];
        groups.forEach(g => {
            const parent = g.parentNode;
            Array.from(g.children).forEach(child => {
                parent.insertBefore(child, g);
                newSel.push(child);
            });
            g.remove();
        });
        const after = this._captureFullState();
        this.pushHistory('Ungroup', before, after);
        this._selection = [];
        newSel.forEach(el => this.selectEl(el, true));
        this.showToast('Ungrouped', 'success');
        if (typeof this.buildLayersTree === 'function') this.buildLayersTree();
    },

    // ── Selection Handles ─────────────────────────────────────
    //   Canvas-only handles. SVGs scale infinitely, handles stay pixel-perfect.

    _renderHandles() {
        this._removeHandles();
        this._scheduleOverlayRender();
        // Handles re-render after every move/resize/rotate/nudge, which makes
        // this the one hook that catches ELEMENT motion. updateTransform only
        // catches CAMERA motion, so without this the chips stayed behind
        // whenever something was dragged.
        this._schedulePositionLabels?.();
    },

    _removeHandles() {
        this._selectionBox?.remove();
        this._selectionBox = null;
        this.$svgDisplay[0].querySelectorAll('.selection-handle-group').forEach(el => el.remove());
        this._scheduleOverlayRender?.();
    },

    // ── Step 7: World → Overlay screen coords ─────────────────
    //   Uses getScreenCTM() — provably correct once CSS transforms
    //   are removed from #svgWrapper; always agrees with SVG rendering.
    _worldToOverlayScreen(wx, wy) {
        const svg = this.$svgDisplay[0];
        // Subtract the canvas's own screen origin so handle coords are canvas-relative.
        // Using the canvas rect (not svgContainer) is the canonical reference because
        // handles are painted onto the canvas element itself.
        const canvasRect = this._overlayCanvas.getBoundingClientRect();
        const rotGrp = svg.querySelector('#_cameraRotGroup');
        const pt = svg.createSVGPoint();
        pt.x = wx; pt.y = wy;
        // _cameraRotGroup.getScreenCTM() maps from document-local space → screen,
        // correctly including the camera rotation applied to that group.
        // svg.getScreenCTM() maps from SVG root space → screen (wrong when rotated).
        const m = rotGrp ? rotGrp.getScreenCTM() : svg.getScreenCTM();
        const sp = pt.matrixTransform(m);
        return { x: sp.x - canvasRect.left, y: sp.y - canvasRect.top };
    },

    // ── Step 7: Canvas overlay rendering ─────────────────────
    _renderOverlay() {
        if (!this._overlayCtx) return;
        const ctx = this._overlayCtx;
        const dpr = window.devicePixelRatio || 1;
        ctx.clearRect(0, 0, this._overlayCanvas.width / dpr, this._overlayCanvas.height / dpr);
        this._overlayHandleZones = [];

        if (this._marqueeState) this._drawMarquee(ctx);

        if (!this._selection?.length) return;

        // Project all element tight-bbox corners directly to screen space.
        // This avoids the axis-alignment error that bloated boxes at non-zero
        // camera rotation: the world-space AABB was correct but its corners, when
        // projected, produce a rotated rhombus — not the element's true screen envelope.
        const screenCorners = this._getSelectionScreenCorners();
        if (!screenCorners || !screenCorners.length) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        screenCorners.forEach(p => {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });

        // Single wire selected → show endpoint handles instead of bounding box.
        // The bounding box is meaningless for a 1px-wide line and its resize
        // handles apply scale() which makes stroke-width grow even with non-scaling-stroke.
        if (this._selection.length === 1 && this._isWireElement(this._selection[0])) {
            this._drawWireEndpointHandles(ctx, this._selection[0]);
            return;
        }

        const pad = 4;
        const tl = { x: minX - pad, y: minY - pad };
        const tr = { x: maxX + pad, y: minY - pad };
        const br = { x: maxX + pad, y: maxY + pad };
        const bl = { x: minX - pad, y: maxY + pad };

        this._drawOverlayRect(ctx, [tl, tr, br, bl]);
        this._drawOverlayHandles(ctx, tl, tr, bl, br);
        this._drawOverlayRotHandle(ctx, tl, tr);
    },

    // ── Wire element detection ────────────────────────────────
    _isWireElement(el) {
        if (!el) return false;
        if (el.getAttribute('data-geo-class') === 'wire') return true;
        if (el.tagName?.toLowerCase() === 'line') return true;
        // Fallback: path with fill:none and only M/L commands (straight segments)
        const fill = el.getAttribute('fill') || el.style?.fill || '';
        const d    = el.getAttribute('d')    || '';
        return fill === 'none' && d.length > 0 && /^[MLml\s\d.eE+\-,]+$/.test(d.trim());
    },

    // ── Parse ALL points of a wire element (M + all L coords) ──
    _parseWirePoints(el) {
        if (!el) return null;
        if (el.tagName?.toLowerCase() === 'line') {
            return [
                { x: parseFloat(el.getAttribute('x1') || 0), y: parseFloat(el.getAttribute('y1') || 0) },
                { x: parseFloat(el.getAttribute('x2') || 0), y: parseFloat(el.getAttribute('y2') || 0) },
            ];
        }
        const d = el.getAttribute('d') || '';
        const pts = [...d.matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/gi)]
            .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
        return pts.length >= 2 ? pts : null;
    },

    // Keep thin wrapper for callers that only need first + last
    _parseWireEndpoints(el) {
        const pts = this._parseWirePoints(el);
        return pts ? [pts[0], pts[pts.length - 1]] : null;
    },

    // ── Draw wire-shaped selection with handles at every bend ──
    // Traces the actual M/L path (not a straight hypotenuse shortcut).
    // Endpoint handles (ep0, ep_last) at the termini — larger circles.
    // Breakpoint handles (bp_1, bp_2 …) at each intermediate bend — smaller.
    _drawWireEndpointHandles(ctx, el) {
        const pts = this._parseWirePoints(el);
        if (!pts) return;

        // Project every wire point to screen space
        const sPts = pts.map(p => this._worldToOverlayScreen(p.x, p.y));

        ctx.save();

        // Dashed selection line that follows the actual wire geometry
        ctx.strokeStyle = 'rgba(79,172,254,0.55)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(sPts[0].x, sPts[0].y);
        for (let i = 1; i < sPts.length; i++) ctx.lineTo(sPts[i].x, sPts[i].y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Helper — draw a circle handle and register its hit zone
        const circle = (pos, id, R) => {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, R, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            this._overlayHandleZones.push({ type: 'circle', id, cx: pos.x, cy: pos.y, r: R + 4 });
        };

        // Breakpoint handles at intermediate bend points (drawn first, sit behind endpoints)
        ctx.fillStyle   = 'rgba(79,172,254,0.15)';
        ctx.strokeStyle = 'rgba(79,172,254,0.7)';
        ctx.lineWidth   = 1.5;
        for (let i = 1; i < sPts.length - 1; i++) {
            circle(sPts[i], `bp_${i}`, 4);
        }

        // Endpoint handles at termini (drawn on top)
        ctx.fillStyle   = '#0f172a';
        ctx.strokeStyle = '#4facfe';
        ctx.lineWidth   = 2;
        circle(sPts[0], 'ep0', 6);
        circle(sPts[sPts.length - 1], 'ep_last', 6);

        ctx.restore();
    },

    // ── Tight bbox corners projected directly to overlay screen space ──
    //   Replaces the old world-AABB→4-corner approach, which bloated the
    //   selection box for element-rotated shapes and camera-rotated views.
    _getSelectionScreenCorners() {
        if (!this._selection.length) return null;
        const svg = this.$svgDisplay[0];
        const canvasRect = this._overlayCanvas.getBoundingClientRect();
        const rotGrp = svg.querySelector('#_cameraRotGroup');
        // getScreenCTM() returns SVGMatrix, not DOMMatrix — keep as SVGMatrix for
        // pt.matrixTransform() below (SVGMatrix.multiply rejects DOMMatrix args).
        const ctm = rotGrp ? rotGrp.getScreenCTM() : svg.getScreenCTM();
        if (!ctm) return null;

        const pts = [];
        this._selection.forEach(el => {
            let bb;
            try { bb = el.getBBox(); } catch (_) { return; }
            if (!bb) return;

            // Walk element transform chain up to _cameraRotGroup (doc-local space)
            let m = new DOMMatrix();
            let node = el;
            while (node && node !== svg && node.id !== '_cameraRotGroup') {
                const tv = node.transform?.baseVal;
                if (tv?.length) {
                    const lm = tv.consolidate()?.matrix;
                    if (lm) m = new DOMMatrix([lm.a, lm.b, lm.c, lm.d, lm.e, lm.f]).multiply(m);
                }
                node = node.parentElement;
            }

            // Two-step projection: DOMPoint × DOMMatrix (element chain) → SVGPoint × SVGMatrix (camera CTM)
            // Cannot compose with ctm.multiply(m) because SVGMatrix.multiply rejects DOMMatrix.
            const svgPt = svg.createSVGPoint();
            [[bb.x, bb.y], [bb.x + bb.width, bb.y],
            [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]].forEach(([px, py]) => {
                const docPt = new DOMPoint(px, py).matrixTransform(m);  // element → doc-local
                svgPt.x = docPt.x;
                svgPt.y = docPt.y;
                const sp = svgPt.matrixTransform(ctm);                  // doc-local → screen
                pts.push({ x: sp.x - canvasRect.left, y: sp.y - canvasRect.top });
            });
        });

        return pts.length ? pts : null;
    },

    _drawOverlayRect(ctx, pts) {
        ctx.save();
        ctx.strokeStyle = '#4facfe';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    },

    _drawOverlayHandles(ctx, tl, tr, bl, br) {
        const midT = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
        const midB = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };
        const midL = { x: (tl.x + bl.x) / 2, y: (tl.y + bl.y) / 2 };
        const midR = { x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2 };
        const zones = [
            { id: 'nw', ...tl }, { id: 'n', ...midT }, { id: 'ne', ...tr },
            { id: 'e', ...midR }, { id: 'se', ...br }, { id: 's', ...midB },
            { id: 'sw', ...bl }, { id: 'w', ...midL },
        ];
        const SZ = 10;
        ctx.save();
        ctx.fillStyle = '#1a1a2e';
        ctx.strokeStyle = '#4facfe';
        ctx.lineWidth = 1.5;
        zones.forEach(z => {
            ctx.fillRect(z.x - SZ / 2, z.y - SZ / 2, SZ, SZ);
            ctx.strokeRect(z.x - SZ / 2, z.y - SZ / 2, SZ, SZ);
            this._overlayHandleZones.push({ type: 'rect', id: z.id, cx: z.x, cy: z.y, size: SZ });
        });
        ctx.restore();
    },

    _drawOverlayRotHandle(ctx, tl, tr) {
        const mx = (tl.x + tr.x) / 2;
        const my = (tl.y + tr.y) / 2;
        // Direction perpendicular to top edge (pointing away from shape)
        const ex = tr.x - tl.x, ey = tr.y - tl.y;
        const len = Math.hypot(ex, ey) || 1;
        const nx = -ey / len, ny = ex / len;  // perpendicular outward
        const arm = 24;
        const hx = mx + nx * arm;
        const hy = my + ny * arm;
        ctx.save();
        ctx.strokeStyle = '#4facfe';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.fillStyle = '#1a1a2e';
        ctx.beginPath();
        ctx.arc(hx, hy, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        this._overlayHandleZones.push({ type: 'circle', id: 'rotate', cx: hx, cy: hy, r: 8 });
    },

    // ── Step 8: CSS-agnostic bbox in world space ──────────────
    //   Pure SVG-transform walk — no getCTM(), no CSS dependency.
    //   Works correctly through _cameraRotGroup and nested groups.
    _getSelectionBBoxWorld() {
        if (!this._selection.length) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const svg = this.$svgDisplay[0];

        this._selection.forEach(el => {
            let bb;
            try { bb = el.getBBox(); } catch (_) { return; }
            if (!bb) return;

            // Walk SVG transform chain from element up to _cameraRotGroup (exclusive).
            // Stop before _cameraRotGroup so bbox coords stay in document-local space —
            // the same space where element transform= attributes are interpreted.
            // (Including _cameraRotGroup's rotate would shift the bbox into SVG root
            // space, causing rotate/scale handles to operate around the wrong origin.)
            let m = new DOMMatrix();
            let node = el;
            while (node && node !== svg && node.id !== '_cameraRotGroup') {
                const tv = node.transform?.baseVal;
                if (tv?.length) {
                    const lm = tv.consolidate()?.matrix;
                    if (lm) m = new DOMMatrix([lm.a, lm.b, lm.c, lm.d, lm.e, lm.f]).multiply(m);
                }
                node = node.parentElement;
            }

            [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
                .forEach(([px, py]) => {
                    const tp = new DOMPoint(px, py).matrixTransform(m);
                    minX = Math.min(minX, tp.x); minY = Math.min(minY, tp.y);
                    maxX = Math.max(maxX, tp.x); maxY = Math.max(maxY, tp.y);
                });
        });

        if (!isFinite(minX)) return null;
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },

    // Alias for any existing callers that use the old name
    _getSelectionBBox() { return this._getSelectionBBoxWorld(); },

    // ── Step 10: Handle hit-testing on canvas overlay ────────
    //   Canvas has no per-element pointer events; we maintain
    //   this._overlayHandleZones to detect hits manually.
    _hitTestOverlayHandles(clientX, clientY) {
        const ctnr = this._overlayCanvas.getBoundingClientRect();
        const sx = clientX - ctnr.left, sy = clientY - ctnr.top;
        for (const z of (this._overlayHandleZones || [])) {
            if (z.type === 'circle') {
                if (Math.hypot(sx - z.cx, sy - z.cy) <= z.r) return z.id;
            } else {
                const hs = z.size / 2;
                if (sx >= z.cx - hs && sx <= z.cx + hs && sy >= z.cy - hs && sy <= z.cy + hs) return z.id;
            }
        }
        return null;
    },

    _startHandleInteraction(type, clientX, clientY) {
        // Wire-point drag — endpoints (ep0, ep_last) or bend points (bp_N)
        if (type === 'ep0' || type === 'ep_last' || type.startsWith('bp_')) {
            this._startWirePointDrag(type, clientX, clientY);
            return;
        }

        this._handleDragActive = true;

        const startX = clientX;
        const startY = clientY;
        const startBB = this._getSelectionBBoxWorld();
        if (!startBB) return;

        const startTransforms = this._selection.map(el => ({
            el,
            transform: el.getAttribute('transform') || '',
            attrs: this._captureElementAttrs(el),
        }));

        const before = this._captureFullState();

        const svgStart = this.screenToSVG(startX, startY);

        const onMove = (ev) => {
            const svgNow = this.screenToSVG(ev.clientX, ev.clientY);
            const dx = svgNow.x - svgStart.x;
            const dy = svgNow.y - svgStart.y;

            if (type === 'rotate') {
                const cx = startBB.x + startBB.width / 2;
                const cy = startBB.y + startBB.height / 2;
                const startAngle = Math.atan2(svgStart.y - cy, svgStart.x - cx) * 180 / Math.PI;
                let delta = Math.atan2(svgNow.y - cy, svgNow.x - cx) * 180 / Math.PI - startAngle;
                // Normalize to [-180,180] to avoid jumps at the ±180 boundary
                delta -= 360 * Math.round(delta / 360);
                const snapped = Math.round(delta / 15) * 15;
                this._applyRotation(startTransforms, cx, cy, snapped);
            } else {
                this._applyResize(startTransforms, startBB, type, dx, dy, ev.shiftKey);
            }
            // Re-route wires after every rotate/resize frame
            this._updateWiresForSelection();
            if (!this._handleRafPending) {
                this._handleRafPending = true;
                requestAnimationFrame(() => {
                    this._handleRafPending = false;
                    this._renderHandles();
                });
            }
        };

        const onUp = () => {
            $(document).off('mousemove.handle mouseup.handle');
            this._handleDragActive = false;
            const after = this._captureFullState();
            this.pushHistory(type === 'rotate' ? 'Rotate' : 'Resize', before, after);
            this._refreshPropertyPanel();
        };

        $(document).on('mousemove.handle', onMove).on('mouseup.handle', onUp);
    },

    // ── Wire-point drag: move any point on a wire (endpoint or bend) ──
    _startWirePointDrag(pointId, clientX, clientY) {
        const el = this._selection[0];
        if (!el) return;
        const before = this._captureFullState();
        this._lastSnappedPin = null; // reset so stale state from prior interactions doesn't leak

        const isEndpoint = pointId === 'ep0' || pointId === 'ep_last';
        this._handleDragActive = true;

        const onMove = (ev) => {
            const pt = this.screenToSVG(ev.clientX, ev.clientY);
            // Endpoints snap to nearby pins; bend points use grid snap only.
            const snapped = isEndpoint
                ? this._wireSnapToPort(pt)
                : (this.smartSnap?.(pt.x, pt.y) || pt);
            // Visual pin-snap highlight
            if (isEndpoint) {
                this._contentRoot?.querySelectorAll('.pin-point.pin-snap').forEach(p => {
                    if (p !== this._lastSnappedPin) p.classList.remove('pin-snap');
                });
                if (this._lastSnappedPin) this._lastSnappedPin.classList.add('pin-snap');
            }
            this._moveWirePoint(el, pointId, snapped.x, snapped.y);
            this._syncWireNodes();
            this._renderHandles();
        };

        const onUp = () => {
            $(document).off('mousemove.handle mouseup.handle');
            this._handleDragActive = false;
            this._clearPinSnap?.();
            // Re-anchor or un-anchor the endpoint based on where it was dropped.
            if (isEndpoint) {
                const pin = this._lastSnappedPin;
                const symGroup = pin?.closest?.('.domain-symbol');
                if (symGroup?.id) {
                    // Dropped on a pin → establish/update the anchor
                    const symAttr = pointId === 'ep0' ? 'data-from-sym' : 'data-to-sym';
                    const pinAttr = pointId === 'ep0' ? 'data-from-pin' : 'data-to-pin';
                    el.setAttribute(symAttr, symGroup.id);
                    el.setAttribute(pinAttr, pin.dataset?.pin ?? '0');
                } else {
                    // Dropped on empty space → clear any stale anchor for this endpoint
                    if (pointId === 'ep0') {
                        el.removeAttribute('data-from-sym');
                        el.removeAttribute('data-from-pin');
                    } else {
                        el.removeAttribute('data-to-sym');
                        el.removeAttribute('data-to-pin');
                    }
                }
            }
            const after = this._captureFullState();
            this.pushHistory('Move Wire Point', before, after);
            this._scheduleGeoAnalysis?.();
            this._refreshPropertyPanel?.();
        };

        $(document).on('mousemove.handle', onMove).on('mouseup.handle', onUp);
    },

    // ── Rewrite one specific point in a wire's geometry ──────
    // pointId: 'ep0' | 'ep_last' | 'bp_N' (N = 1-based index)
    _moveWirePoint(el, pointId, x, y) {
        const tag = el.tagName?.toLowerCase();

        // <line> — first or last attribute pair
        if (tag === 'line') {
            if (pointId === 'ep0') { el.setAttribute('x1', x); el.setAttribute('y1', y); }
            else                   { el.setAttribute('x2', x); el.setAttribute('y2', y); }
            return;
        }

        // <path> — rewrite the N-th M/L coordinate in the d string
        const d = el.getAttribute('d') || '';
        const matches = [...d.matchAll(/([ML])\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/gi)];
        if (matches.length < 2) return;

        let idx;
        if      (pointId === 'ep0')             idx = 0;
        else if (pointId === 'ep_last')          idx = matches.length - 1;
        else if (pointId.startsWith('bp_'))      idx = parseInt(pointId.slice(3), 10);
        else return;

        if (idx < 0 || idx >= matches.length) return;

        const m   = matches[idx];
        const cmd = idx === 0 ? 'M' : 'L';
        el.setAttribute('d',
            d.slice(0, m.index) + `${cmd} ${x} ${y}` + d.slice(m.index + m[0].length)
        );
    },

    _captureElementAttrs(el) {
        const attrs = {};
        for (const attr of el.attributes) attrs[attr.name] = attr.value;
        return attrs;
    },

    /**
     * Compute bounding box ignoring <text> elements so alignment works
     * purely on visual graphics rather than jutting labels.
     */
    _getVisualBBox(el) {
        const texts = Array.from(el.querySelectorAll('text'));
        const displays = texts.map(t => t.style.display);
        texts.forEach(t => t.style.display = 'none');
        
        let bb = { x: 0, y: 0, width: 0, height: 0 };
        try { bb = el.getBBox(); } catch (_) {}
        
        texts.forEach((t, i) => t.style.display = displays[i]);
        return bb;
    },

    /**
     * Compute bounding box in world space (ignoring labels), plus extract world-space pins.
     */
    _getVisualBBoxWorld(el) {
        try {
            const bb = this._getVisualBBox(el);
            const svg = this.$svgDisplay?.[0];
            let m = new DOMMatrix();
            let node = el;
            while (node && node !== svg && node.id !== '_cameraRotGroup') {
                const tv = node.transform?.baseVal;
                if (tv?.length) {
                    const lm = tv.consolidate()?.matrix;
                    if (lm) m = new DOMMatrix([lm.a, lm.b, lm.c, lm.d, lm.e, lm.f]).multiply(m);
                }
                node = node.parentElement;
            }
            const pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y],
                         [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
                .map(([px, py]) => new DOMPoint(px, py).matrixTransform(m));
            const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
            
            const pins = Array.from(el.querySelectorAll('.pin-point')).map(pin => {
                const cx = parseFloat(pin.getAttribute('cx') || 0);
                const cy = parseFloat(pin.getAttribute('cy') || 0);
                return new DOMPoint(cx, cy).matrixTransform(m);
            });

            return { 
                x: Math.min(...xs), y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
                pins 
            };
        } catch(_) { return null; }
    },

    // True when the selection must scale uniformly.
    //
    //   Symbols: a resistor squashed to 40% height is not a smaller resistor, it is
    //   a wrong resistor. Their geometry, pin offsets and glyph proportions are the
    //   notation, so they only ever scale uniformly.
    //
    //   Multi-select: a group resize applies the SAME sx/sy to every member about a
    //   shared anchor. Non-uniform there deforms each individual member even when
    //   the group's own bbox tracks the cursor correctly, which is exactly the
    //   "multi-select resize deforms the content" failure. Uniform is the only
    //   scale that leaves the members themselves undistorted.
    _selectionRequiresUniformScale() {
        if (!this._selection?.length) return false;
        if (this._selection.length > 1) return true;
        return this._selection.some(el =>
            el.classList?.contains('domain-symbol') ||
            el.querySelector?.('.domain-symbol, .pin-point'));
    },

    _applyResize(startTransforms, startBB, handle, dx, dy, shiftKey) {
        const lockAspect = shiftKey || this._selectionRequiresUniformScale();

        const scaleX = handle.includes('e') ? (startBB.width + dx) / (startBB.width || 1)
            : handle.includes('w') ? (startBB.width - dx) / (startBB.width || 1)
                : 1;
        const scaleY = handle.includes('s') ? (startBB.height + dy) / (startBB.height || 1)
            : handle.includes('n') ? (startBB.height - dy) / (startBB.height || 1)
                : 1;

        // Uniform factor. The old code used Math.min(scaleX, scaleY), which is wrong
        // for edge handles: dragging 'e' outward gives scaleX=1.6, scaleY=1 (the
        // untouched axis), and min() picks 1 — the shape refused to grow. Pick from
        // the axes the handle actually drives, and on corners take whichever moved
        // furthest from 1 so the shape follows the cursor.
        let sx, sy;
        if (lockAspect) {
            const drivesX = /[ew]/.test(handle);
            const drivesY = /[ns]/.test(handle);
            let s;
            if (drivesX && drivesY) s = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
            else if (drivesX) s = scaleX;
            else s = scaleY;
            sx = sy = Math.max(0.01, s);
        } else {
            sx = Math.max(0.01, scaleX);
            sy = Math.max(0.01, scaleY);
        }
        // Anchor: the bbox corner that stays fixed (opposite the dragged handle).
        const ax = handle.includes('w') ? startBB.x + startBB.width : startBB.x;
        const ay = handle.includes('n') ? startBB.y + startBB.height : startBB.y;

        // Compose world-space scale-about-anchor with the element's original transform.
        // translate(ax,ay) scale(sx,sy) translate(-ax,-ay) origT  is mathematically:
        //   newWorldMatrix = scaleAboutAnchor * originalWorldMatrix
        // This preserves any existing rotation or offset in origT (palette symbols, etc.)
        startTransforms.forEach(({ el, transform: origT }) => {
            el.setAttribute('transform',
                `translate(${ax},${ay}) scale(${sx},${sy}) translate(${-ax},${-ay}) ${origT}`
            );
        });
    },

    _applyRotation(startTransforms, cx, cy, angle) {
        // Prepend a world-space rotation to the element's original transform (captured at
        // drag-start).  Using a delta angle keeps rotations from accumulating over multiple
        // drag sessions — each session composes a fresh delta on top of origT.
        startTransforms.forEach(({ el, transform: origT }) => {
            el.setAttribute('transform', `rotate(${angle},${cx},${cy}) ${origT}`);
        });
    },

    // ── Keyboard rotate / flip (Shift+R / Shift+F) ────────────
    // 90° steps around the selection center — the EDA convention for
    // orienting components without touching the rotate handle.
    rotateSelected(deg = 90) {
        if (!this._selection.length) return;
        const bb = this._getSelectionBBoxWorld();
        if (!bb) return;
        const before = this._captureFullState();
        const startTransforms = this._selection.map(el => ({
            el, transform: el.getAttribute('transform') || '',
        }));
        // A lone symbol rotates around its own origin so pins stay on-grid;
        // the label-inclusive bbox center sits a few units off and would
        // walk the pins off the snap lattice on every quarter turn.
        let cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
        if (this._selection.length === 1 &&
            this._selection[0].classList?.contains('domain-symbol')) {
            // Local (0,0) through the consolidated transform = the symbol origin
            const lm = this._selection[0].transform?.baseVal?.consolidate()?.matrix;
            if (lm) { cx = lm.e; cy = lm.f; }
        }
        this._applyRotation(startTransforms, cx, cy, deg);
        this._updateWiresForSelection();
        this._renderHandles();
        this.pushHistory('Rotate 90°', before, this._captureFullState());
    },

    flipSelected(axis = 'h') {
        if (!this._selection.length) return;
        const bb = this._getSelectionBBoxWorld();
        if (!bb) return;
        const before = this._captureFullState();
        const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
        const sx = axis === 'h' ? -1 : 1, sy = axis === 'h' ? 1 : -1;
        this._selection.forEach(el => {
            const origT = el.getAttribute('transform') || '';
            el.setAttribute('transform',
                `translate(${cx},${cy}) scale(${sx},${sy}) translate(${-cx},${-cy}) ${origT}`);
        });
        this._updateWiresForSelection();
        this._renderHandles();
        this.pushHistory('Flip', before, this._captureFullState());
    },

    // ── Move Selected ─────────────────────────────────────────

    _startMoveSelected(startClientX, startClientY) {
        if (!this._selection.length) return;
        this._moveActive = true;
        $('body').addClass('gx-dragging-move');
        const before = this._captureFullState();
        const svgStart = this.screenToSVG(startClientX, startClientY);

        // Bake any existing transforms on wire elements into their d-coordinates
        // before we start, so delta arithmetic works in world space throughout.
        this._selection.forEach(el => {
            if (this._isWireElement(el)) this._bakeWireTransform(el);
        });

        const origTransforms = this._selection.map(el => el.getAttribute('transform') || '');
        // Snapshot original d for wire elements (world-space coords after bake above).
        const origDAttrs = this._selection.map(el =>
            this._isWireElement(el) ? (el.getAttribute('d') || null) : null
        );

        // Capture world-space bboxes of non-wire selected elements at drag start.
        // Used per-frame by _computeAlignSnap to project positions and find edge alignment.
        const selectionOrigBBoxes = this._selection
            .filter(el => !this._isWireElement(el))
            .map(el => this._getVisualBBoxWorld(el));
        const alignExcludeIds = this._selection.map(el => el.id).filter(Boolean);

        let pendingWireSnap = null;

        const onMove = (ev) => {
            const svgNow = this.screenToSVG(ev.clientX, ev.clientY);
            const raw    = { x: svgNow.x - svgStart.x, y: svgNow.y - svgStart.y };
            const gridSnapped = this.snapPoint(raw.x, raw.y);

            // Figma-style alignment snap: project selection bboxes to current delta,
            // find smallest per-axis adjustment that aligns a selection edge to a
            // reference element edge. Falls back to grid snap when no alignment found.
            const alignResult = this._computeAlignSnap?.(selectionOrigBBoxes, gridSnapped, alignExcludeIds);
            const snapped = alignResult ? alignResult.delta : gridSnapped;
            this._removeSnapGuides();
            if (alignResult?.guides?.length) this.showAlignmentGuides?.(alignResult.guides);

            this._selection.forEach((el, i) => {
                if (this._isWireElement(el) && origDAttrs[i]) {
                    // ── Wire: update d directly, never translate ────────────
                    // Keeps endpoint-anchoring and avoids transform accumulation.
                    el.setAttribute('transform', origTransforms[i]);

                    const fromSym = el.getAttribute('data-from-sym');
                    const toSym   = el.getAttribute('data-to-sym');
                    const fromPt  = fromSym
                        ? this._resolveSymPinPos(fromSym, el.getAttribute('data-from-pin'))
                        : null;
                    const toPt    = toSym
                        ? this._resolveSymPinPos(toSym, el.getAttribute('data-to-pin'))
                        : null;

                    // Parse original world-space points (snapshotted before bake)
                    const pts = [...origDAttrs[i]
                        .matchAll(/([ML])\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/gi)]
                        .map(m => ({ x: parseFloat(m[2]), y: parseFloat(m[3]) }));
                    if (pts.length < 2) return;

                    const translatedD = () => pts.map((p, k) =>
                        `${k === 0 ? 'M' : 'L'} ${p.x + snapped.x} ${p.y + snapped.y}`
                    ).join(' ');

                    if (!fromPt && !toPt) {
                        // Fully free wire: offset every point by the drag delta,
                        // preserving multi-segment geometry.
                        el.setAttribute('d', translatedD());
                    } else {
                        // One or both endpoints anchored.
                        // Anchored end = component pin position (current, live).
                        // Free end     = original position + drag delta.
                        const fp = fromPt
                            || { x: pts[0].x + snapped.x, y: pts[0].y + snapped.y };
                        const tp = toPt
                            || { x: pts[pts.length - 1].x + snapped.x,
                                 y: pts[pts.length - 1].y + snapped.y };

                        const selIds = new Set(this._selection.map(s => s.id));
                        if (fromPt && toPt) {
                            if (selIds.has(fromSym) && selIds.has(toSym)) {
                                // Whole assembly (wire + both symbols) moves together:
                                // preserve the wire's shape, just translate it.
                                el.setAttribute('d', translatedD());
                            } else if (!selIds.has(fromSym) && !selIds.has(toSym)) {
                                // Wire dragged alone between two fixed components:
                                // route from-pin → cursor → to-pin so drag controls the bend.
                                const segs = [`M ${fp.x} ${fp.y}`];
                                if (Math.abs(fp.y - svgNow.y) > 0.5) segs.push(`L ${fp.x} ${svgNow.y}`);
                                segs.push(`L ${svgNow.x} ${svgNow.y}`);
                                if (Math.abs(svgNow.y - tp.y) > 0.5) segs.push(`L ${svgNow.x} ${tp.y}`);
                                segs.push(`L ${tp.x} ${tp.y}`);
                                el.setAttribute('d', segs.join(' '));
                            } else {
                                // One symbol moving, one fixed: clean pin-to-pin re-route.
                                el.setAttribute('d', this._smartRoute(fromPt, toPt));
                            }
                        } else {
                            el.setAttribute('d', this._smartRoute(fp, tp));
                        }
                    }
                } else {
                    // Non-wire element: standard translate
                    el.setAttribute('transform',
                        `translate(${snapped.x},${snapped.y}) ${origTransforms[i]}`);
                }
            });

            // Wire-body proximity snap: nudge so a pin aligns to a nearby wire
            // (only fires for .domain-symbol elements — wires are skipped automatically)
            const wireAdj = this._computeWireSnapAdjustment();
            if (wireAdj) {
                const adjX = snapped.x + wireAdj.dx;
                const adjY = snapped.y + wireAdj.dy;
                this._selection.forEach((el, i) => {
                    if (!this._isWireElement(el)) {
                        el.setAttribute('transform',
                            `translate(${adjX},${adjY}) ${origTransforms[i]}`);
                    }
                });
            }
            pendingWireSnap = wireAdj || null;

            // Re-route any wires whose endpoints are pinned to a moved symbol
            this._updateWiresForSelection();
            this._renderHandles();
        };

        const onUp = () => {
            $(document).off('mousemove.move mouseup.move');
            this._moveActive = false;
            $('body').removeClass('gx-dragging-move');
            this._removeSnapGuides();
            if (pendingWireSnap) this._commitWireSnap(pendingWireSnap, pendingWireSnap.symEl);
            const after = this._captureFullState();
            this.pushHistory('Move', before, after);
            this._refreshPropertyPanel();
        };

        $(document).on('mousemove.move', onMove).on('mouseup.move', onUp);
    },

    // A connector/junction dot marks a point ON a wire, but it is a separate
    // circle with its own cx/cy — so when the wire moved, the dot stayed put and
    // was left floating in empty canvas. Each node records the wires it joins
    // (data-wire-a = the segment ending here, data-wire-b = the one starting
    // here), so its position is derivable rather than remembered.
    _syncWireNodes() {
        const root = this._contentRoot;
        if (!root) return;
        root.querySelectorAll('.wire-connector, .wire-junction').forEach(node => {
            const aId = node.getAttribute('data-wire-a');
            const bId = node.getAttribute('data-wire-b');
            if (!aId && !bId) return;                 // standalone dot, not ours to move

            const a = aId ? root.querySelector(`#${CSS.escape(aId)}`) : null;
            const b = bId ? root.querySelector(`#${CSS.escape(bId)}`) : null;

            // Both halves gone: the point it marked no longer exists.
            if (!a && !b) { node.remove(); return; }

            // The cut point is A's LAST vertex, equivalently B's FIRST.
            let pt = null;
            if (a) { const p = this._parseWirePoints(a); if (p) pt = p[p.length - 1]; }
            if (!pt && b) { const p = this._parseWirePoints(b); if (p) pt = p[0]; }
            if (!pt) return;

            node.setAttribute('cx', pt.x);
            node.setAttribute('cy', pt.y);
        });
    },

    // Re-route all wires whose endpoints are pinned to any currently selected symbol.
    // Called after every move, rotate, and resize frame.
    _updateWiresForSelection() {
        this._selection.forEach(el => {
            const id = el.id;
            if (!id) return;
            this._contentRoot?.querySelectorAll(
                `[data-from-sym="${id}"], [data-to-sym="${id}"]`
            ).forEach(wire => this._updateAttachedWire(wire, id));
        });
        // Wires just moved, so the dots that sit on them have to follow.
        this._syncWireNodes();
    },

    _pinWorldPos(pinEl) {
        const cx = parseFloat(pinEl.getAttribute('cx') || 0);
        const cy = parseFloat(pinEl.getAttribute('cy') || 0);
        let m = new DOMMatrix();
        let node = pinEl;
        const svg = this.$svgDisplay?.[0];
        while (node && node !== svg && node.id !== '_cameraRotGroup') {
            const tv = node.transform?.baseVal;
            if (tv?.length) {
                const lm = tv.consolidate()?.matrix;
                if (lm) m = new DOMMatrix([lm.a, lm.b, lm.c, lm.d, lm.e, lm.f]).multiply(m);
            }
            node = node.parentElement;
        }
        const pt = new DOMPoint(cx, cy).matrixTransform(m);

        let dx = 0, dy = 0;
        const dirStr = pinEl.getAttribute('data-pin-dir');
        if (dirStr) {
            const parts = dirStr.split(',');
            if (parts.length === 2) {
                dx = parseFloat(parts[0]);
                dy = parseFloat(parts[1]);
            }
        }
        // Project direction vector through the matrix (ignoring translation)
        const dirX = m.a * dx + m.c * dy;
        const dirY = m.b * dx + m.d * dy;
        const len = Math.hypot(dirX, dirY) || 1;
        
        return { x: pt.x, y: pt.y, dx: dirX / len, dy: dirY / len };
    },

    // Re-route a wire path whose from- or to-endpoint belongs to a symbol being dragged.
    // Resolve the world-space position of a named pin on a symbol element.
    // Shared by _updateAttachedWire and _startMoveSelected wire-drag logic.
    _resolveSymPinPos(symId, pinAttr) {
        const sym = document.getElementById(symId);
        if (!sym) return null;
        const pin = pinAttr
            ? sym.querySelector(`.pin-point[data-pin="${pinAttr}"]`) || sym.querySelector('.pin-point')
            : sym.querySelector('.pin-point');
        return pin ? this._pinWorldPos(pin) : null;
    },

    // Bake any existing SVG transform on a wire into its d-attribute coordinates,
    // then clear the transform. Ensures d always holds true world-space coordinates
    // before a drag begins so delta math is unambiguous.
    _bakeWireTransform(el) {
        const tv = el.transform?.baseVal;
        if (!tv?.length) return;
        const m = tv.consolidate()?.matrix;
        if (!m) return;
        const dm = new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]);
        const d = el.getAttribute('d') || '';
        const newD = d.replace(/([ML])\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/gi, (_, cmd, x, y) => {
            const pt = new DOMPoint(parseFloat(x), parseFloat(y)).matrixTransform(dm);
            return `${cmd} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`;
        });
        el.setAttribute('d', newD);
        el.setAttribute('transform', '');
    },

    // Smart orthogonal routing engine
    // Respects pin exit directions and builds natural 3-elbow or 5-elbow Manhattan paths.
    _smartRoute(fromPt, toPt) {
        const STUB = 15;
        
        const p1 = { x: fromPt.x, y: fromPt.y };
        let p2 = { x: p1.x, y: p1.y };
        if (fromPt.dx !== undefined && fromPt.dy !== undefined) {
            p2.x += fromPt.dx * STUB;
            p2.y += fromPt.dy * STUB;
        }

        const p6 = { x: toPt.x, y: toPt.y };
        let p5 = { x: p6.x, y: p6.y };
        if (toPt.dx !== undefined && toPt.dy !== undefined) {
            p5.x += toPt.dx * STUB;
            p5.y += toPt.dy * STUB;
        }

        let path = `M ${p1.x} ${p1.y}`;
        if (p1.x !== p2.x || p1.y !== p2.y) path += ` L ${p2.x} ${p2.y}`;

        let midX = (p2.x + p5.x) / 2;
        let midY = (p2.y + p5.y) / 2;

        const fromHoriz = fromPt.dx !== undefined ? Math.abs(fromPt.dx) > 0.5 : true;
        const toHoriz = toPt.dx !== undefined ? Math.abs(toPt.dx) > 0.5 : true;

        if (fromHoriz && toHoriz) {
            if ((fromPt.dx > 0 && midX < p2.x) || (fromPt.dx < 0 && midX > p2.x) ||
                (toPt.dx > 0 && midX < p5.x) || (toPt.dx < 0 && midX > p5.x)) {
                if (fromPt.dx === toPt.dx) {
                     midX = fromPt.dx > 0 ? Math.max(p2.x, p5.x) + STUB : Math.min(p2.x, p5.x) - STUB;
                } else {
                     path += ` L ${p2.x} ${midY} L ${p5.x} ${midY}`;
                     midX = null; 
                }
            }
            if (midX !== null) path += ` L ${midX} ${p2.y} L ${midX} ${p5.y}`;
        } else if (!fromHoriz && !toHoriz) {
            if ((fromPt.dy > 0 && midY < p2.y) || (fromPt.dy < 0 && midY > p2.y) ||
                (toPt.dy > 0 && midY < p5.y) || (toPt.dy < 0 && midY > p5.y)) {
                if (fromPt.dy === toPt.dy) {
                     midY = fromPt.dy > 0 ? Math.max(p2.y, p5.y) + STUB : Math.min(p2.y, p5.y) - STUB;
                } else {
                     path += ` L ${midX} ${p2.y} L ${midX} ${p5.y}`;
                     midY = null;
                }
            }
            if (midY !== null) path += ` L ${p2.x} ${midY} L ${p5.x} ${midY}`;
        } else if (fromHoriz && !toHoriz) {
            let safeX = p5.x;
            let safeY = p2.y;
            if ((fromPt.dx > 0 && p5.x < p2.x) || (fromPt.dx < 0 && p5.x > p2.x)) {
                safeX = p2.x + fromPt.dx * STUB;
                path += ` L ${safeX} ${p2.y} L ${safeX} ${p5.y}`; 
            } else if ((toPt.dy > 0 && p2.y > p5.y) || (toPt.dy < 0 && p2.y < p5.y)) {
                safeY = p5.y + toPt.dy * STUB;
                path += ` L ${p5.x} ${p2.y} L ${p5.x} ${safeY}`; 
            } else {
                path += ` L ${p5.x} ${p2.y}`;
            }
        } else {
            if ((fromPt.dy > 0 && p5.y < p2.y) || (fromPt.dy < 0 && p5.y > p2.y)) {
                let safeY = p2.y + fromPt.dy * STUB;
                path += ` L ${p2.x} ${safeY} L ${p5.x} ${safeY}`;
            } else if ((toPt.dx > 0 && p2.x > p5.x) || (toPt.dx < 0 && p2.x < p5.x)) {
                let safeX = p5.x + toPt.dx * STUB;
                path += ` L ${p2.x} ${p5.y} L ${safeX} ${p5.y}`;
            } else {
                path += ` L ${p2.x} ${p5.y}`;
            }
        }
        
        if (p5.x !== p6.x || p5.y !== p6.y) path += ` L ${p5.x} ${p5.y}`;
        path += ` L ${p6.x} ${p6.y}`;
        
        return path;
    },

    // Re-anchor one end of a polyline to newPt, keeping every other vertex.
    // The neighbouring vertex is carried along the axis the terminal segment ran
    // on, so an orthogonal wire stays orthogonal instead of going diagonal.
    _reanchorWireEnd(pts, which, newPt) {
        const EPS = 0.5;
        const i = which === 'from' ? 0 : pts.length - 1;
        const j = which === 'from' ? 1 : pts.length - 2;
        const old = pts[i];
        pts[i] = { x: newPt.x, y: newPt.y };
        if (j < 0 || j >= pts.length) return pts;
        const nb = pts[j];
        const wasVertical   = Math.abs(nb.x - old.x) < EPS;
        const wasHorizontal = Math.abs(nb.y - old.y) < EPS;
        // Diagonal terminal segment: nothing to preserve, leave the neighbour be.
        if (wasVertical)   pts[j] = { x: newPt.x, y: nb.y };
        else if (wasHorizontal) pts[j] = { x: nb.x, y: newPt.y };
        return pts;
    },

    // A symbol moved or rotated — bring its attached wires along.
    //
    //   This used to throw the whole path away and rebuild it with _smartRoute.
    //   That is fine for a wire that is only ever a straight pin-to-pin hop, and
    //   destructive for every other one: rotating a symbol 90 degrees discarded
    //   every bend the user had placed and replaced them with the router's guess,
    //   which is why wires appeared to "mess up" on rotate. The pin moved a few
    //   units; the wire redrew itself completely.
    //
    //   A symbol transform is new information about ONE point on the wire, so it
    //   should change one point on the wire. Re-anchor the affected end(s), keep
    //   the rest. Wholesale re-routing is still available, but only where the user
    //   explicitly asks for it (Ctrl+Shift+L, Straighten Wires).
    _updateAttachedWire(wirePath, movedSymId) {
        const fromSymId = wirePath.getAttribute('data-from-sym');
        const toSymId   = wirePath.getAttribute('data-to-sym');

        const d = wirePath.getAttribute('d') || '';
        let pts = [...d.matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/g)]
            .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
        if (pts.length < 2) return;

        const fromPt = fromSymId
            ? this._resolveSymPinPos(fromSymId, wirePath.getAttribute('data-from-pin') || '0')
            : null;
        const toPt = toSymId
            ? this._resolveSymPinPos(toSymId, wirePath.getAttribute('data-to-pin') || '0')
            : null;

        if (fromPt) pts = this._reanchorWireEnd(pts, 'from', fromPt);
        if (toPt)   pts = this._reanchorWireEnd(pts, 'to',   toPt);

        wirePath.setAttribute('d', this._polylinePath(pts));
    },

    // ── Feature 3: Alt+click wire → branch new wire from that point ──

    _startWireBranch(wirePath, clientX, clientY) {
        const svgPt = this.screenToSVG(clientX, clientY);

        // Snap to nearest point on the wire path
        const len = wirePath.getTotalLength?.() || 0;
        let branchPt = svgPt, bestDist = Infinity;
        for (let i = 0; i <= 60; i++) {
            const pt = wirePath.getPointAtLength(i / 60 * len);
            const d = Math.hypot(pt.x - svgPt.x, pt.y - svgPt.y);
            if (d < bestDist) { bestDist = d; branchPt = { x: pt.x, y: pt.y }; }
        }

        // Place junction dot at branch point
        const junc = document.createElementNS(this.SVG_NS, 'circle');
        junc.setAttribute('cx', branchPt.x);
        junc.setAttribute('cy', branchPt.y);
        junc.setAttribute('r', '4');
        junc.setAttribute('fill', wirePath.getAttribute('stroke') || '#4facfe');
        junc.setAttribute('class', 'wire-junction');
        junc.setAttribute('data-geo-class', 'junction');
        junc.setAttribute('pointer-events', 'none');
        this._contentRoot.appendChild(junc);

        // Switch to wire tool and start drawing from the branch point.
        // (Was setTool() — a method that does not exist, so Alt+click threw.)
        this.setActiveTool('wire');
        this._wireClick(branchPt);
    },

    // ── Wire cutting: geometry-preserving split + connector endpoints ──
    //
    //   A wire is one electrical run: connected pin → connected pin.  Cutting it
    //   must therefore produce two complete runs, each terminating in a CONNECTOR
    //   (a free endpoint that an unconnected symbol pin can later attach to).
    //
    //   What it must NOT do is re-route.  The old split fed both halves through
    //   _smartRoute, which recomputed elbows from scratch and happily drove the
    //   surviving half straight through the body of whatever symbol had just been
    //   inserted.  Re-routing is also just wrong on its own terms: the user drew
    //   those bends, and cutting a wire is not permission to redraw it.
    //
    //   So: keep every original vertex, insert the cut point, hand each half its
    //   own connector node.  Adding a symbol is optional — the cut and its two
    //   connectors exist whether or not anything gets placed there.

    // Locate pt on a polyline. Returns the index of the segment
    // coords[i] → coords[i+1] it projects onto, plus the projected point itself.
    _locateOnPolyline(coords, pt) {
        let best = { index: 0, point: coords[0], dist: Infinity };
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i], b = coords[i + 1];
            const vx = b.x - a.x, vy = b.y - a.y;
            const len2 = vx * vx + vy * vy;
            let t = len2 ? ((pt.x - a.x) * vx + (pt.y - a.y) * vy) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const p = { x: a.x + vx * t, y: a.y + vy * t };
            const dist = Math.hypot(p.x - pt.x, p.y - pt.y);
            if (dist < best.dist) best = { index: i, point: p, dist };
        }
        return best;
    },

    // Cut a vertex list at pt. Both halves keep every original vertex, so the
    // drawn geometry survives the split byte-for-byte apart from the new terminus.
    _splitPolylineAt(coords, pt) {
        const loc = this._locateOnPolyline(coords, pt);
        // Use the PROJECTED point, never the raw click. A click 3px off the wire
        // would otherwise become a real vertex 3px off the wire, kinking both
        // halves at the cut — the split has to land on the geometry it splits.
        const p = { x: loc.point.x, y: loc.point.y };
        const dedupe = arr => arr.filter((q, i) =>
            i === 0 || Math.hypot(q.x - arr[i - 1].x, q.y - arr[i - 1].y) > 1e-6);
        return {
            left:  dedupe(coords.slice(0, loc.index + 1).concat([p])),
            right: dedupe([p].concat(coords.slice(loc.index + 1))),
            point: p,
        };
    },

    // Literal M/L path through the given vertices — no elbow synthesis.
    _polylinePath(pts) {
        return pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
    },

    // A connector = an open wire terminus. Unconnected symbol pins snap to these.
    _makeWireConnector(pt, stroke) {
        const c = document.createElementNS(this.SVG_NS, 'circle');
        c.id = `conn_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        c.setAttribute('cx', pt.x);
        c.setAttribute('cy', pt.y);
        c.setAttribute('r', '3.5');
        c.setAttribute('class', 'wire-connector');
        c.setAttribute('data-geo-class', 'connector');
        c.setAttribute('fill', '#0f172a');
        c.setAttribute('stroke', stroke || '#4facfe');
        c.setAttribute('stroke-width', '1.5');
        c.setAttribute('pointer-events', 'none');
        return c;
    },

    // Read a wire's vertices + styling in one go. Resolves .wire-hitbox targets to
    // their visual sibling: reading stroke-width off the 12-wide hitbox is what
    // used to multiply stroke width 1→12→72 on successive splits.
    _readWireForSplit(wirePath) {
        const container = wirePath.closest('.wire-group') || wirePath;
        if (wirePath.classList.contains('wire-hitbox')) {
            const visual = container.querySelector(':not(.wire-hitbox)');
            if (visual) wirePath = visual;
        }
        const coords = [...(wirePath.getAttribute('d') || '')
            .matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/g)]
            .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
        if (coords.length < 2) return null;
        return {
            wirePath, container, coords,
            stroke:  wirePath.getAttribute('stroke') || '#4facfe',
            sWidth:  wirePath.getAttribute('stroke-width') || '2',
            fromSym: wirePath.getAttribute('data-from-sym'),
            fromPin: wirePath.getAttribute('data-from-pin'),
            toSym:   wirePath.getAttribute('data-to-sym'),
            toPin:   wirePath.getAttribute('data-to-pin'),
        };
    },

    // Core cut. Returns {seg1, seg2, connector, point} or null.
    // seg1 keeps the original from-anchor, seg2 keeps the original to-anchor;
    // the two new ends at the cut are both open connectors.
    _cutWire(wirePath, pt) {
        const info = this._readWireForSplit(wirePath);
        if (!info) return null;

        const { left, right, point } = this._splitPolylineAt(info.coords, pt);
        if (left.length < 2 || right.length < 2) return null;

        const mkSeg = (pts) => {
            const p = document.createElementNS(this.SVG_NS, 'path');
            p.id = `el_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
            p.setAttribute('d', this._polylinePath(pts));
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', info.stroke);
            p.setAttribute('stroke-width', info.sWidth);
            p.setAttribute('data-geo-class', 'wire');
            return p;
        };

        const seg1 = mkSeg(left);
        if (info.fromSym) {
            seg1.setAttribute('data-from-sym', info.fromSym);
            seg1.setAttribute('data-from-pin', info.fromPin || '0');
        }
        const seg2 = mkSeg(right);
        if (info.toSym) {
            seg2.setAttribute('data-to-sym', info.toSym);
            seg2.setAttribute('data-to-pin', info.toPin || '0');
        }

        const connector = this._makeWireConnector(point, info.stroke);
        connector.setAttribute('data-wire-a', seg1.id);
        connector.setAttribute('data-wire-b', seg2.id);

        const parent = info.container.parentNode;
        if (!parent) return null;
        parent.insertBefore(seg1, info.container);
        parent.insertBefore(seg2, info.container);
        parent.insertBefore(connector, info.container);
        info.container.remove();

        return { seg1, seg2, connector, point };
    },

    // ── Feature 1: Dblclick wire → cut, then optionally insert a symbol ──

    _splitWireAtClick(wirePath, clientX, clientY) {
        const info = this._readWireForSplit(wirePath);
        if (!info) return;

        const svgPt = this.screenToSVG(clientX, clientY);
        const before = this._captureFullState();

        const cut = this._cutWire(info.wirePath, svgPt);
        if (!cut) {
            // Cutting AT a terminus would leave a zero-length half — that is not a
            // cut, it is the endpoint that is already there.
            this.showToast('Cut point is on an endpoint — double-click along the wire body', 'error');
            return;
        }

        this.pushHistory('Cut Wire', before, this._captureFullState());
        this._scheduleGeoAnalysis?.();

        // The picker is an offer, not a requirement — dismissing it leaves the two
        // segments and their connector exactly as the cut made them.
        this._showSymbolPicker(cut.point, cut.seg1, clientX, clientY, cut.seg2);
    },

    // ── Wire-body snap utilities ─────────────────────────────────────────

    // 80-step sample of a path; returns {x,y,t,dist} closest to pt.
    _closestPointOnPath(wirePath, pt) {
        const len = wirePath.getTotalLength?.() || 0;
        if (!len) return null;
        let bx = pt.x, by = pt.y, bd = Infinity, bt = 0;
        for (let i = 0; i <= 80; i++) {
            const t = i / 80;
            const p = wirePath.getPointAtLength(t * len);
            const d = Math.hypot(p.x - pt.x, p.y - pt.y);
            if (d < bd) { bd = d; bx = p.x; by = p.y; bt = t; }
        }
        return { x: bx, y: by, t: bt, dist: bd };
    },

    // Closest point on wire BODY — returns null if snap is at either endpoint (within endpointEPS).
    _closestWireBodySnap(wirePath, pt, endpointEPS = 6) {
        const snap = this._closestPointOnPath(wirePath, pt);
        if (!snap) return null;
        const coords = [...(wirePath.getAttribute('d') || '')
            .matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/g)]
            .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
        if (coords.length < 2) return null;
        const s = coords[0], e = coords[coords.length - 1];
        if (Math.hypot(snap.x - s.x, snap.y - s.y) < endpointEPS) return null;
        if (Math.hypot(snap.x - e.x, snap.y - e.y) < endpointEPS) return null;
        return snap;
    },

    // Nearest wire-body snap for a point across all drawn wires; skips IDs in excludeIds.
    _findNearestWireBodySnap(pt, threshold = 14, excludeIds = new Set()) {
        let best = null, bestDist = threshold;
        this._contentRoot?.querySelectorAll('path[data-geo-class="wire"]').forEach(wire => {
            if (excludeIds.has(wire.id)) return;
            const snap = this._closestWireBodySnap(wire, pt);
            if (snap && snap.dist < bestDist) { bestDist = snap.dist; best = { wire, pt: snap }; }
        });
        return best;
    },

    // Nearest OPEN (unconnected) wire endpoint within threshold.
    // Returns {wire, pt:{x,y}, which:'from'|'to', dist} or null.
    _findNearestWireEndpointSnap(pt, threshold = 16, excludeIds = new Set()) {
        let best = null, bestDist = threshold;
        this._contentRoot?.querySelectorAll('path[data-geo-class="wire"]').forEach(wire => {
            if (excludeIds.has(wire.id)) return;
            const coords = [...(wire.getAttribute('d') || '')
                .matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/g)]
                .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
            if (coords.length < 2) return;
            if (!wire.getAttribute('data-from-sym')) {
                const dist = Math.hypot(coords[0].x - pt.x, coords[0].y - pt.y);
                if (dist < bestDist) { bestDist = dist; best = { wire, pt: coords[0], which: 'from', dist }; }
            }
            if (!wire.getAttribute('data-to-sym')) {
                const ep = coords[coords.length - 1];
                const dist = Math.hypot(ep.x - pt.x, ep.y - pt.y);
                if (dist < bestDist) { bestDist = dist; best = { wire, pt: ep, which: 'to', dist }; }
            }
        });
        return best;
    },

    // Build exclude-set: selected element IDs + IDs of wires already attached to them.
    _buildSnapExcludeIds() {
        const selIds = new Set(this._selection.map(e => e.id).filter(Boolean));
        const excludeIds = new Set(selIds);
        this._contentRoot?.querySelectorAll('path[data-geo-class="wire"]').forEach(wire => {
            const fs = wire.getAttribute('data-from-sym'), ts = wire.getAttribute('data-to-sym');
            if ((fs && selIds.has(fs)) || (ts && selIds.has(ts))) excludeIds.add(wire.id);
        });
        return excludeIds;
    },

    // Commit a snap result onto the SVG: endpoint snap → set data-from/to-sym attributes
    // so the wire follows the symbol; body snap → split wire + T-junction.
    _commitWireSnap(snap, symEl) {
        if (!snap || !symEl?.id) return;
        if (snap.type === 'endpoint') {
            const symAttr = snap.which === 'from' ? 'data-from-sym' : 'data-to-sym';
            const pinAttr = snap.which === 'from' ? 'data-from-pin' : 'data-to-pin';
            snap.wire.setAttribute(symAttr, symEl.id);
            snap.wire.setAttribute(pinAttr, snap.pinEl?.getAttribute('data-pin') || '0');
        } else {
            const split = this._splitWireAtPoint(snap.wire, snap.snapPt);
            if (split) {
                split.seg1.setAttribute('data-to-sym', symEl.id);
                split.seg1.setAttribute('data-to-pin', snap.pinEl?.getAttribute('data-pin') || '0');
                symEl.setAttribute('data-wire-snap', split.seg1.id);
            }
        }
        this._scheduleGeoAnalysis?.();
    },

    // Compute snap adjustment for the current drag (call AFTER applying transforms).
    // Endpoint snap takes priority (just a link); body snap creates a T-junction on commit.
    _computeWireSnapAdjustment() {
        const THRESHOLD = 16;
        const excludeIds = this._buildSnapExcludeIds();
        let bestAdj = null, bestDist = THRESHOLD;
        this._selection.forEach(el => {
            if (!el.classList.contains('domain-symbol')) return;
            el.querySelectorAll('.pin-point').forEach(pin => {
                const pp = this._pinWorldPos(pin);
                // Priority 1: open wire endpoint
                const ep = this._findNearestWireEndpointSnap(pp, THRESHOLD, excludeIds);
                if (ep && ep.dist < bestDist) {
                    bestDist = ep.dist;
                    bestAdj = { type: 'endpoint', dx: ep.pt.x - pp.x, dy: ep.pt.y - pp.y,
                                wire: ep.wire, which: ep.which, snapPt: ep.pt, pinEl: pin, symEl: el };
                }
                // Priority 2: wire body (mid-wire T-junction on drop)
                const body = this._findNearestWireBodySnap(pp, THRESHOLD, excludeIds);
                if (body && body.pt.dist < bestDist) {
                    bestDist = body.pt.dist;
                    bestAdj = { type: 'body', dx: body.pt.x - pp.x, dy: body.pt.y - pp.y,
                                wire: body.wire, snapPt: body.pt, pinEl: pin, symEl: el };
                }
            });
        });
        return bestAdj;
    },

    // One-shot snap for a freshly placed symbol (wider threshold for imprecise drops).
    _trySnapSymbolToWire(symEl) {
        const THRESHOLD = 20;
        const excludeIds = new Set([symEl.id].filter(Boolean));
        let best = null, bestDist = THRESHOLD;
        symEl.querySelectorAll('.pin-point').forEach(pin => {
            const pp = this._pinWorldPos(pin);
            const ep = this._findNearestWireEndpointSnap(pp, THRESHOLD, excludeIds);
            if (ep && ep.dist < bestDist) {
                bestDist = ep.dist;
                best = { type: 'endpoint', dx: ep.pt.x - pp.x, dy: ep.pt.y - pp.y,
                         wire: ep.wire, which: ep.which, snapPt: ep.pt, pinEl: pin };
            }
            const body = this._findNearestWireBodySnap(pp, THRESHOLD, excludeIds);
            if (body && body.pt.dist < bestDist) {
                bestDist = body.pt.dist;
                best = { type: 'body', dx: body.pt.x - pp.x, dy: body.pt.y - pp.y,
                         wire: body.wire, snapPt: body.pt, pinEl: pin };
            }
        });
        return best;
    },

    // A T-junction is a cut whose meeting point is electrically shared rather than
    // left open, so it reuses _cutWire and swaps the connector for a junction dot.
    // Same rule applies: original vertices are preserved, nothing is re-routed.
    _splitWireAtPoint(wirePath, pt) {
        const cut = this._cutWire(wirePath, pt);
        if (!cut) return null;

        const junc = document.createElementNS(this.SVG_NS, 'circle');
        junc.id = cut.connector.id;
        junc.setAttribute('cx', cut.point.x);
        junc.setAttribute('cy', cut.point.y);
        junc.setAttribute('r', '4');
        junc.setAttribute('class', 'wire-junction');
        junc.setAttribute('data-geo-class', 'junction');
        junc.setAttribute('pointer-events', 'none');
        // Carry the wire refs across or the junction cannot re-seat itself later.
        junc.setAttribute('data-wire-a', cut.seg1.id);
        junc.setAttribute('data-wire-b', cut.seg2.id);
        cut.connector.replaceWith(junc);

        return { seg1: cut.seg1, seg2: cut.seg2, junc };
    },

    // Called after a new wire is committed: if the terminal point lands on another wire's
    // body (not at an endpoint), split that wire and insert a T-junction circle.
    _checkWireTJunction(newWire, terminalPt) {
        const found = this._findNearestWireBodySnap(terminalPt, 8, new Set([newWire.id].filter(Boolean)));
        if (!found) return;
        const before = this._captureFullState();
        this._splitWireAtPoint(found.wire, { x: found.pt.x, y: found.pt.y });
        this.pushHistory('T-Junction', before, this._captureFullState());
        this._scheduleGeoAnalysis?.();
    },

    // ── Feature 5 + 2: Net glow — highlight all wires in the same net ──

    _highlightNetForWire(wirePath) {
        this._clearNetHighlight();
        if (!wirePath) return;

        const endpointsOf = (w) => {
            const pts = [...(w.getAttribute('d') || '')
                .matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/g)]
                .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
            return pts.length ? [pts[0], pts[pts.length - 1]] : [];
        };

        // BFS: find all wires connected by endpoint proximity
        const EPS = 2;
        const visited = new Set([wirePath]);
        const queue = [endpointsOf(wirePath)];

        while (queue.length) {
            const eps = queue.shift();
            if (!eps.length) continue;
            this._contentRoot?.querySelectorAll('path[data-geo-class="wire"]').forEach(w => {
                if (visited.has(w)) return;
                const we = endpointsOf(w);
                if (!we.length) return;
                const connected = eps.some(a => we.some(b =>
                    Math.hypot(a.x - b.x, a.y - b.y) < EPS));
                if (connected) { visited.add(w); queue.push(we); }
            });
        }

        // Feature 2: also pull in wires sharing the same net label (disconnected nets)
        const netName = this._getNetLabelForWire(wirePath);
        if (netName) {
            this._contentRoot?.querySelectorAll('path[data-geo-class="wire"]').forEach(w => {
                if (!visited.has(w) && this._getNetLabelForWire(w) === netName) {
                    visited.add(w);
                }
            });
        }

        visited.forEach(w => w.classList.add('wire-net-highlight'));
        this._netHighlightSet = visited;
    },

    // Returns the net-label text attached to a wire endpoint, or null.
    _getNetLabelForWire(wirePath) {
        const pts = [...(wirePath.getAttribute('d') || '')
            .matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/g)]
            .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
        if (!pts.length) return null;
        const start = pts[0], end = pts[pts.length - 1];
        const EPS = 12;
        let found = null;
        this._contentRoot?.querySelectorAll('.domain-symbol[data-symbol="net-label"]').forEach(sym => {
            const pin = sym.querySelector('.pin-point');
            if (!pin) return;
            const pp = this._pinWorldPos(pin);
            if (Math.hypot(pp.x - start.x, pp.y - start.y) < EPS ||
                Math.hypot(pp.x - end.x,   pp.y - end.y)   < EPS) {
                found = sym.querySelector('.sym-value')?.textContent?.trim() || null;
            }
        });
        return found;
    },

    _clearNetHighlight() {
        this._contentRoot?.querySelectorAll('.wire-net-highlight')
            .forEach(w => w.classList.remove('wire-net-highlight'));
        this._netHighlightSet = null;
    },

    // ── Feature 8: Auto-straighten selected wires ──

    _straightenSelectedWires() {
        const wires = this._selection.filter(el => el.getAttribute('data-geo-class') === 'wire');
        if (!wires.length) { this.showToast('Select one or more wires first', 'info'); return; }

        const before = this._captureFullState();
        wires.forEach(w => {
            const pts = [...(w.getAttribute('d') || '')
                .matchAll(/[ML]\s*([\d.eE+\-]+)[,\s]+([\d.eE+\-]+)/g)]
                .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
            if (pts.length < 2) return;
            const f = pts[0], t = pts[pts.length - 1];
            w.setAttribute('d', `M ${f.x} ${f.y} L ${f.x} ${t.y} L ${t.x} ${t.y}`);
        });
        this._updateWiresForSelection();
        const after = this._captureFullState();
        this.pushHistory('Straighten Wires', before, after);
        this.showToast(`Straightened ${wires.length} wire${wires.length > 1 ? 's' : ''}`, 'success');
    },

    // ── Marquee (Ctrl+Drag) Selection ─────────────────────────

    _startMarquee(e) {
        const svgStart = this.screenToSVG(e.clientX, e.clientY);
        this._marqueeState = { startSVG: svgStart, currentSVG: { ...svgStart } };
        this._marqueeCandidates = new Set();

        const onMove = (ev) => {
            this._marqueeState.currentSVG = this.screenToSVG(ev.clientX, ev.clientY);
            // Recomputing the hit set every frame is the whole point: the user gets
            // the same "is this in?" answer the wire-hover glow gives, before
            // committing. Throttled to one pass per frame alongside the overlay.
            if (!this._marqueeRafPending) {
                this._marqueeRafPending = true;
                requestAnimationFrame(() => {
                    this._marqueeRafPending = false;
                    if (this._marqueeState) this._updateMarqueeCandidates();
                });
            }
            this._scheduleOverlayRender();
        };

        const onUp = () => {
            $(document).off('mousemove.marquee mouseup.marquee');
            this._clearMarqueeCandidates();
            this._commitMarquee();
            this._marqueeState = null;
            this._scheduleOverlayRender();
        };

        $(document).on('mousemove.marquee', onMove).on('mouseup.marquee', onUp);
    },

    // ── Marquee candidate preview ─────────────────────────────
    //   Elements the current marquee WOULD capture get .se-marquee-candidate,
    //   the same live-feedback idea as the net glow on wire hover.

    _updateMarqueeCandidates() {
        if (!this._marqueeState) return;
        const box = this._marqueeBounds();
        const next = new Set(box ? this._collectMarqueeHits(box) : []);
        const prev = this._marqueeCandidates || new Set();

        prev.forEach(el => { if (!next.has(el)) el.classList.remove('se-marquee-candidate'); });
        next.forEach(el => { if (!prev.has(el)) el.classList.add('se-marquee-candidate'); });
        this._marqueeCandidates = next;
    },

    _clearMarqueeCandidates() {
        this._marqueeCandidates?.forEach(el => el.classList.remove('se-marquee-candidate'));
        this._marqueeCandidates = null;
        // Belt and braces: a candidate removed from the DOM mid-drag would keep the
        // class if it ever came back through undo.
        this._contentRoot?.querySelectorAll('.se-marquee-candidate')
            .forEach(el => el.classList.remove('se-marquee-candidate'));
    },

    // World-space bounds of the in-flight marquee, or null when it is still a click.
    _marqueeBounds() {
        if (!this._marqueeState) return null;
        const { startSVG, currentSVG } = this._marqueeState;
        const b = {
            x1: Math.min(startSVG.x, currentSVG.x),
            y1: Math.min(startSVG.y, currentSVG.y),
            x2: Math.max(startSVG.x, currentSVG.x),
            y2: Math.max(startSVG.y, currentSVG.y),
        };
        return (b.x2 - b.x1 < 4 && b.y2 - b.y1 < 4) ? null : b;
    },

    _drawMarquee(ctx) {
        const { startSVG, currentSVG } = this._marqueeState;
        const tl = this._worldToOverlayScreen(
            Math.min(startSVG.x, currentSVG.x), Math.min(startSVG.y, currentSVG.y));
        const br = this._worldToOverlayScreen(
            Math.max(startSVG.x, currentSVG.x), Math.max(startSVG.y, currentSVG.y));
        const w = br.x - tl.x, h = br.y - tl.y;
        ctx.save();
        ctx.fillStyle = 'rgba(79,172,254,0.08)';
        ctx.fillRect(tl.x, tl.y, w, h);
        ctx.strokeStyle = '#4facfe';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(tl.x, tl.y, w, h);
        ctx.restore();
    },

    // Every element the world-space box {x1,y1,x2,y2} would capture.
    // Single source of truth for both the live preview and the commit, so what
    // lights up during the drag is exactly what ends up selected.
    _collectMarqueeHits({ x1, y1, x2, y2 }) {
        const svg = this.$svgDisplay[0];
        const seen = new Set();
        const hits = [];

        // Mirror selectAll()'s exclusion list — the proven filter for this SVG structure.
        // Critically: do NOT filter by el.id — domain symbols placed via domainManager
        // bypass _commitElement and have no id, but are still valid targets.
        this.$svgDisplay.find('*').not(
            '#_cameraRotGroup, [data-se-system="true"], [data-se-system="true"] *, .snap-guide, .draw-preview, ' +
            '.selection-handle-group, .selection-handle, .rotation-handle'
        ).each((_, el) => {
            if (!el.dataset || el.dataset.locked === 'true' || el.id?.startsWith('_')) return;

            // Hitbox clones are interaction plumbing, not content — selecting one
            // as its own element double-counts the wire/component it belongs to.
            if (el.classList.contains('wire-hitbox') || el.classList.contains('component-hitbox')) return;
            // Wire visuals live inside .wire-group wrappers; select the visual path,
            // never the wrapper group (it has no id and confuses group-move logic).
            if (el.classList.contains('wire-group') || el.classList.contains('component-group')) return;

            let bb;
            try { bb = el.getBBox(); } catch (_) { return; }
            if (!bb || (bb.width === 0 && bb.height === 0)) return;

            // Walk transform chain from element up to _cameraRotGroup (doc-local boundary)
            let m = new DOMMatrix();
            let node = el;
            while (node && node !== svg && node.id !== '_cameraRotGroup') {
                const tv = node.transform?.baseVal;
                if (tv?.length) {
                    const lm = tv.consolidate()?.matrix;
                    if (lm) m = new DOMMatrix([lm.a, lm.b, lm.c, lm.d, lm.e, lm.f]).multiply(m);
                }
                node = node.parentElement;
            }

            // Project all 4 tight bbox corners to world (doc-local) space
            let elMinX = Infinity, elMinY = Infinity, elMaxX = -Infinity, elMaxY = -Infinity;
            [[bb.x, bb.y], [bb.x + bb.width, bb.y],
            [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]].forEach(([px, py]) => {
                const tp = new DOMPoint(px, py).matrixTransform(m);
                elMinX = Math.min(elMinX, tp.x); elMinY = Math.min(elMinY, tp.y);
                elMaxX = Math.max(elMaxX, tp.x); elMaxY = Math.max(elMaxY, tp.y);
            });

            // AABB overlap on both axes
            if (elMaxX < x1 || elMinX > x2 || elMaxY < y1 || elMinY > y2) return;

            // Prefer the top-level domain-symbol or user group over inner shapes
            const target = el.closest('g[id^="group_"]') || el.closest('.domain-symbol') || el;
            if (!seen.has(target)) {
                seen.add(target);
                hits.push(target);
            }
        });

        return hits;
    },

    _commitMarquee() {
        const box = this._marqueeBounds();

        // Treat tiny drags as plain click on empty canvas (deselect all)
        if (!box) { this.deselectAll(); return; }

        const hits = this._collectMarqueeHits(box);
        this.deselectAll();
        hits.forEach(el => this.selectEl(el, true));
        if (hits.length) this.showToast(`${hits.length} element${hits.length > 1 ? 's' : ''} selected`, 'success');
    },

    // ── Canvas Event Binding ──────────────────────────────────

    // True when the pointer is over something a drag would actually MOVE.
    // Backdrop (page rect, grid, guides, any [data-se-system] node) is not an
    // object; neither is a locked element, since dragging it is refused anyway
    // and a move cursor there would be a promise the editor won't keep.
    _objectUnderPointer(target) {
        if (!target || !target.closest) return false;
        if (target.closest('[data-se-system="true"]')) return false;
        if (target.id === '_gridLayer' || target.id === '_canvasBg') return false;
        if (target.classList?.contains('snap-guide')) return false;
        if (target.classList?.contains('draw-preview')) return false;
        if (target.closest('[data-locked="true"]')) return false;
        return !!target.closest('#_cameraRotGroup > *');
    },

    // Bidirectional resize cursors per handle id.  'rotate' uses crosshair.
    _HANDLE_CURSORS: {
        nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize',
        e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize',
        sw: 'nesw-resize', w: 'ew-resize',
        rotate: 'crosshair',
    },

    _bindCanvasEvents() {
        // Double-click inside a grouped symbol → select the individual child
        // (single click selects the whole group; Figma/draw.io convention)
        this.$svgDisplay.on('dblclick.canvas', (e) => {
            if (this.activeTool !== 'select') return;
            const sym = e.target.closest?.('.domain-symbol, g[id^="group_"]');
            if (!sym || e.target === sym) return;
            if (e.target.classList.contains('component-hitbox')) return;
            e.preventDefault();
            e.stopPropagation();
            this.deselectAll();
            this.selectEl(e.target);
            this.showToast('Element inside group selected — click canvas to exit', 'success');
        });

        // Hovering a wire lights up its whole electrically-connected net —
        // the "is this actually one net?" question answered without a click.
        this.$svgDisplay.on('mouseenter.net', '.wire-hitbox', (e) => {
            if (this.activeTool !== 'select') return;
            const visual = e.target.previousElementSibling;
            if (visual?.getAttribute('data-geo-class') === 'wire')
                this._highlightNetForWire(visual);
        });
        this.$svgDisplay.on('mouseleave.net', '.wire-hitbox', () => {
            // Keep the glow if a wire in the net is actively selected
            if (!this._selection.some(el => el.getAttribute?.('data-geo-class') === 'wire'))
                this._clearNetHighlight();
        });

        // Cursor on hover. The cursor's job is to answer "what will a drag from
        // here do?" before the user commits to finding out:
        //   over a resize/rotate handle → that handle's direction
        //   over a draggable object     → move
        //   over empty canvas           → default (a drag marquees, not moves)
        // Set on the container, which is why the SVG shapes use cursor:inherit.
        this.$svgDisplay.on('mousemove.canvasCursor', (e) => {
            if (this.activeTool !== 'select') return;
            // A drag in progress owns the cursor. Freezing here is also what keeps
            // the handle cursor pinned for the length of a resize: the container
            // simply holds the value this handler last wrote.
            if (this.isDragging || this._moveActive || this._handleDragActive) return;
            let cursor = '';
            if (this._useCanvasHandles) {
                const handleId = this._hitTestOverlayHandles(e.clientX, e.clientY);
                // Wire endpoint/bend handles have no directional cursor — they move.
                if (handleId) cursor = this._HANDLE_CURSORS[handleId] || 'move';
            }
            if (!cursor && this._objectUnderPointer(e.target)) cursor = 'move';
            this.$svgContainer[0].style.cursor = cursor;
        });

        // Click on canvas — select element or deselect
        this.$svgDisplay.on('mousedown.canvas', (e) => {
            if (!this._isObjectTool()) return;
            // Left button only. Middle mouse is the universal pan gesture and must
            // reach startDrag untouched — without this it selected whatever it
            // landed on, or cleared the selection when it landed on background.
            if (e.button !== 0) return;

            // Step 10: Canvas handle hit-test check
            if (this._useCanvasHandles) {
                const handleId = this._hitTestOverlayHandles(e.clientX, e.clientY);
                if (handleId) {
                    e.stopPropagation();
                    e.preventDefault();
                    this._startHandleInteraction(handleId, e.clientX, e.clientY);
                    return;
                }
            }

            const target = e.target;
            const ignored = ['svg', 'svgDisplay', '_cameraRotGroup'];
            const isIgnored = ignored.includes(target.id) || target.tagName.toLowerCase() === 'svg' ||
                target.closest('[data-se-system="true"]') ||
                target.dataset?.seSystem === 'true' ||
                target.classList.contains('snap-guide') ||
                target.classList.contains('draw-preview') ||
                target.closest('.selection-handle-group');

            // Plain drag on background → marquee selection (Excalidraw/Figma
            // convention). Space swaps to the hand tool outright, so this handler
            // has already bailed by then; middle-mouse pans via startDrag.
            if (isIgnored && !target.closest('.selection-handle-group') &&
                e.button === 0) {
                e.preventDefault();
                e.stopPropagation();
                this._startMarquee(e);
                return;
            }

            if (isIgnored && !target.closest('.selection-handle-group')) {
                this.deselectAll();
                this._clearNetHighlight();
                return;
            }

            if (target.closest('.selection-handle-group')) return; // handled by handle events

            // Find the real element (not hitbox wrapper)
            let el = target;
            if (el.classList.contains('wire-hitbox') || el.classList.contains('component-hitbox')) {
                el = el.previousElementSibling || el;
            }

            if (el.id === '_gridLayer' || el.id === 'svgDisplay' || el.tagName.toLowerCase() === 'svg') {
                this.deselectAll();
                return;
            }

            // Walk up to the parent domain-symbol OR user-created group so the
            // whole unit gets selected. Outermost user group wins (nested groups).
            const symGroup = el.closest('.domain-symbol, g[id^="group_"]');
            if (symGroup) {
                el = symGroup;
                let p = el.parentElement;
                while (p && p.id !== '_cameraRotGroup') {
                    if (p.tagName === 'g' && p.id?.startsWith('group_')) el = p;
                    p = p.parentElement;
                }
            }

            // Alt + click on a drawn wire → branch a new wire from that point
            if (e.altKey && !symGroup) {
                const isWire = el.tagName === 'path' && el.getAttribute('data-geo-class') === 'wire';
                if (isWire) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._startWireBranch(el, e.clientX, e.clientY);
                    return;
                }
            }

            // Locked elements (canvas background, grid) cannot be selected
            if (el.dataset?.locked === 'true') {
                this.showToast('Element is locked — unlock in Layers panel to edit', 'error');
                return;
            }

            e.stopPropagation();

            // If the clicked element is already part of the active selection, preserve
            // the whole group — don't call selectEl (which would reset to single-element).
            // Go straight to move so the entire selection set drags together.
            if (this._selection.includes(el)) {
                this._startMoveSelected(e.clientX, e.clientY);
                return;
            }

            // Shift/Ctrl → additive; plain click → exclusive (replaces existing selection)
            this.selectEl(el, e.shiftKey || e.ctrlKey || e.metaKey);

            // Net glow: clicking a wire highlights its entire connected net
            if (el.getAttribute('data-geo-class') === 'wire') {
                this._highlightNetForWire(el);
            } else {
                this._clearNetHighlight();
            }

            // Execute Trace mode simultaneously if active
            if (this.isWireTracing) {
                const wire = this.wires?.find(w =>
                    w.element === el || w.$hitbox?.[0] === el || w.$group?.[0] === el);
                if (wire) this.traceWirePath(wire);
                else {
                    const comp = this.components?.find(c =>
                        c.element === el || c.$hitbox?.[0] === el || c.$group?.[0] === el);
                    if (comp) this.traceComponent(comp);
                }
            }

            if (this._selection.includes(el)) {
                this._startMoveSelected(e.clientX, e.clientY);
            }
        });

        // Double-click → inline text edit if target is <text> inside a domain-symbol
        //              → split + insert if target is a drawn wire path
        this.$svgDisplay.on('dblclick.canvas', (e) => {
            if (this.activeTool !== 'select') return;

            // Wire: split at click point and open symbol picker to insert in-series
            if (e.target.tagName === 'path' && e.target.getAttribute('data-geo-class') === 'wire') {
                e.preventDefault();
                e.stopPropagation();
                this._splitWireAtClick(e.target, e.clientX, e.clientY);
                return;
            }

            let textEl = e.target.tagName?.toLowerCase() === 'text'
                ? e.target
                : e.target.closest?.('text');

            if (!textEl) {
                const group = e.target.closest?.('.domain-symbol');
                if (group) {
                    textEl = group.querySelector('text.sym-value') || group.querySelector('text');
                }
            }

            if (!textEl) return;
            if (!textEl.closest('.domain-symbol')) return;
            
            e.preventDefault();
            e.stopPropagation();
            this._editSymbolText(textEl);
        });

        // Arrow key nudge — the keyboard equivalent of a move, so both object tools
        $(document).on('keydown.canvas', (e) => {
            if (!this._isObjectTool()) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (!this._selection.length) return;

            const step = e.shiftKey ? 10 : 1;
            let dx = 0, dy = 0;
            if (e.key === 'ArrowLeft') dx = -step;
            if (e.key === 'ArrowRight') dx = step;
            if (e.key === 'ArrowUp') dy = -step;
            if (e.key === 'ArrowDown') dy = step;
            if (!dx && !dy) return;

            e.preventDefault();
            const before = this._captureFullState();
            this._selection.forEach(el => {
                const t = el.getAttribute('transform') || '';
                el.setAttribute('transform', `translate(${dx},${dy}) ${t}`);
            });
            this._renderHandles();
            const after = this._captureFullState();
            this.pushHistory('Nudge', before, after);
            this._refreshPropertyPanel();
        });

        // Ctrl/Cmd+Shift+L — straighten selected wires
        $(document).on('keydown.straighten', (e) => {
            const ctrl = e.ctrlKey || e.metaKey;
            if (ctrl && e.shiftKey && e.code === 'KeyL') {
                e.preventDefault();
                this._straightenSelectedWires();
            }
        });
    },

    // ── Inline text editing for <text> nodes inside domain-symbol groups ──
    _editSymbolText(textEl) {
        let bb;
        try { bb = textEl.getBoundingClientRect(); } catch (_) { return; }

        // Lock all camera gestures so pan/zoom while the input is open can't
        // detach the input from the element it belongs to.
        this._textEditActive = true;
        if (this._hammer) this._hammer.set({ enable: false });

        const restoreCamera = () => {
            this._textEditActive = false;
            if (this._hammer) this._hammer.set({ enable: true });
        };

        const input = document.createElement('input');
        input.type = 'text';
        input.value = textEl.textContent.trim();

        const fontSize = parseFloat(textEl.getAttribute('font-size') || '12');
        const fontFamily = textEl.getAttribute('font-family') || 'monospace';
        const zoom = this.camera?.zoom || 1;

        input.style.cssText = [
            `position:fixed`,
            `left:${bb.left - 4}px`,
            `top:${bb.top - 2}px`,
            `min-width:${Math.max(bb.width + 8, 60)}px`,
            `height:${Math.max(bb.height + 4, 18)}px`,
            `font-size:${Math.round(fontSize * zoom)}px`,
            `font-family:${fontFamily}`,
            `text-align:center`,
            `background:rgba(15,25,45,0.96)`,
            `color:#e8f4ff`,
            `border:1px solid #4facfe`,
            `border-radius:3px`,
            `padding:1px 4px`,
            `z-index:9999`,
            `outline:none`,
            `box-shadow:0 0 8px rgba(79,172,254,0.4)`,
        ].join(';');

        document.body.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = () => {
            if (committed) return;
            committed = true;
            restoreCamera();
            const before = this._captureFullState();
            textEl.textContent = input.value.trim() || textEl.textContent;
            const after = this._captureFullState();
            this.pushHistory('Edit Text', before, after);
            input.remove();
            if (typeof this.buildLayersTree === 'function') this.buildLayersTree();
        };

        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { committed = true; restoreCamera(); input.remove(); }
        });
        input.addEventListener('blur', commit);
    },

    // ── Per-command attribute diff history (replaces full innerHTML) ───

    /** Capture a lightweight snapshot: just the attributes of every SVG element.
     *  _cameraRotGroup is excluded: its transform= is camera state, not document state.
     *  Including it would make Ctrl+Z un-rotate the view rather than undo an edit. */
    _captureFullState() {
        const els = {};
        const svg = this.$svgDisplay[0];
        // Select all elements within the content root (where user drawings live)
        // AND any other significant children of the display.
        const allElements = svg.querySelectorAll('*');
        
        allElements.forEach(el => {
            if (el.id === '_cameraRotGroup') return;
            // Skip system-only overlays and guides
            if (el.dataset?.seSystem === 'true' || el.classList?.contains('snap-guide') ||
                el.classList?.contains('draw-preview') || el.id === '_gridLayer') return;
            
            // Assign a stable ID if missing (crucial for attribute-diff history to track the element)
            if (!el.id && el.tagName !== 'svg' && el.tagName !== 'defs') {
                el.id = `auto_${Math.random().toString(36).substr(2, 9)}`;
            }
            if (!el.id) return;

            const attrs = {};
            for (const a of el.attributes) attrs[a.name] = a.value;
            els[el.id] = { tag: el.tagName, attrs, parentId: el.parentElement?.id || '' };
        });
        return JSON.stringify(els);
    },

    /** Restore from a snapshot: apply attribute diffs only, no innerHTML teardown.
     *  _cameraRotGroup is skipped so undo never un-rotates the view. */
    _restoreFullState(snapshot) {
        let state;
        try { state = JSON.parse(snapshot); } catch (_) {
            this.$svgDisplay[0].innerHTML = snapshot;
            this._selection = [];
            this._selectionBox = null;
            if (typeof this._runGeometryPipeline === 'function') this._runGeometryPipeline();
            return;
        }

        const svg = this.$svgDisplay[0];

        // 1. Deep clean: Explicitly strip hitboxes to prevent ID collisions and ghosting
        svg.querySelectorAll('.wire-group, .component-group').forEach(g => {
            const visual = g.querySelector(':not(.wire-hitbox):not(.component-hitbox)');
            if (visual) g.parentNode?.insertBefore(visual, g);
            g.remove();
        });
        svg.querySelectorAll('.wire-hitbox, .component-hitbox').forEach(h => h.remove());

        // Remove elements not in snapshot (but preserve system elements)
        svg.querySelectorAll('[id]').forEach(el => {
            if (el.id === '_cameraRotGroup') return;
            if (el.id === '_gridLayer' || el.id === '_gridDefs') return;
            if (el.dataset?.seSystem === 'true') return;
            if (!state[el.id]) el.remove();
        });
        // Apply attribute diffs
        Object.entries(state).forEach(([id, { tag, attrs, parentId }]) => {
            if (id === '_cameraRotGroup') return;  // camera state, skip
            let el = svg.querySelector(`#${CSS.escape(id)}`);
            if (!el) {
                el = document.createElementNS(this.SVG_NS, tag);
                el.id = id;
                const parent = parentId ? (svg.querySelector(`#${CSS.escape(parentId)}`) || svg) : svg;
                parent.appendChild(el);
            }
            // Sync attributes
            const existing = new Set(Array.from(el.attributes).map(a => a.name));
            Object.entries(attrs).forEach(([k, v]) => { el.setAttribute(k, v); existing.delete(k); });
            existing.forEach(k => el.removeAttribute(k));
        });

        this._selection = [];
        this._selectionBox = null;

        // Force rebuild of graph and recreate fresh hitboxes based on the restored geometry
        if (typeof this._runGeometryPipeline === 'function') this._runGeometryPipeline();
        this._syncWireNodes?.();
        // Undo can add or remove elements, so chips need a full rebuild here,
        // not just a re-projection.
        if (this._labelsOn) this._renderLabels?.();
    },
});
