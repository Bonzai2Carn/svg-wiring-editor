/* ============================================================
   SVG Wiring Editor — View Transform  (viewBox-based rendering)
   Zoom + pan use SVG viewBox for always-crisp vector rendering.
   Rotation uses _cameraRotGroup SVG transform (no CSS transforms)
   so getScreenCTM() stays correct at all zoom/pan/rotation values.
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Compute the base viewBox that fills the container ─────
    //    Called on init, on container resize, and after loading SVG.
    _computeBaseViewBox() {
        // [DEPRECATED] ViewBox is now pure absolute math derived entirely from zoom/pan.
    },

    // ── Setters ──────────────────────────────────────────────

    setZoom(zoom) {
        const z = Number(zoom);
        this.camera.setZoom(z);
        this.$zoomSlider.val(z);
        $('#zoomValue').text(z.toFixed(1));
        this.updateTransform();
    },

    setRotation(rotation) {
        let r = Number(rotation);
        this.camera.setRotation(r);
        this.currentRotation = this.camera.rotation; // keep alias in sync
        this.$rotationSlider.val(this.camera.rotation);
        $('#rotationValue').text(Math.round(this.camera.rotation));
        this.updateTransform();
    },

    setPitch(pitch) {
        // Pitch (skewX CSS) removed — breaks getScreenCTM(). Kept as no-op for compat.
    },

    setYRotation(yaw) {
        // Yaw (rotateY CSS) removed — breaks getScreenCTM(). Kept as no-op for compat.
    },

    // ── Transform Computation ────────────────────────────────
    //   Zoom + pan → SVG viewBox  (crisp vector rendering at every zoom)
    //   3D effects → CSS transform on #svgWrapper (only when active)

    updateTransform() {
        const svg = this.$svgDisplay[0];
        if (!svg) return;

        const container = this.$svgContainer[0];
        const cW = container.clientWidth || 1;
        const cH = container.clientHeight || 1;

        // ── viewBox: absolute zoom + pan (always crisp) ──────────────
        const vb = this.camera.toViewBox(cW, cH);
        svg.setAttribute('viewBox', vb.str);

        // ── Rotation → _cameraRotGroup SVG transform (world-space, no CSS) ──
        // Uses camera.rotation as the single source of truth so any module
        // querying camera state gets the full composite transform.
        const rotGroup = svg.querySelector('#_cameraRotGroup');
        if (rotGroup) {
            const wx = vb.x + vb.w / 2;   // world center of current view
            const wy = vb.y + vb.h / 2;
            const deg = this.camera.rotation;
            rotGroup.setAttribute('transform',
                deg !== 0 ? `rotate(${deg},${wx},${wy})` : '');
        }

        // ── Remove any CSS transform from #svgWrapper ─────────────
        // After this step, CSS transforms are gone; getScreenCTM() is authoritative.
        this.$svgWrapper.css({ transform: 'none', 'transform-style': 'flat' });

        // ── Trigger overlay re-render so handles move with the view ──
        this._scheduleOverlayRender?.();
        // Analysis label chips live in screen space, so they have to be
        // re-projected on every camera change rather than riding the SVG.
        this._schedulePositionLabels?.();
    },

    // ── rAF scheduler: batches pending transform state ────────
    _scheduleTransform(state) {
        Object.assign(this, state);
        if (this._transformRafHandle) return;
        this._transformRafHandle = requestAnimationFrame(() => {
            this._transformRafHandle = null;
            this.updateTransform();
        });
    },

    updateSliders() {
        this.$zoomSlider.val(this.camera.zoom);
        this.$rotationSlider.val(this.currentRotation);
        this.$pitchSlider.val(0); // legacy
        $('#zoomValue').text(this.camera.zoom.toFixed(1));
        $('#rotationValue').text(Math.round(this.currentRotation));
        $('#pitchValue').text(0);
    },

    // ── Animated Actions ─────────────────────────────────────

    animateZoom(targetZoom) {
        this._cameraTween.zoom = this.camera.zoom;
        gsap.to(this._cameraTween, {
            duration: 0.35,
            ease: 'power2.out',
            zoom: targetZoom,
            onUpdate: () => this.setZoom(this._cameraTween.zoom),
        });
    },

    zoomIn() { this.animateZoom(Math.min(100, this.camera.zoom * 1.5)); },
    zoomOut() { this.animateZoom(Math.max(0.1, this.camera.zoom / 1.5)); },

    fitToView() {
        const container = this.$svgContainer[0];
        if (!container) return;

        const cW = container.clientWidth;
        const cH = container.clientHeight;

        // Find the #_canvasBg to center on, or fallback to an arbitrary rect
        const bg = this.$svgDisplay[0].querySelector('#_canvasBg');
        let doc = { x: 0, y: 0, w: 1200, h: 800 };
        if (bg) {
            doc = {
                x: parseFloat(bg.getAttribute('x')) || 0,
                y: parseFloat(bg.getAttribute('y')) || 0,
                w: parseFloat(bg.getAttribute('width')) || 1200,
                h: parseFloat(bg.getAttribute('height')) || 800
            };
        } else if (this.originalViewBox) {
            const vb = this.originalViewBox.split(/[\s,]+/).map(Number);
            if (vb.length === 4 && vb.every(isFinite)) {
                doc = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
            }
        }

        const targetZoom = Math.min(cW / doc.w, cH / doc.h) * 0.92;
        const targetTx = (cW - doc.w * targetZoom) / 2 - (doc.x * targetZoom);
        const targetTy = (cH - doc.h * targetZoom) / 2 - (doc.y * targetZoom);

        this._cameraTween.zoom = this.camera.zoom;
        this._cameraTween.rot = this.currentRotation;
        this._cameraTween.tx = this.camera.tx;
        this._cameraTween.ty = this.camera.ty;

        gsap.to(this._cameraTween, {
            duration: 0.6,
            ease: 'power2.inOut',
            zoom: targetZoom,
            rot: 0,
            tx: targetTx,
            ty: targetTy,
            onUpdate: () => {
                this.camera.setPan(this._cameraTween.tx, this._cameraTween.ty);
                this.setZoom(this._cameraTween.zoom);
                this.setRotation(this._cameraTween.rot);
            },
            onComplete: () => {
                this.camera.setPan(targetTx, targetTy);
                this.updateTransform();
                this.updateSliders();
            },
        });
    },

    rotateView() {
        const target = (this.currentRotation + 90) % 360;
        this._cameraTween.rot = this.currentRotation;
        gsap.to(this._cameraTween, {
            duration: 0.6, ease: 'power2.inOut', rot: target,
            onUpdate: () => this.setRotation(this._cameraTween.rot),
        });
    },

    rotateViewLeft() {
        const target = (this.currentRotation - 90 + 360) % 360;
        this._cameraTween.rot = this.currentRotation;
        gsap.to(this._cameraTween, {
            duration: 0.6, ease: 'power2.inOut', rot: target,
            onUpdate: () => this.setRotation(this._cameraTween.rot),
        });
    },

    resetView() {
        this._cameraTween.zoom = this.camera.zoom;
        this._cameraTween.rot = this.currentRotation;
        this._cameraTween.tx = this.camera.tx;
        this._cameraTween.ty = this.camera.ty;

        gsap.to(this._cameraTween, {
            duration: 0.6, ease: 'power2.inOut',
            zoom: 1, rot: 0, tx: 0, ty: 0,
            onUpdate: () => {
                this.camera.setPan(this._cameraTween.tx, this._cameraTween.ty);
                this.setZoom(this._cameraTween.zoom);
                this.setRotation(this._cameraTween.rot);
            },
            onComplete: () => {
                this.camera.setPan(0, 0);
                this.updateTransform();
            },
        });
        this.clearAllHighlights?.();
        this.isWireTracing = false;
        $('#traceWireBtn').removeClass('active');
    },

    // ── Fly to an element ─────────────────────────────────────
    //
    //   A finding, a layer row or an artifact chip that selects something
    //   off-screen has told you a fact you cannot act on. Selecting should
    //   always end with the thing visible.
    //
    //   Reads the TIGHT bbox, so a path carrying a stray far-off vertex flies
    //   to the ink rather than to the middle of the gap between ink and orphan.
    flyToElement(el, opts) {
        const o = opts || {};
        if (!el || !el.isConnected) return;
        const svg = this.$svgDisplay?.[0];
        const container = this.$svgContainer?.[0];
        if (!svg || !container) return;

        const bb = this._tightBBox ? this._tightBBox(el) : (() => {
            try { return el.getBBox(); } catch (_) { return null; }
        })();
        if (!bb) return;

        // element-local → document-local (the space the camera works in)
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
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        [[bb.x, bb.y], [bb.x + bb.width, bb.y],
         [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]].forEach(([px, py]) => {
            const tp = new DOMPoint(px, py).matrixTransform(m);
            minX = Math.min(minX, tp.x); minY = Math.min(minY, tp.y);
            maxX = Math.max(maxX, tp.x); maxY = Math.max(maxY, tp.y);
        });
        if (!isFinite(minX)) return;

        const cW = container.clientWidth || 1;
        const cH = container.clientHeight || 1;
        const w = Math.max(maxX - minX, 1);
        const h = Math.max(maxY - minY, 1);

        // Zoom so the element fills a comfortable fraction of the viewport, but
        // never zoom PAST the current level for something already large: flying
        // to a big module should not shove you into its interior.
        const fit = Math.min(cW / w, cH / h) * (o.fill || 0.35);
        const targetZoom = Math.max(0.1, Math.min(o.maxZoom || 4, fit));

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const targetTx = cW / 2 - cx * targetZoom;
        const targetTy = cH / 2 - cy * targetZoom;

        if (typeof gsap === 'undefined') {
            this.camera.setPan(targetTx, targetTy);
            this.setZoom(targetZoom);
            this.updateTransform();
            return;
        }

        gsap.killTweensOf(this._cameraTween);
        this._cameraTween.zoom = this.camera.zoom;
        this._cameraTween.tx = this.camera.tx;
        this._cameraTween.ty = this.camera.ty;
        gsap.to(this._cameraTween, {
            duration: o.duration != null ? o.duration : 0.45,
            ease: 'power2.inOut',
            zoom: targetZoom, tx: targetTx, ty: targetTy,
            onUpdate: () => {
                this.camera.setPan(this._cameraTween.tx, this._cameraTween.ty);
                this.setZoom(this._cameraTween.zoom);
            },
            onComplete: () => {
                this.camera.setPan(targetTx, targetTy);
                this.updateTransform();
                this.updateSliders?.();
            },
        });
    },

    // Select an element AND make sure you can see it. The pairing every
    // list-row click wants.
    revealElement(el, opts) {
        if (!el?.isConnected) return;
        this.selectEl?.(el);
        this.flyToElement(el, opts);
        el.classList?.add('gx-label-flash');
        setTimeout(() => el.classList?.remove('gx-label-flash'), 700);
    },

    // ── Edit-mode check ─────────────────────────────────────
    //   Historically a selection locked the camera so drag/wheel/rotate acted on
    //   the selection instead of the canvas.  That was never needed: pan already
    //   requires Space or middle-mouse, and resize/rotate only start from a
    //   handle hit-test — so nothing about zoom/fit/rotate could ever be
    //   ambiguous.  All it did was make the view freeze whenever something was
    //   selected.  Kept as a permanent `false` because external callers
    //   (svgEditor's Hammer gestures) still probe it.

    _isViewportLocked() {
        return false;
    },

    // ── Mouse Drag ───────────────────────────────────────────

    // Panning has exactly two triggers, and neither is tool-specific plumbing:
    //   • the hand tool (which Space temporarily activates — see svgEditor's
    //     keydown handler, the single owner of that swap)
    //   • middle mouse, anywhere, in any tool
    // There used to be a third path: a special "select + space + background"
    // branch that re-derived what the hand tool already does, complete with its
    // own hand-maintained list of which element ids count as background. Space
    // now simply IS the hand tool, so that branch is gone and there is one
    // definition of panning instead of two that could drift apart.
    startDrag(event) {
        if (this._textEditActive) return;       // text input open — lock camera
        const middleMouse = event.button === 1;
        if (this.activeTool !== 'hand' && !middleMouse) return;

        this.isDragging = true;
        this.dragStart = {
            x: event.clientX,
            y: event.clientY,
            tx: this.camera.tx,
            ty: this.camera.ty,
            rotation: this.currentRotation,
        };
        $('body').addClass('gx-dragging-pan');
    },

    drag(event) {
        if (!this.isDragging) return;

        const dX = event.clientX - this.dragStart.x;
        const dY = event.clientY - this.dragStart.y;

        if (event.shiftKey) {
            this._scheduleTransform({ currentRotation: (this.dragStart.rotation + dX * 0.4) % 360 });
            this.$rotationSlider?.val(this.currentRotation);
        } else {
            this.camera.setPan(this.dragStart.tx + dX, this.dragStart.ty + dY);
            this._scheduleTransform({});
        }
    },

    endDrag() {
        if (!this.isDragging) return;
        this.isDragging = false;
        $('body').removeClass('gx-dragging-pan');
        this.$svgContainer.css('cursor', this.activeTool === 'hand' ? 'grab' : '');
    },

    // ── Wheel Zoom at cursor position ────────────────────────

    handleWheel(event) {
        if (this._textEditActive) return;       // text input open — lock camera
        event.preventDefault();
        const e = event.originalEvent || event;
        const factor = e.deltaY > 0 ? 0.92 : 1.08;
        const newZoom = Math.max(0.1, Math.min(100, this.camera.zoom * factor));
        const ctnr = this.$svgContainer[0].getBoundingClientRect();

        // Zoom-at-cursor via CameraMatrix (keeps world point under cursor fixed)
        this.camera.zoomAt(newZoom, e.clientX - ctnr.left, e.clientY - ctnr.top);

        this._scheduleTransform({});
        this.$zoomSlider?.val(newZoom);
        $('#zoomValue').text(newZoom.toFixed(1));
    },

    handleOrientationChange() {
        setTimeout(() => {
            this.updateTransform();
            this.updateMiniMap?.();
        }, 100);
    },
});
