/* ============================================================
   Schema Editor — Contextual command rail
   Tool settings occupy the primary rail. Selection actions appear
   in a subordinate popover so creation and arrangement stay distinct.
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {
    initContextualToolbar() {
        if (document.getElementById('gxContextRail')) return;
        const rail = document.createElement('section');
        rail.id = 'gxContextRail';
        rail.className = 'gx-context-rail';
        rail.setAttribute('aria-label', 'Tool options');
        rail.innerHTML = '<div class="gx-context-tool"></div><div class="gx-selection-actions"></div>';
        document.body.appendChild(rail);
        this._contextRail = rail;
        this._bindContextualToolbar();
        this._refreshContextualToolbar();
    },

    _contextButton(icon, label, action, opts = {}) {
        return `<button type="button" class="gx-rail-btn${opts.active ? ' is-active' : ''}" ` +
            `data-context-action="${action}" title="${opts.title || label}"${opts.disabled ? ' disabled' : ''}>` +
            `<iconify-icon icon="${icon}"></iconify-icon><span>${label}</span></button>`;
    },

    _styleControls({ fill = true } = {}) {
        const stroke = this._drawStyle?.stroke || '#4facfe';
        const width = this._drawStyle?.strokeWidth || '2';
        const currentFill = this._drawStyle?.fill;
        const fillColor = currentFill && currentFill !== 'none' ? currentFill : '#4facfe';
        return `<label class="gx-rail-color" title="Stroke color"><span>Stroke</span>` +
            `<input type="color" data-context-input="stroke" value="${stroke}"></label>` +
            `<label class="gx-rail-field" title="Stroke width"><span>Width</span>` +
            `<input type="number" data-context-input="width" min="0.5" max="20" step="0.5" value="${width}"></label>` +
            `<label class="gx-rail-select"><span>Line</span><select data-context-input="dash">` +
            `<option value="none">Solid</option><option value="4,4">Dashed</option>` +
            `<option value="2,4">Dotted</option><option value="8,4,2,4">Dash-dot</option></select></label>` +
            (fill ? `<label class="gx-rail-color" title="Fill color"><span>Fill</span>` +
                `<input type="color" data-context-input="fill" value="${fillColor}"></label>` +
                this._contextButton('material-symbols:format-color-reset-outline', 'No fill', 'no-fill', {
                    active: currentFill === 'none'
                }) : '');
    },

    _wireControls() {
        const R = window.GxEdgeRouter;
        const styles = R?.STYLES || ['direct', 'manhattan'];
        const labels = R?.LABELS || { direct: 'Direct', manhattan: 'Manhattan' };
        const routes = styles.map(s => `<option value="${s}">${labels[s] || s}</option>`).join('');
        const ends = { none: 'None', arrow: 'Arrow', triangle: 'Triangle', diamond: 'Diamond', circle: 'Circle', many: "Crow's foot" };
        const endOptions = this._WIRE_END_STYLES.map(s => `<option value="${s}">${ends[s]}</option>`).join('');
        return `<div class="gx-rail-identity"><iconify-icon icon="material-symbols:route-outline"></iconify-icon>` +
            `<strong>Wire</strong></div><span class="gx-rail-divider"></span>` +
            `<label class="gx-rail-select"><span>Route</span><select data-context-input="route">${routes}</select></label>` +
            `<label class="gx-rail-select"><span>Start</span><select data-context-input="start">${endOptions}</select></label>` +
            `<label class="gx-rail-select"><span>End</span><select data-context-input="end">${endOptions}</select></label>` +
            this._styleControls({ fill: false });
    },

    _isRoutedWire(el) {
        const visual = el?.classList?.contains('wire-hitbox') ? el.previousElementSibling : el;
        return visual?.tagName?.toLowerCase() === 'path' &&
            (visual.getAttribute('data-geo-class') === 'wire' || visual.hasAttribute('data-route-style'));
    },

    _routePointsOf(el) {
        const visual = el?.classList?.contains('wire-hitbox') ? el.previousElementSibling : el;
        if (!visual) return [];
        try {
            const saved = JSON.parse(visual.getAttribute('data-route-points') || 'null');
            if (Array.isArray(saved) && saved.length > 1) return saved;
        } catch (_) {}
        // Imported/legacy routes have no authored waypoint record. Preserve
        // their SVG node identity and recover endpoints without involving the
        // canvas selection or replacing the node.
        try {
            const len = visual.getTotalLength();
            const a = visual.getPointAtLength(0), b = visual.getPointAtLength(len);
            return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
        } catch (_) { return []; }
    },

    _refreshContextualToolbar() {
        const rail = this._contextRail;
        if (!rail || !this._drawStyle) return;
        const tool = this.activeTool || 'select';
        const toolHost = rail.querySelector('.gx-context-tool');
        const selectionHost = rail.querySelector('.gx-selection-actions');
        const selected = this._selection || [];
        const names = { select: 'Select', hand: 'Hand', pen: 'Pen', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', text: 'Text', measure: 'Measure' };

        const selectedWires = selected.filter(el => this._isRoutedWire(el));
        if (tool === 'wire' || (tool === 'select' && selectedWires.length === selected.length && selectedWires.length)) {
            toolHost.innerHTML = this._wireControls();
        }
        else if (['pen', 'line'].includes(tool)) {
            toolHost.innerHTML = `<div class="gx-rail-identity"><strong>${names[tool]}</strong></div>` + this._styleControls({ fill: false });
        } else if (['rect', 'ellipse', 'polygon'].includes(tool)) {
            toolHost.innerHTML = `<div class="gx-rail-identity"><strong>${names[tool]}</strong></div>` + this._styleControls({ fill: true });
        } else if (tool === 'measure') {
            toolHost.innerHTML = `<div class="gx-rail-identity"><iconify-icon icon="material-symbols:straighten-outline"></iconify-icon><strong>Measure</strong></div>` +
                `<label class="gx-rail-select"><span>Unit</span><select data-context-input="unit">` +
                ['px','mm','cm','m','in','ft'].map(u => `<option value="${u}">${u}</option>`).join('') +
                `</select></label>` + this._contextButton('material-symbols:tune', 'Calibrate', 'calibrate');
        } else if (tool === 'select' && selected.length) {
            const visual = this._getVisualTarget?.(selected[0]) || selected[0];
            const tag = visual.tagName?.toLowerCase();
            const supportsFill = !['line', 'polyline', 'path'].includes(tag) || visual.getAttribute('fill') !== 'none';
            const stroke = visual.getAttribute?.('stroke');
            const width = visual.getAttribute?.('stroke-width');
            const fill = visual.getAttribute?.('fill');
            if (stroke && this._isValidColor?.(stroke)) this._drawStyle.stroke = this._toHex(stroke);
            if (width) this._drawStyle.strokeWidth = width;
            if (fill && fill !== 'none' && this._isValidColor?.(fill)) this._drawStyle.fill = this._toHex(fill);
            else if (fill === 'none') this._drawStyle.fill = 'none';
            toolHost.innerHTML = `<div class="gx-rail-identity"><strong>Style</strong><small>${selected.length === 1 ? (selected[0].getAttribute?.('data-layer-name') || selected[0].id || tag || 'object') : `${selected.length} objects`}</small></div>` +
                `<span class="gx-rail-divider"></span>` + this._styleControls({ fill: supportsFill });
        } else {
            toolHost.innerHTML = `<div class="gx-rail-identity"><strong>${names[tool] || tool}</strong>` +
                `<small>${selected.length ? `${selected.length} selected` : 'Choose an object or drawing tool'}</small></div>`;
        }

        const dash = toolHost.querySelector('[data-context-input="dash"]');
        if (dash) dash.value = this._drawStyle.strokeDasharray || 'none';
        const route = toolHost.querySelector('[data-context-input="route"]');
        if (route) route.value = selectedWires.length
            ? (selectedWires[0].getAttribute('data-route-style') || 'manhattan')
            : (this._wireRouteStyle || 'manhattan');
        const start = toolHost.querySelector('[data-context-input="start"]');
        const end = toolHost.querySelector('[data-context-input="end"]');
        if (start) start.value = this._wireEndStyle?.start || 'none';
        if (end) end.value = this._wireEndStyle?.end || 'none';
        const unit = toolHost.querySelector('[data-context-input="unit"]');
        if (unit) unit.value = this._measureUnit || 'px';

        if (!selected.length) {
            selectionHost.innerHTML = '';
            rail.classList.remove('has-selection');
            return;
        }
        rail.classList.add('has-selection');
        const multi = selected.length > 1;
        const groupSelected = selected.length === 1 && selected[0].tagName?.toLowerCase() === 'g';
        const allLocked = selected.every(el => el.dataset?.locked === 'true');
        selectionHost.innerHTML = `<span class="gx-selection-count">${selected.length}</span>` +
            this._contextButton('material-symbols:group-work-outline', 'Group', 'group', { disabled: !multi }) +
            this._contextButton('material-symbols:grid-view-outline', 'Ungroup', 'ungroup', { disabled: !groupSelected }) +
            this._contextButton(allLocked ? 'material-symbols:lock-open-outline' : 'material-symbols:lock-outline', allLocked ? 'Unlock' : 'Lock', 'lock') +
            `<span class="gx-rail-divider"></span>` +
            `<button type="button" class="gx-rail-btn gx-more-btn" data-context-action="align-menu" ${multi ? '' : 'disabled'}>` +
            `<iconify-icon icon="material-symbols:align-horizontal-left"></iconify-icon><span>Align</span><iconify-icon icon="material-symbols:arrow-drop-down"></iconify-icon></button>` +
            `<button type="button" class="gx-rail-btn gx-more-btn" data-context-action="order-menu">` +
            `<iconify-icon icon="material-symbols:layers-outline"></iconify-icon><span>Position</span><iconify-icon icon="material-symbols:arrow-drop-down"></iconify-icon></button>` +
            this._contextButton('material-symbols:delete-outline', 'Delete', 'delete', { title: 'Delete selection' });
    },

    _bindContextualToolbar() {
        const rail = this._contextRail;
        rail.addEventListener('input', e => this._handleContextInput(e));
        rail.addEventListener('change', e => this._handleContextInput(e));
        rail.addEventListener('click', e => {
            const button = e.target.closest('[data-context-action]');
            if (!button || button.disabled) return;
            this._handleContextAction(button.dataset.contextAction, button);
        });
        document.addEventListener('pointerdown', e => {
            if (!e.target.closest('.gx-context-menu, #gxContextRail')) this._closeContextMenus();
        });
    },

    _handleContextInput(e) {
        const kind = e.target.dataset.contextInput;
        if (!kind) return;
        const value = e.target.value;
        if (kind === 'route') {
            const selectedWires = (this._selection || []).filter(el => this._isRoutedWire(el));
            if (this.activeTool === 'select' && selectedWires.length) {
                const before = this._captureFullState?.();
                selectedWires.forEach(el => {
                    const points = this._routePointsOf(el);
                    if (points.length < 2) return;
                    // Edit the selected SVG routing node in place. Replacing it
                    // would sever selection, hitbox, pin metadata and lineage.
                    el.setAttribute('d', this._wirePathFromPoints(points, value));
                    el.setAttribute('data-route-style', value);
                    el.setAttribute('data-route-points', JSON.stringify(points));
                });
                this.pushHistory?.('Change wire route', before, this._captureFullState?.());
                this._renderHandles?.();
                this._scheduleGeoAnalysis?.();
            } else {
                this._wireRouteStyle = value;
                if (this._smoothTrace) this.showToast('Smooth Trace overrides the selected route', 'warning');
                if (this._drawPreview && this._drawState?.points) this._drawPreview.setAttribute('d', this._wirePathFromPoints(this._drawState.points));
            }
        } else if (kind === 'start' || kind === 'end') this._wireEndStyle[kind] = value;
        else if (kind === 'unit') this.setMeasureUnit(value);
        else {
            const map = { stroke: 'stroke', width: 'stroke-width', dash: 'stroke-dasharray', fill: 'fill' };
            const attr = map[kind];
            if (!attr) return;
            if (kind === 'stroke') this._drawStyle.stroke = value;
            if (kind === 'width') this._drawStyle.strokeWidth = value;
            if (kind === 'dash') this._drawStyle.strokeDasharray = value;
            if (kind === 'fill') this._drawStyle.fill = value;
            (this._selection || []).forEach(el => this._applyStyle(el, attr, value === 'none' ? null : value));
            this._renderHandles?.();
            this._refreshPropertyPanel?.();
        }
    },

    _handleContextAction(action, anchor) {
        const selected = this._selection || [];
        if (action === 'group') return this.groupSelected();
        if (action === 'ungroup') return this.ungroupSelected();
        if (action === 'delete') return this.deleteSelected();
        if (action === 'calibrate') return this._showMeasureModal();
        if (action === 'no-fill') {
            this._drawStyle.fill = 'none';
            selected.forEach(el => this._applyStyle(el, 'fill', 'none'));
            return this._refreshContextualToolbar();
        }
        if (action === 'lock') {
            const lock = !selected.every(el => el.dataset?.locked === 'true');
            const before = this._captureFullState?.();
            selected.forEach(el => el.setAttribute('data-locked', String(lock)));
            this.pushHistory?.(lock ? 'Lock' : 'Unlock', before, this._captureFullState?.());
            this.buildLayersTree?.();
            this._refreshContextualToolbar();
            return;
        }
        if (action === 'align-menu') return this._showContextMenu(anchor, [
            ['Align left', 'left'], ['Center horizontally', 'centerH'], ['Align right', 'right'],
            ['Align top', 'top'], ['Center vertically', 'centerV'], ['Align bottom', 'bottom'],
            ['Distribute horizontally', 'distH'], ['Distribute vertically', 'distV']
        ]);
        if (action === 'order-menu') return this._showContextMenu(anchor, [
            ['Bring to front', 'front'], ['Bring forward', 'up'], ['Send backward', 'down'], ['Send to back', 'back']
        ]);
        const align = { left:'alignLeft', centerH:'alignCenterH', right:'alignRight', top:'alignTop', centerV:'alignCenterV', bottom:'alignBottom', distH:'distributeH', distV:'distributeV' };
        if (align[action]) return this[align[action]]();
        if (['front','up','down','back'].includes(action)) return this._contextReorder(action);
    },

    _showContextMenu(anchor, items) {
        this._closeContextMenus();
        const menu = document.createElement('div');
        menu.className = 'gx-context-menu';
        menu.innerHTML = items.map(([label, action]) => `<button type="button" data-context-menu-action="${action}">${label}</button>`).join('');
        document.body.appendChild(menu);
        const r = anchor.getBoundingClientRect();
        menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 10)}px`;
        menu.style.top = `${r.bottom + 7}px`;
        menu.addEventListener('click', e => {
            const action = e.target.closest('[data-context-menu-action]')?.dataset.contextMenuAction;
            if (action) this._handleContextAction(action, anchor);
            this._closeContextMenus();
        });
    },

    _closeContextMenus() { document.querySelectorAll('.gx-context-menu').forEach(el => el.remove()); },

    _contextReorder(op) {
        const selected = (this._selection || []).filter(el => el.parentNode);
        if (!selected.length) return;
        const before = this._captureFullState?.();
        selected.forEach(el => {
            const target = el.closest?.('.wire-group, .component-group') || el;
            const parent = target.parentNode;
            if (!parent) return;
            if (op === 'front') parent.appendChild(target);
            if (op === 'back') parent.insertBefore(target, parent.firstElementChild);
            if (op === 'up' && target.nextElementSibling) parent.insertBefore(target.nextElementSibling, target);
            if (op === 'down' && target.previousElementSibling) parent.insertBefore(target, target.previousElementSibling);
        });
        this.pushHistory?.('Reorder selection', before, this._captureFullState?.());
        this.buildLayersTree?.();
        this._renderHandles?.();
    }
});
