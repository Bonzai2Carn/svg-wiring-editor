/* ============================================================
   Schematics Editor — Snap Grid
   Configurable grid overlay + magnetic snap for all drawing tools
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Grid state ────────────────────────────────────────────
    initSnapGrid() {
        this._grid = {
            visible:    false,
            snapOn:     true,
            size:       20,
            majorEvery: 5,
            color:      'rgba(120,120,130,0.18)',   // neutral gray minor
            majorColor: 'rgba(100,100,110,0.38)',   // neutral gray major
        };
        this._snapGuides = { h: null, v: null };
        this._renderGridPattern();
        this._bindGridKeys();

        // Default draw style — neutral gray (blue reserved for selection)
        this._drawStyle = {
            stroke:      '#666666',
            strokeWidth: 2,
            fill:        'none',
        };
        // Keep the toolbar color input in sync
        $('#drawStyleStroke').val(this._drawStyle.stroke);
    },

    // ── SVG <defs> pattern ────────────────────────────────────
    _renderGridPattern() {
        const svg   = this.$svgDisplay[0];
        const NS    = this.SVG_NS;
        const g     = this._grid;

        // Remove existing grid layer
        svg.querySelector('#_gridLayer')?.remove();
        svg.querySelector('#_gridDefs')?.remove();

        const defs = document.createElementNS(NS, 'defs');
        defs.id = '_gridDefs';
        defs.dataset.seSystem = 'true';

        // Minor grid pattern
        const minor = document.createElementNS(NS, 'pattern');
        minor.id = '_gridMinor';
        minor.setAttribute('width',  String(g.size));
        minor.setAttribute('height', String(g.size));
        minor.setAttribute('patternUnits', 'userSpaceOnUse');
        minor.setAttribute('data-locked', 'true');

        const minorPath = document.createElementNS(NS, 'path');
        minorPath.setAttribute('d', `M ${g.size} 0 L 0 0 0 ${g.size}`);
        minorPath.setAttribute('fill', 'none');
        minorPath.setAttribute('stroke', g.color);
        minorPath.setAttribute('stroke-width', '0.5');
        minor.appendChild(minorPath);
        defs.appendChild(minor);

        // Major grid pattern
        const majorSize = g.size * g.majorEvery;
        const major = document.createElementNS(NS, 'pattern');
        major.id = '_gridMajor';
        major.setAttribute('width',  String(majorSize));
        major.setAttribute('height', String(majorSize));
        major.setAttribute('patternUnits', 'userSpaceOnUse');
        major.setAttribute('data-locked', 'true');

        const majorBg = document.createElementNS(NS, 'rect');
        majorBg.setAttribute('width',  String(majorSize));
        majorBg.setAttribute('height', String(majorSize));
        majorBg.setAttribute('fill', 'url(#_gridMinor)');
        major.appendChild(majorBg);

        const majorPath = document.createElementNS(NS, 'path');
        majorPath.setAttribute('d', `M ${majorSize} 0 L 0 0 0 ${majorSize}`);
        majorPath.setAttribute('fill', 'none');
        majorPath.setAttribute('stroke', g.majorColor);
        majorPath.setAttribute('stroke-width', '1');
        major.appendChild(majorPath);
        defs.appendChild(major);

        svg.insertBefore(defs, svg.firstChild);

        // Grid layer rect — sized generously so it covers the full
        // panning range (viewBox changes dynamically with zoom/pan)
        const layer = document.createElementNS(NS, 'rect');
        layer.id    = '_gridLayer';
        layer.dataset.seSystem = 'true';
        layer.setAttribute('x',      '-50000');
        layer.setAttribute('y',      '-50000');
        layer.setAttribute('width',  '100000');
        layer.setAttribute('height', '100000');
        layer.setAttribute('fill',   'url(#_gridMajor)');
        layer.setAttribute('pointer-events', 'none');
        layer.setAttribute('data-locked', 'true');
        layer.style.display = this._grid.visible ? '' : 'none';

        // Insert _gridLayer as first child of _cameraRotGroup so it:
        //   (a) rotates with the camera, and
        //   (b) is always behind user content inside the group.
        // Falls back to SVG root position [1] if the group doesn't exist yet.
        const rotGrp = svg.querySelector('#_cameraRotGroup');
        if (rotGrp) {
            rotGrp.insertBefore(layer, rotGrp.firstChild);
        } else {
            svg.insertBefore(layer, svg.children[1] || null);
        }
    },

    // Move _gridLayer to sit after _canvasBg (if present) so it's visible on the white page.
    // Called after _mountParsedSvg finishes importing content into _cameraRotGroup.
    _repositionGridLayer() {
        const rotGrp = this.$svgDisplay[0].querySelector('#_cameraRotGroup');
        if (!rotGrp) return;
        const gridLayer = rotGrp.querySelector('#_gridLayer');
        const canvasBg  = rotGrp.querySelector('#_canvasBg');
        if (gridLayer && canvasBg && canvasBg.nextSibling !== gridLayer) {
            rotGrp.insertBefore(gridLayer, canvasBg.nextSibling);
        }
    },

    toggleGrid() {
        this._grid.visible = !this._grid.visible;
        const layer = this.$svgDisplay[0].querySelector('#_gridLayer');
        if (layer) layer.style.display = this._grid.visible ? '' : 'none';
        this.showToast(this._grid.visible ? 'Grid ON' : 'Grid OFF', 'success');
        $('#gridToggleBtn').toggleClass('active', this._grid.visible);
    },

    toggleSnap() {
        this._grid.snapOn = !this._grid.snapOn;
        this.showToast(this._grid.snapOn ? 'Snap ON' : 'Snap OFF', 'success');
        $('#snapToggleBtn').toggleClass('active', this._grid.snapOn);
    },

    setGridSize(size) {
        this._grid.size = parseInt(size, 10) || 20;
        this._renderGridPattern();
    },

    // ── Snap a {x,y} point to the nearest grid intersection ──
    snapPoint(x, y) {
        if (!this._grid.snapOn) return { x, y };
        const s = this._grid.size;
        return {
            x: Math.round(x / s) * s,
            y: Math.round(y / s) * s,
        };
    },

    // ── Smart snap (axis-independent, 6 targets) ─────────────
    // Used by drawing tools (wire, line, shapes).
    // Snaps x and y independently to nearby element edges/centers.
    smartSnap(x, y, excludeIds = []) {
        if (!this._grid.snapOn) return { x, y };
        const gridPt = this.snapPoint(x, y);
        const THRESH = Math.min(8 / (this.zoom || 1), 24);   // clamp: don't balloon at low zoom

        // Targets: domain symbols, tagged wires, AND user-drawn shapes (el_ ids) —
        // ink strokes excluded (freehand is never a snap reference)
        const elementsInfo = Array.from(this._contentRoot?.querySelectorAll?.(
                '.domain-symbol, path[data-geo-class="wire"], [id^="el_"]'
            ) ?? []).filter(el =>
                !el.id?.startsWith('_') &&
                el.getAttribute('data-ink') !== 'true' &&
                !el.classList.contains('snap-guide') &&
                !el.classList.contains('draw-preview') &&
                !excludeIds.includes(el.id)
            ).map(el => { 
                try { return this._getVisualBBoxWorld(el); } 
                catch(_) { return null; } 
            }).filter(Boolean);

        let snapX = gridPt.x, snapY = gridPt.y;
        let distX = Math.abs(x - gridPt.x), distY = Math.abs(y - gridPt.y);

        elementsInfo.forEach(bb => {
            if (!bb || (!bb.width && !bb.height)) return;
            // X: left edge, center, right edge, plus pins
            const targetXs = [bb.x, bb.x + bb.width * 0.5, bb.x + bb.width];
            if (bb.pins) bb.pins.forEach(p => targetXs.push(p.x));
            
            targetXs.forEach(cx => {
                const d = Math.abs(x - cx);
                if (d < THRESH && d < distX) { distX = d; snapX = cx; }
            });

            // Y: top edge, center, bottom edge, plus pins
            const targetYs = [bb.y, bb.y + bb.height * 0.5, bb.y + bb.height];
            if (bb.pins) bb.pins.forEach(p => targetYs.push(p.y));

            targetYs.forEach(cy => {
                const d = Math.abs(y - cy);
                if (d < THRESH && d < distY) { distY = d; snapY = cy; }
            });
        });

        return { x: snapX, y: snapY };
    },

    // ── Alignment snap for element drag (Figma-style) ────────
    // Projects origBBoxes (world-space, captured at drag start) by delta,
    // then finds the smallest per-axis adjustment that aligns a selection
    // edge to a reference element edge. Returns {delta, guides} or null.
    _computeAlignSnap(origBBoxes, delta, excludeIds = []) {
        if (!this._grid.snapOn || !origBBoxes?.length) return null;
        const THRESH = Math.min(8 / (this.zoom || 1), 24);   // clamp: don't balloon at low zoom

        // Compute union bbox of all selection elements projected to current delta
        let uL = Infinity, uT = Infinity, uR = -Infinity, uB = -Infinity;
        origBBoxes.forEach(bb => {
            if (!bb) return;
            uL = Math.min(uL, bb.x + delta.x);
            uT = Math.min(uT, bb.y + delta.y);
            uR = Math.max(uR, bb.x + bb.width  + delta.x);
            uB = Math.max(uB, bb.y + bb.height + delta.y);
        });
        if (!isFinite(uL)) return null;
        const uW = uR - uL, uH = uB - uT;

        const selEdgesX = [uL, uL + uW * 0.5, uR];
        const selEdgesY = [uT, uT + uH * 0.5, uB];
        
        // Inject selection pins into targets
        origBBoxes.forEach(bb => {
            if (bb.pins) {
                bb.pins.forEach(p => {
                    selEdgesX.push(p.x + delta.x);
                    selEdgesY.push(p.y + delta.y);
                });
            }
        });

        const refs = this._getOtherElementBBoxes(excludeIds);
        if (!refs.length) return null;

        // Precompute uniform gaps between refs for distribution snapping
        const refGapsX = [];
        const refGapsY = [];
        for (let i = 0; i < refs.length; i++) {
            for (let j = i + 1; j < refs.length; j++) {
                const cx1 = refs[i].x + refs[i].width/2;
                const cy1 = refs[i].y + refs[i].height/2;
                const cx2 = refs[j].x + refs[j].width/2;
                const cy2 = refs[j].y + refs[j].height/2;
                
                if (Math.abs(cy1 - cy2) < 50) {
                    refGapsX.push({ dist: Math.abs(cx1 - cx2), r1: refs[i], r2: refs[j], cy: (cy1+cy2)/2 });
                }
                if (Math.abs(cx1 - cx2) < 50) {
                    refGapsY.push({ dist: Math.abs(cy1 - cy2), r1: refs[i], r2: refs[j], cx: (cx1+cx2)/2 });
                }
            }
        }

        let bestDx = 0, bestDxDist = THRESH + 1, xGuide = null;
        let bestDy = 0, bestDyDist = THRESH + 1, yGuide = null;

        const selCx = uL + uW * 0.5;
        const selCy = uT + uH * 0.5;

        refs.forEach(ref => {
            if (!ref || (!ref.width && !ref.height)) return;
            
            // 1. Edge and Pin Snapping
            const refEdgesX = [ref.x, ref.x + ref.width * 0.5, ref.x + ref.width];
            if (ref.pins) ref.pins.forEach(p => refEdgesX.push(p.x));
            
            const refEdgesY = [ref.y, ref.y + ref.height * 0.5, ref.y + ref.height];
            if (ref.pins) ref.pins.forEach(p => refEdgesY.push(p.y));

            selEdgesX.forEach(se => refEdgesX.forEach(re => {
                const d = Math.abs(se - re);
                if (d < THRESH && d < bestDxDist) {
                    bestDxDist = d;
                    bestDx = delta.x + (re - se);
                    xGuide = { axis: 'v', at: re, ref };
                }
            }));

            selEdgesY.forEach(se => refEdgesY.forEach(re => {
                const d = Math.abs(se - re);
                if (d < THRESH && d < bestDyDist) {
                    bestDyDist = d;
                    bestDy = delta.y + (re - se);
                    yGuide = { axis: 'h', at: re, ref };
                }
            }));

            // 2. Distribution Snapping
            const refCx = ref.x + ref.width * 0.5;
            const refCy = ref.y + ref.height * 0.5;

            refGapsX.forEach(gap => {
                if ((gap.r1 === ref || gap.r2 === ref) && Math.abs((selCy + delta.y) - gap.cy) < 50) {
                    [refCx - gap.dist, refCx + gap.dist].forEach(targetCx => {
                        const d = Math.abs((selCx + delta.x) - targetCx);
                        if (d < THRESH && d < bestDxDist) {
                            bestDxDist = d;
                            bestDx = delta.x + (targetCx - (selCx + delta.x));
                            xGuide = { axis: 'h-dist', gap: gap.dist, ref1: gap.r1, ref2: gap.r2, ref3: ref, targetCx };
                        }
                    });
                }
            });

            refGapsY.forEach(gap => {
                if ((gap.r1 === ref || gap.r2 === ref) && Math.abs((selCx + delta.x) - gap.cx) < 50) {
                    [refCy - gap.dist, refCy + gap.dist].forEach(targetCy => {
                        const d = Math.abs((selCy + delta.y) - targetCy);
                        if (d < THRESH && d < bestDyDist) {
                            bestDyDist = d;
                            bestDy = delta.y + (targetCy - (selCy + delta.y));
                            yGuide = { axis: 'v-dist', gap: gap.dist, ref1: gap.r1, ref2: gap.r2, ref3: ref, targetCy };
                        }
                    });
                }
            });
        });

        const xSnapped = bestDxDist <= THRESH;
        const ySnapped = bestDyDist <= THRESH;
        if (!xSnapped && !ySnapped) return null;

        const finalDx = xSnapped ? bestDx : delta.x;
        const finalDy = ySnapped ? bestDy : delta.y;

        // Re-project union with final delta so guide span is drawn at the actual final position
        const finalUL = uL + (finalDx - delta.x);
        const finalUT = uT + (finalDy - delta.y);
        const sel = { x: finalUL, y: finalUT, w: uW, h: uH };
        if (xGuide) xGuide.sel = sel;
        if (yGuide) yGuide.sel = sel;

        return {
            delta: { x: finalDx, y: finalDy },
            guides: [xGuide, yGuide].filter(Boolean),
        };
    },

    // Returns world-space bboxes for all non-selected elements.
    _getOtherElementBBoxes(excludeIds = []) {
        const root = this._contentRoot || this.$svgDisplay?.[0];
        if (!root) return [];
        const out = [];
        root.querySelectorAll('.domain-symbol, [id^="el_"]').forEach(el => {
            if (el.id?.startsWith('_') || excludeIds.includes(el.id)) return;
            if (el.dataset?.seSystem === 'true') return;
            if (el.getAttribute('data-ink') === 'true') return;
            try {
                const bb = this._getVisualBBoxWorld(el);
                if (bb && (bb.width > 0 || bb.height > 0)) {
                    out.push({ ...bb, refEl: el });
                }
            } catch(_) {}
        });
        return out;
    },

    // ── Bounded alignment guides (Figma-style) ───────────────
    // Draws a line from the selection edge to the reference element edge,
    // spanning only the y-range (for vertical guides) or x-range (for
    // horizontal guides) of the two aligned elements — not full canvas.
    showAlignmentGuides(guides) {
        this.$svgDisplay[0].querySelectorAll('.snap-align').forEach(el => el.remove());
        if (!guides?.length) return;

        const NS  = this.SVG_NS;
        const root = this._contentRoot || this.$svgDisplay[0];
        const PAD = 20;

        guides.forEach(g => {
            if (g.axis === 'h-dist' || g.axis === 'v-dist') {
                // Draw distribution dimension markers (Figma-style)
                const isH = g.axis === 'h-dist';
                const c1 = g.ref1[isH ? 'x' : 'y'] + g.ref1[isH ? 'width' : 'height']/2;
                const c2 = g.ref2[isH ? 'x' : 'y'] + g.ref2[isH ? 'width' : 'height']/2;
                const c3 = g.targetCx || g.targetCy; // selection center
                
                const pts = [c1, c2, c3].sort((a,b)=>a-b);
                const crossCoord = isH ? g.ref1.y + g.ref1.height + 15 : g.ref1.x + g.ref1.width + 15;
                
                // Draw dimension lines
                for (let i = 0; i < 2; i++) {
                    const line = document.createElementNS(NS, 'line');
                    line.classList.add('snap-guide', 'snap-align');
                    line.setAttribute('stroke-dasharray', '4,4');
                    line.setAttribute('pointer-events', 'none');
                    if (isH) {
                        line.setAttribute('x1', pts[i]); line.setAttribute('y1', crossCoord);
                        line.setAttribute('x2', pts[i+1]); line.setAttribute('y2', crossCoord);
                    } else {
                        line.setAttribute('x1', crossCoord); line.setAttribute('y1', pts[i]);
                        line.setAttribute('x2', crossCoord); line.setAttribute('y2', pts[i+1]);
                    }
                    root.appendChild(line);

                    // Dimension text
                    const text = document.createElementNS(NS, 'text');
                    text.classList.add('snap-align');
                    text.textContent = Math.round(g.gap);
                    text.setAttribute('font-size', '10');
                    text.setAttribute('fill', '#4facfe');
                    text.setAttribute('text-anchor', 'middle');
                    text.setAttribute('pointer-events', 'none');
                    if (isH) {
                        text.setAttribute('x', (pts[i] + pts[i+1])/2);
                        text.setAttribute('y', crossCoord - 4);
                    } else {
                        text.setAttribute('x', crossCoord + 4);
                        text.setAttribute('y', (pts[i] + pts[i+1])/2 + 4);
                    }
                    root.appendChild(text);
                }
                return;
            }

            if (!g?.sel || !g?.ref) return;
            const line = document.createElementNS(NS, 'line');
            line.classList.add('snap-guide', 'snap-align');
            line.setAttribute('pointer-events', 'none');

            if (g.axis === 'v') {
                // Vertical line at g.at — spans both elements' Y ranges
                const minY = Math.min(g.sel.y, g.ref.y) - PAD;
                const maxY = Math.max(g.sel.y + g.sel.h, g.ref.y + g.ref.height) + PAD;
                line.setAttribute('x1', g.at); line.setAttribute('y1', minY);
                line.setAttribute('x2', g.at); line.setAttribute('y2', maxY);
            } else {
                // Horizontal line at g.at — spans both elements' X ranges
                const minX = Math.min(g.sel.x, g.ref.x) - PAD;
                const maxX = Math.max(g.sel.x + g.sel.w, g.ref.x + g.ref.width) + PAD;
                line.setAttribute('x1', minX); line.setAttribute('y1', g.at);
                line.setAttribute('x2', maxX); line.setAttribute('y2', g.at);
            }
            root.appendChild(line);
        });
    },

    // ── Grid/snap crosshair for drawing tools ─────────────────
    showSnapGuides(x, y) {
        this._removeSnapGuides();
        const NS  = this.SVG_NS;
        const svg = this.$svgDisplay[0];
        const vb  = (svg.getAttribute('viewBox') || '0 0 2000 2000').trim().split(/[\s,]+/).map(Number);
        if (isNaN(vb[0])) return;

        const makeGuide = (orientation) => {
            const line = document.createElementNS(NS, 'line');
            line.classList.add('snap-guide');
            if (orientation === 'h') {
                line.setAttribute('x1', String(vb[0]));       line.setAttribute('y1', String(y));
                line.setAttribute('x2', String(vb[0] + vb[2])); line.setAttribute('y2', String(y));
            } else {
                line.setAttribute('x1', String(x));           line.setAttribute('y1', String(vb[1]));
                line.setAttribute('x2', String(x));           line.setAttribute('y2', String(vb[1] + vb[3]));
            }
            line.setAttribute('pointer-events', 'none');
            svg.appendChild(line);
            return line;
        };

        this._snapGuides.h = makeGuide('h');
        this._snapGuides.v = makeGuide('v');
    },

    _removeSnapGuides() {
        this._snapGuides.h?.remove();
        this._snapGuides.v?.remove();
        this._snapGuides = { h: null, v: null };
        this.$svgDisplay[0].querySelectorAll('.snap-guide').forEach(el => el.remove());
    },

    // ── Keyboard bindings for grid ────────────────────────────
    _bindGridKeys() {
        $(document).on('keydown.grid', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === 'g' || e.key === 'G') { e.preventDefault(); this.toggleGrid(); }
        });
    },

    // ── Convert screen coords to SVG world coords ─────────────
    //   Absorbs container offset here so NO call site needs to change.
    //   Works correctly at any zoom/pan/rotation because CameraMatrix
    //   (zoom+pan inverse) is applied to container-relative coords and
    //   rotation is already baked into the SVG via _cameraRotGroup /
    //   getScreenCTM() — which is the authoritative mapping.
    screenToSVG(clientX, clientY) {
        const svg    = this.$svgDisplay[0];
        const ctnr   = this.$svgContainer[0].getBoundingClientRect();
        const rotGrp = svg.querySelector('#_cameraRotGroup');
        const pt     = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        // Use _cameraRotGroup.getScreenCTM() so the inverse maps screen →
        // document-local space (inside the rotation group). This keeps screenToSVG
        // consistent with _worldToOverlayScreen and _getSelectionBBoxWorld.
        const m = rotGrp ? rotGrp.getScreenCTM() : svg.getScreenCTM();
        if (!m) {
            // Fallback: use CameraMatrix (no rotation, but better than raw coords)
            return this.camera.screenToWorld(clientX - ctnr.left, clientY - ctnr.top);
        }
        const svgPt = pt.matrixTransform(m.inverse());
        return { x: svgPt.x, y: svgPt.y };
    },
});
