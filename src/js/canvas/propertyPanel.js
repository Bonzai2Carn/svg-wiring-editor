/* ============================================================
   Schematics Editor — Property Panel
   Inspect and live-edit style/position/size/text of selected SVG elements.
   Rendered inside the existing side panel as a second tab.
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    initPropertyPanel() {
        this._propPanelTarget = null;
        this._activeSidePanelTab = 'layers';  // Layers is default; persists across selections
        this._buildPropertyPanelHTML();
        this._bindPropertyPanelEvents();
        // Apply initial tab state so viewControlsGroup is hidden on the Layers tab
        this._switchSidePanelTab('layers');
    },

    // ── Helper to find the visual shape inside a component group ──
    _getVisualTarget(el) {
        const $el = $(el);
        if ($el.hasClass('component-group') || $el.hasClass('wire-group')) {
            const visual = $el.children().not('.component-hitbox, .wire-hitbox, [data-locked="true"]').first()[0];
            return visual || el;
        }
        return el;
    },

    // ── Helper to deep-apply visual styles to all nested shapes ──
    _applyStyle(el, attr, val) {
        const target = this._getVisualTarget(el);
        // Apply to the top-level visual target
        if (val === null) target.removeAttribute(attr);
        else target.setAttribute(attr, val);

        // For complex groups (like domain-symbols), force the style on all inner primitive shapes
        // so that explicit attributes on children don't block the group inheritance.
        if (target.tagName.toLowerCase() === 'g') {
            const shapes = target.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon, text');
            shapes.forEach(shape => {
                if (shape.classList.contains('component-hitbox') || shape.classList.contains('wire-hitbox')) return;
                if (shape.getAttribute('data-locked') === 'true') return;
                
                if (val === null) shape.removeAttribute(attr);
                else shape.setAttribute(attr, val);
            });
        }
    },

    // ── Build panel HTML ──────────────────────────────────────
    _buildPropertyPanelHTML() {
        const html = `
        <div id="propertyPanel" class="prop-panel" style="display:none;">
            <h3 class="prop-section-title">
                <iconify-icon icon="material-symbols:tune"></iconify-icon>
                Properties
            </h3>

            <!-- Element info -->
            <div class="prop-row prop-info-row">
                <span class="prop-label">Element</span>
                <span id="prop-el-tag" class="prop-value-tag">—</span>
            </div>

            <!-- Position -->
            <div class="prop-section-label">Position &amp; Size</div>
            <div class="prop-grid-2">
                <label class="prop-label">X
                    <input type="number" id="prop-x" class="prop-input" step="1">
                </label>
                <label class="prop-label">Y
                    <input type="number" id="prop-y" class="prop-input" step="1">
                </label>
                <label class="prop-label">W
                    <input type="number" id="prop-w" class="prop-input" step="1" min="0">
                </label>
                <label class="prop-label">H
                    <input type="number" id="prop-h" class="prop-input" step="1" min="0">
                </label>
            </div>

            <!-- Rotation -->
            <div class="prop-row">
                <label class="prop-label">Rotation
                    <input type="range" id="prop-rotation" class="prop-slider" min="-180" max="180" step="1" value="0">
                </label>
                <span id="prop-rotation-val" class="prop-pill">0°</span>
            </div>

            <!-- Stroke -->
            <div class="prop-section-label">Stroke</div>
            <div class="prop-grid-2">
                <label class="prop-label">Color
                    <div class="prop-color-wrap">
                        <input type="color" id="prop-stroke-color" class="prop-color" value="#4facfe">
                        <span id="prop-stroke-hex" class="prop-color-hex">#4facfe</span>
                    </div>
                </label>
                <label class="prop-label">Width
                    <input type="number" id="prop-stroke-width" class="prop-input" min="0" step="0.5" value="2">
                </label>
            </div>
            <div class="prop-row">
                <label class="prop-label">Dash
                    <select id="prop-stroke-dash" class="prop-select">
                        <option value="none">Solid</option>
                        <option value="4,4">Dashed</option>
                        <option value="2,4">Dotted</option>
                        <option value="8,4,2,4">Dash-dot</option>
                    </select>
                </label>
            </div>

            <!-- Fill -->
            <div class="prop-section-label">Fill</div>
            <div class="prop-grid-2">
                <label class="prop-label">Color
                    <div class="prop-color-wrap">
                        <input type="color" id="prop-fill-color" class="prop-color" value="#4facfe">
                        <span id="prop-fill-hex" class="prop-color-hex">#4facfe</span>
                    </div>
                </label>
                <label class="prop-label">Opacity
                    <input type="range" id="prop-fill-opacity" class="prop-slider" min="0" max="1" step="0.05" value="0">
                </label>
            </div>
            <div class="prop-row">
                <button class="btn prop-no-fill-btn" id="prop-no-fill">No Fill</button>
            </div>

            <!-- Text (shown only for <text> elements) -->
            <div id="prop-text-group" class="prop-section" style="display:none;">
                <div class="prop-section-label">Text</div>
                <textarea id="prop-text-content" class="prop-textarea" rows="2" placeholder="Text content…"></textarea>
                <div class="prop-grid-2">
                    <label class="prop-label">Size
                        <input type="number" id="prop-font-size" class="prop-input" min="6" step="1" value="14">
                    </label>
                    <label class="prop-label">Family
                        <select id="prop-font-family" class="prop-select">
                            <option value="Inter, sans-serif">Inter</option>
                            <option value="monospace">Mono</option>
                            <option value="Georgia, serif">Serif</option>
                        </select>
                    </label>
                </div>
            </div>

            <!-- Border radius (shown for <rect>) -->
            <div id="prop-radius-group" class="prop-section" style="display:none;">
                <div class="prop-section-label">Corner Radius</div>
                <input type="range" id="prop-border-radius" class="prop-slider" min="0" max="50" step="1" value="0">
                <span id="prop-radius-val" class="prop-pill">0px</span>
            </div>

            <!-- Component Info (shown for placed domain symbols with known spec) -->
            <div id="prop-spec-group" class="prop-section" style="display:none;">
                <div class="prop-section-label" style="margin-top:8px;">Component Info</div>
                <div id="prop-spec-desc" class="prop-spec-desc"></div>
                <div class="prop-spec-row">
                    <span class="prop-label">Pins</span>
                    <span id="prop-spec-pins" class="prop-value">—</span>
                </div>
                <div class="prop-spec-row">
                    <span class="prop-label">Parameters</span>
                    <span id="prop-spec-params" class="prop-value">—</span>
                </div>
                <div class="prop-spec-row">
                    <span class="prop-label">Typical</span>
                    <span id="prop-spec-typical" class="prop-value">—</span>
                </div>
            </div>

            <!-- Align & Distribute (shown when 2+ selected) -->
            <div id="prop-align-group" class="prop-section" style="display:none;">
                <div class="prop-section-label">Align</div>
                <div class="prop-align-row">
                    <button class="btn prop-align-btn" title="Align Left"       data-align="left">
                        <iconify-icon icon="material-symbols:align-horizontal-left"></iconify-icon>
                    </button>
                    <button class="btn prop-align-btn" title="Align Center H"   data-align="centerH">
                        <iconify-icon icon="material-symbols:align-horizontal-center"></iconify-icon>
                    </button>
                    <button class="btn prop-align-btn" title="Align Right"      data-align="right">
                        <iconify-icon icon="material-symbols:align-horizontal-right"></iconify-icon>
                    </button>
                    <button class="btn prop-align-btn" title="Align Top"        data-align="top">
                        <iconify-icon icon="material-symbols:align-vertical-top"></iconify-icon>
                    </button>
                    <button class="btn prop-align-btn" title="Align Center V"   data-align="centerV">
                        <iconify-icon icon="material-symbols:align-vertical-center"></iconify-icon>
                    </button>
                    <button class="btn prop-align-btn" title="Align Bottom"     data-align="bottom">
                        <iconify-icon icon="material-symbols:align-vertical-bottom"></iconify-icon>
                    </button>
                </div>
                <div class="prop-section-label" style="margin-top:8px;">Distribute</div>
                <div class="prop-align-row">
                    <button class="btn prop-align-btn" title="Distribute H" data-align="distH">
                        <iconify-icon icon="material-symbols:horizontal-distribute"></iconify-icon>
                    </button>
                    <button class="btn prop-align-btn" title="Distribute V" data-align="distV">
                        <iconify-icon icon="material-symbols:vertical-distribute"></iconify-icon>
                    </button>
                </div>
            </div>
        </div>`;

        // Append to side panel after layers panel
        const $sidePanel = $('#sidePanel');
        if ($sidePanel.find('#propertyPanel').length === 0) {
            $sidePanel.append(html);
        }
    },

    // ── Refresh from current selection ───────────────────────
    _refreshPropertyPanel() {
        const sel = this._selection;
        const el  = sel[0] || null;

        if (!el) { this._clearPropertyPanel(); return; }
        this._refreshContextualToolbar?.();

        this._propPanelTarget = el;

        // Auto-switch to Properties tab so the panel is actually visible.
        // Without this, the Properties panel is rendered below the Layers panel
        // and the user never sees it change.
        if (this.$sidePanel?.hasClass('open') && this._activeSidePanelTab !== 'properties') {
            this._switchSidePanelTab('properties');
        } else {
            $('#propertyPanel').show();
        }

        // Multi-select banner — visible when 2+ elements are selected
        const selCount = sel.length;
        const $banner = $('#prop-multi-banner');
        if (selCount >= 2) {
            const msg = `${selCount} elements — stroke & fill apply to all`;
            if ($banner.length) { $banner.text(msg); }
            else { $('<div id="prop-multi-banner" class="prop-multi-banner"></div>').text(msg).prependTo('#propertyPanel'); }
        } else {
            $banner.remove();
        }

        const tag = el.tagName.toLowerCase();
        $('#prop-el-tag').text(tag + (el.id ? `#${el.id.slice(0,12)}` : ''));

        // Target for visual properties
        const visualTarget = this._getVisualTarget(el);

        // Position / size via world bounding box projection
        try {
            const bb = el.getBBox();
            const rootCTM = this._contentRoot.getCTM();
            const elCTM = el.getCTM();
            let matrix = new DOMMatrix();
            if (rootCTM && elCTM) {
                matrix = rootCTM.inverse().multiply(elCTM);
            }
            
            const pt = this.$svgDisplay[0].createSVGPoint();
            pt.x = bb.x; pt.y = bb.y;
            const worldPt = pt.matrixTransform(matrix);
            
            const scaleX = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b) || 1;
            const scaleY = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d) || 1;

            $('#prop-x').val(Math.round(worldPt.x));
            $('#prop-y').val(Math.round(worldPt.y));
            $('#prop-w').val(Math.round(bb.width * scaleX));
            $('#prop-h').val(Math.round(bb.height * scaleY));

            // Store current world values on the DOM node for the change handlers to diff against
            $('#prop-x').data('world', worldPt.x);
            $('#prop-y').data('world', worldPt.y);
            $('#prop-w').data('world', bb.width * scaleX);
            $('#prop-h').data('world', bb.height * scaleY);
        } catch (_) {}

        // Rotation from transform
        const transform = el.getAttribute('transform') || '';
        const rotMatch  = transform.match(/rotate\(([-\d.]+)/);
        const rotVal    = rotMatch ? parseFloat(rotMatch[1]) : 0;
        $('#prop-rotation').val(rotVal);
        $('#prop-rotation-val').text(`${Math.round(rotVal)}°`);

        // Stroke (use visualTarget)
        const stroke = visualTarget.getAttribute('stroke') || this._drawStyle.stroke;
        const sw     = visualTarget.getAttribute('stroke-width') || this._drawStyle.strokeWidth;
        const dash   = visualTarget.getAttribute('stroke-dasharray') || 'none';
        if (this._isValidColor(stroke)) {
            $('#prop-stroke-color').val(this._toHex(stroke));
            $('#prop-stroke-hex').text(this._toHex(stroke));
        }
        $('#prop-stroke-width').val(parseFloat(sw) || 2);
        $('#prop-stroke-dash').val(dash);

        // Fill (use visualTarget)
        const fill       = visualTarget.getAttribute('fill') || 'none';
        const fillOp     = parseFloat(visualTarget.getAttribute('fill-opacity') || '1');
        if (fill !== 'none' && this._isValidColor(fill)) {
            $('#prop-fill-color').val(this._toHex(fill));
            $('#prop-fill-hex').text(this._toHex(fill));
        }
        $('#prop-fill-opacity').val(fill === 'none' ? 0 : fillOp);

        // Text-specific
        const isText = tag === 'text' || tag === 'tspan';
        $('#prop-text-group').toggle(isText);
        if (isText) {
            $('#prop-text-content').val(el.textContent);
            $('#prop-font-size').val(parseFloat(el.getAttribute('font-size') || '14'));
            $('#prop-font-family').val(el.getAttribute('font-family') || 'Inter, sans-serif');
        }

        // Rect-specific
        const isRect = tag === 'rect';
        $('#prop-radius-group').toggle(isRect);
        if (isRect) {
            const rx = parseFloat(el.getAttribute('rx') || '0');
            $('#prop-border-radius').val(rx);
            $('#prop-radius-val').text(`${rx}px`);
        }

        // Align/distribute (multi-select)
        $('#prop-align-group').toggle(sel.length >= 2);

        // Component spec card (electrical domain symbols only)
        const symId = el?.getAttribute?.('data-symbol');
        const spec = window.COMPONENT_SPECS?.[symId];
        $('#prop-spec-group').toggle(!!spec);
        if (spec) {
            $('#prop-spec-desc').text(spec.description || '');
            $('#prop-spec-pins').text(
                spec.pinCount != null
                    ? `${spec.pinCount} — ${spec.pinNames?.join(', ') || ''}`
                    : '—'
            );
            $('#prop-spec-params').text(spec.keyParams?.join(' · ') || '—');
            $('#prop-spec-typical').text(spec.typical?.join(', ') || '—');
        }
    },

    _clearPropertyPanel() {
        $('#propertyPanel').hide();
        this._propPanelTarget = null;
        this._refreshContextualToolbar?.();
    },

    // ── Side panel tab switching ──────────────────────────────
    _switchSidePanelTab(tab) {
        this._activeSidePanelTab = tab;
        // Tab button active states
        $('#sidePanelTabLayers').toggleClass('active', tab === 'layers');
        $('#sidePanelTabProperties').toggleClass('active', tab === 'properties');
        if (tab === 'properties') {
            $('#propertyPanel').show();
            $('#layersPanelWrap').hide();
            $('#viewControlsGroup').show();
        } else {
            $('#propertyPanel').hide();
            $('#layersPanelWrap').show();
            $('#viewControlsGroup').hide();
        }
    },

    // ── Event binding ─────────────────────────────────────────
    _bindPropertyPanelEvents() {
        const self = this;

        // Live update helper — broadcasts to all selected elements when 2+ are selected.
        // Position/size handlers use per-element delta logic that works correctly with
        // multi-target iteration (each element translates/scales by the same delta).
        const live = (selector, handler) => {
            $(document).on('input.prop change.prop', selector, function () {
                if (!self._propPanelTarget) return;
                const targets = (self._selection?.length >= 2) ? self._selection : [self._propPanelTarget];
                targets.forEach(el => handler.call(this, el));
                self._renderHandles();
            });
        };

        // Position inputs (use absolute world delta)
        live('#prop-x, #prop-y', function (el) {
            const newX = parseFloat($('#prop-x').val()) || 0;
            const newY = parseFloat($('#prop-y').val()) || 0;
            const oldX = parseFloat($('#prop-x').data('world')) || 0;
            const oldY = parseFloat($('#prop-y').data('world')) || 0;
            
            const dx = newX - oldX;
            const dy = newY - oldY;
            if (dx === 0 && dy === 0) return;

            const t = el.getAttribute('transform') || '';
            el.setAttribute('transform', `translate(${dx},${dy}) ${t}`);
            
            $('#prop-x').data('world', newX);
            $('#prop-y').data('world', newY);
        });

        // Size inputs (scale delta)
        live('#prop-w, #prop-h', function (el) {
            const newW = parseFloat($('#prop-w').val()) || 1;
            const newH = parseFloat($('#prop-h').val()) || 1;
            const oldW = parseFloat($('#prop-w').data('world')) || 1;
            const oldH = parseFloat($('#prop-h').data('world')) || 1;
            
            const sx = newW / oldW;
            const sy = newH / oldH;
            if (sx === 1 && sy === 1) return;

            try {
                const bb = el.getBBox();
                const t = el.getAttribute('transform') || '';
                el.setAttribute('transform',
                    `translate(${bb.x},${bb.y}) scale(${sx},${sy}) translate(${-bb.x},${-bb.y}) ${t}`
                );
                $('#prop-w').data('world', newW);
                $('#prop-h').data('world', newH);
            } catch (_) {}
        });

        // Rotation
        live('#prop-rotation', function (el) {
            const angle = parseFloat($(this).val()) || 0;
            $('#prop-rotation-val').text(`${Math.round(angle)}°`);
            try {
                const bb = el.getBBox();
                const cx = bb.x + bb.width  / 2;
                const cy = bb.y + bb.height / 2;
                const t  = (el.getAttribute('transform') || '').replace(/rotate\([^)]*\)/g, '').trim();
                el.setAttribute('transform', `${t} rotate(${angle},${cx},${cy})`);
            } catch (_) {}
        });

        // Stroke color
        live('#prop-stroke-color', function (el) {
            const val = $(this).val();
            self._applyStyle(el, 'stroke', val);
            self._drawStyle.stroke = val;
            $('#prop-stroke-hex').text(val);
        });

        // Stroke width
        live('#prop-stroke-width', function (el) {
            const val = $(this).val();
            self._applyStyle(el, 'stroke-width', val);
            self._drawStyle.strokeWidth = val;
        });

        // Stroke dash
        live('#prop-stroke-dash', function (el) {
            const val = $(this).val();
            if (val === 'none') self._applyStyle(el, 'stroke-dasharray', null);
            else self._applyStyle(el, 'stroke-dasharray', val);
            self._drawStyle.strokeDasharray = val;
        });

        // Fill color
        live('#prop-fill-color', function (el) {
            const val   = $(this).val();
            const opStr = $('#prop-fill-opacity').val();
            const op    = parseFloat(opStr);
            self._applyStyle(el, 'fill', val);
            self._applyStyle(el, 'fill-opacity', String(isNaN(op) ? 1 : op));
            self._drawStyle.fill = val;
            $('#prop-fill-hex').text(val);
        });

        // Fill opacity
        live('#prop-fill-opacity', function (el) {
            const op = parseFloat($(this).val());
            self._applyStyle(el, 'fill-opacity', String(op));
        });

        // No fill
        $(document).on('click.prop', '#prop-no-fill', function () {
            if (!self._propPanelTarget) return;
            self._applyStyle(self._propPanelTarget, 'fill', 'none');
            self._applyStyle(self._propPanelTarget, 'fill-opacity', null);
            self._drawStyle.fill = 'none';
            $('#prop-fill-opacity').val(0);
        });

        // Text content
        live('#prop-text-content', function (el) {
            const value = $(this).val();
            if (el.tagName?.toLowerCase() === 'text' && self._renderWrappedText) {
                self._renderWrappedText(el, value, parseFloat(el.getAttribute('data-text-width') || '240'));
            } else {
                el.textContent = value;
            }
        });

        // Font size
        live('#prop-font-size', function (el) {
            el.setAttribute('font-size', $(this).val());
        });

        // Font family
        live('#prop-font-family', function (el) {
            el.setAttribute('font-family', $(this).val());
        });

        // Border radius (rect)
        live('#prop-border-radius', function (el) {
            const v = $(this).val();
            el.setAttribute('rx', v);
            el.setAttribute('ry', v);
            $('#prop-radius-val').text(`${v}px`);
        });

        // Align buttons
        $(document).on('click.prop', '.prop-align-btn', function () {
            const action = $(this).data('align');
            const map = {
                left:    () => self.alignLeft(),
                centerH: () => self.alignCenterH(),
                right:   () => self.alignRight(),
                top:     () => self.alignTop(),
                centerV: () => self.alignCenterV(),
                bottom:  () => self.alignBottom(),
                distH:   () => self.distributeH(),
                distV:   () => self.distributeV(),
            };
            if (map[action]) map[action]();
        });

        // Capture before-state when a field is focused so undo can restore it
        $(document).on('focus.propcommit', '#prop-x, #prop-y, #prop-w, #prop-h, #prop-rotation', () => {
            if (!self._propPanelTarget) return;
            self._propBeforeState = self._captureFullState();
        });

        // Push to history on change-end (blur / pointerup)
        $(document).on('change.propcommit', '#prop-x, #prop-y, #prop-w, #prop-h, #prop-rotation', () => {
            if (!self._propPanelTarget) return;
            const before = self._propBeforeState || self._captureFullState();
            self._propBeforeState = null;
            self.pushHistory('Property Edit', before, self._captureFullState());
        });
    },

    // ── Color utilities ───────────────────────────────────────
    _isValidColor(str) {
        if (!str || str === 'none' || str === 'transparent') return false;
        const s = new Option().style;
        s.color = str;
        return s.color !== '';
    },

    _toHex(color) {
        if (!color || color === 'none') return '#000000';
        if (/^#[0-9a-f]{3,6}$/i.test(color)) return color;
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = color;
        return ctx.fillStyle; // browser normalises to #rrggbb
    },
});
