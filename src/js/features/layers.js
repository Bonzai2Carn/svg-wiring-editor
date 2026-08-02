/* ============================================================
   SVG Wiring Editor — Layers Feature
   Scene-graph panel: Structure view (Z-order DOM walk) +
   Analysis view (GeoEngine topology buckets).
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Layers panel entry points ─────────────────────────────

    showLayers() {
        this.$sidePanel.addClass('open');
        this.buildLayersTree();
        this._initLayerObserver();
        // Bind Alt+M for merge once per editor instance
        if (!this._layerKeysBound) {
            this._layerKeysBound = true;
            $(document).on('keydown.layerKeys', (e) => {
                if (e.altKey && e.key.toLowerCase() === 'm') {
                    e.preventDefault();
                    this._mergeSelectedLayers();
                }
            });
        }
    },

    _initLayerObserver() {
        if (!this._layerObserver) {
            this._layerObserver = new MutationObserver(() => {
                clearTimeout(this._layerObserverTimer);
                this._layerObserverTimer = setTimeout(() => this.buildLayersTree(), 150);
            });
        }
        // Always re-observe: _contentRoot may be a new element after canvas switch
        this._layerObserver.disconnect();
        const root = this._contentRoot;
        if (!root) return;
        this._layerObserver.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['id', 'data-symbol', 'data-geo-class'],
        });
    },

    buildLayersTree() {
        this._initLayerObserver();   // re-attach in case _contentRoot changed
        const $panel = $('#layersPanel');
        $panel.empty();

        // Default mode: structure view
        if (!this._layerPanelMode) this._layerPanelMode = 'structure';

        // Walk _contentRoot (inside _cameraRotGroup) — structural elements never appear here.
        const contentRoot = this._contentRoot;
        const rootElements = contentRoot
            ? Array.from(contentRoot.children)
                .filter(el => !el.classList.contains('selection-handle-group')
                    && el.id !== '_gridLayer'
                    && el.getAttribute('data-se-system') !== 'true')
            : [];

        if (rootElements.length === 0) {
            $panel.html('<p style="color:rgba(255,255,255,0.4);font-size:11px;padding:8px;">Load an SVG to see layers.</p>');
            return;
        }

        // ── View toggle (Structure / Analysis) ───────────────────
        const $toggle = $(`
            <div class="layer-view-toggle" id="layerViewToggle">
                <button class="lvt-btn ${this._layerPanelMode === 'structure' ? 'active' : ''}" data-view="structure">
                    <iconify-icon icon="material-symbols:account-tree-outline" style="font-size:11px;"></iconify-icon> Structure
                </button>
                <button class="lvt-btn ${this._layerPanelMode === 'analysis' ? 'active' : ''}" data-view="analysis">
                    <iconify-icon icon="material-symbols:schema-outline" style="font-size:11px;"></iconify-icon> Analysis
                </button>
            </div>
        `);
        $toggle.find('.lvt-btn').on('click', (e) => {
            e.stopPropagation(); // prevent document close-panel handler seeing detached target
            const view = $(e.currentTarget).data('view');
            this._layerPanelMode = view;
            this.buildLayersTree();
        });
        // Render toggle above the scroll container so it's always visible
        $('#layerViewToggle').remove();
        $('#layersPanel').before($toggle);

        // ── Dispatch to correct view ──────────────────────────────
        if (this._layerPanelMode === 'analysis') {
            const liveWires      = (this.wires      || []).filter(w => w.element?.isConnected);
            const liveComponents = (this.components || []).filter(c => c.element?.isConnected);
            const liveConnectors = (this.connectors || []).filter(c => c.element?.isConnected);
            this._buildAnalysisView($panel, liveWires, liveComponents, liveConnectors);
        } else {
            this._buildStructureView($panel, rootElements, 0);
        }
    },

    // ── Structure view: recursive DOM walk in Z-order ─────────
    _buildStructureView($panel, elements, depth) {
        elements.forEach((el, idx) => {
            if (!el?.dataset) return;
            if (el.getAttribute('data-se-system') === 'true') return;

            const tag        = el.tagName?.toLowerCase() || 'el';
            const id         = el.id || `${tag}_${idx}`;
            const name       = el.getAttribute('data-layer-name') || el.id || `${tag}_${idx}`;
            const isGroup    = tag === 'g';
            const isGeoGrp   = el.classList.contains('wire-group') || el.classList.contains('component-group');
            const isLabelGrp = isGroup && el.hasAttribute('data-layer-name');
            const childEls   = isGroup ? Array.from(el.children).filter(c => c.getAttribute('data-se-system') !== 'true') : [];
            const isLocked   = el.dataset?.locked === 'true';
            const isHidden   = el.style?.display === 'none';

            // Icon
            let rowIcon = 'material-symbols:crop-square-outline';
            if (isLabelGrp) rowIcon = 'material-symbols:folder-open-outline';
            else if (isGeoGrp) rowIcon = 'material-symbols:layers-outline';
            else if (tag === 'path' || tag === 'line' || tag === 'polyline') rowIcon = 'material-symbols:route-outline';
            else if (tag === 'circle' || tag === 'ellipse') rowIcon = 'material-symbols:radio-button-checked';
            else if (tag === 'rect') rowIcon = 'material-symbols:rectangle-outline';
            else if (tag === 'text') rowIcon = 'material-symbols:text-fields';

            // Inline topology badge
            const badge = this._getTopoBadge(el);

            // Lint badge — count unconnected .pin-point descendants (or self if it's a pin)
            const unconnectedCount = el.querySelectorAll?.('.pin-point[data-lint-unconnected]').length || 0;
            const selfLint = el.hasAttribute?.('data-lint-unconnected') ? 1 : 0;
            const lintTotal = unconnectedCount + selfLint;
            const lintBadge = lintTotal > 0
                ? `<span class="layer-lint-badge lint-error" title="${lintTotal} unconnected pin${lintTotal > 1 ? 's' : ''}">!</span>`
                : '';

            // Group label for items nested inside a named <g>
            const parentGroup = el.parentElement?.hasAttribute('data-layer-name')
                ? (el.parentElement.getAttribute('data-layer-name') || el.parentElement.id)
                : null;
            const groupSuffix = (depth === 0 && parentGroup) ? '' :
                (parentGroup ? `<span style="font-size:9px;opacity:0.35;margin-left:2px;">∈ ${parentGroup}</span>` : '');

            const lockIcon  = isLocked ? 'material-symbols:lock-outline' : 'material-symbols:lock-open-outline';
            const lockTitle = isLocked ? 'Unlock' : 'Lock';
            const visIcon   = isHidden ? 'material-symbols:visibility-off-outline' : 'material-symbols:visibility-outline';

            const $row = $(`
                <div class="layer-item${isLocked ? ' layer-item-locked' : ''}"
                     data-element-id="${id}"
                     draggable="true"
                     style="margin-left:${depth * 12}px;${isHidden ? 'opacity:0.4;' : ''}">
                    <span class="layer-drag-handle" title="Drag to reorder">⠿</span>
                    ${isGroup && childEls.length ? `<span class="layer-collapse-arrow" style="font-size:9px;width:10px;flex-shrink:0;cursor:pointer;">▾</span>` : '<span style="width:10px;flex-shrink:0;"></span>'}
                    <iconify-icon icon="${rowIcon}" style="font-size:12px;flex-shrink:0;opacity:0.7;"></iconify-icon>
                    ${badge}${lintBadge}
                    <span class="layer-name" title="Double-click to rename">${name}</span>
                    ${groupSuffix}
                    <div style="margin-left:auto;display:flex;gap:2px;align-items:center;">
                        <button class="layer-toggle layer-lock-btn" title="${lockTitle}"
                                style="background:none;border:none;cursor:pointer;color:${isLocked ? '#fbbf24' : 'rgba(255,255,255,0.3)'};">
                            <iconify-icon icon="${lockIcon}" style="font-size:12px;"></iconify-icon>
                        </button>
                        <button class="layer-toggle layer-vis-btn" title="Toggle visibility"
                                style="background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.4);">
                            <iconify-icon icon="${visIcon}" style="font-size:12px;"></iconify-icon>
                        </button>
                        <button class="layer-toggle layer-del-btn" title="Delete"
                                style="background:none;border:none;cursor:pointer;color:rgba(255,100,100,0.45);">
                            <iconify-icon icon="material-symbols:delete-outline-rounded" style="font-size:12px;"></iconify-icon>
                        </button>
                    </div>
                </div>
            `);

            // Children container (collapsible)
            const $children = $('<div class="layer-struct-children">');

            // Collapse/expand arrow
            $row.find('.layer-collapse-arrow').on('click', e => {
                e.stopPropagation();
                const open = $children.is(':visible');
                $children.toggle(!open);
                $(e.currentTarget).text(open ? '▸' : '▾');
            });

            // Click → select (Shift+click adds to multi-selection for merge)
            $row.on('click', e => {
                if ($(e.target).closest('.layer-vis-btn, .layer-lock-btn, .layer-del-btn, .layer-drag-handle, .layer-collapse-arrow').length) return;
                if (isLocked) { this.showToast('Element is locked', 'error'); return; }
                if (e.shiftKey) {
                    if (!this._layerSelectedItems) this._layerSelectedItems = new Map();
                    if (this._layerSelectedItems.has(el)) {
                        this._layerSelectedItems.delete(el);
                        $row.removeClass('layer-selected active');
                    } else {
                        this._layerSelectedItems.set(el, $row);
                        $row.addClass('layer-selected active');
                        this.selectEl?.(el, true);
                    }
                } else {
                    this._clearLayerSelection();
                    if (!this._layerSelectedItems) this._layerSelectedItems = new Map();
                    this._layerSelectedItems.set(el, $row);
                    $row.addClass('layer-selected active');
                    this.selectEl?.(el);
                }
            });

            // Right-click → context menu
            $row.on('contextmenu', e => {
                e.preventDefault();
                if (!this._layerSelectedItems?.has(el)) {
                    this._clearLayerSelection();
                    if (!this._layerSelectedItems) this._layerSelectedItems = new Map();
                    this._layerSelectedItems.set(el, $row);
                    $row.addClass('layer-selected active');
                }
                this._showLayerContextMenu(e.clientX, e.clientY);
            });

            // Double-click → rename
            $row.find('.layer-name').on('dblclick', e => {
                e.stopPropagation();
                if (isLocked) return;
                this.startLayerRename(el, $row, $(e.currentTarget));
            });

            // Hover highlight
            $row.on('mouseenter', () => { if (!$row.hasClass('active')) $(el).addClass('layer-hover-highlight'); })
                .on('mouseleave', () => $(el).removeClass('layer-hover-highlight'));

            // Visibility toggle
            $row.find('.layer-vis-btn').on('click', e => {
                e.stopPropagation();
                const hidden = el.style.display === 'none';
                el.style.display = hidden ? '' : 'none';
                $row.css('opacity', hidden ? 1 : 0.4);
                $row.find('.layer-vis-btn iconify-icon').attr('icon',
                    hidden ? 'material-symbols:visibility-outline' : 'material-symbols:visibility-off-outline');
            });

            // Lock toggle
            $row.find('.layer-lock-btn').on('click', e => {
                e.stopPropagation();
                const locked = el.dataset.locked === 'true';
                el.setAttribute('data-locked', locked ? 'false' : 'true');
                this.showToast(locked ? 'Unlocked' : 'Locked', 'success');
                this.buildLayersTree();
            });

            // Delete
            $row.find('.layer-del-btn').on('click', e => {
                e.stopPropagation();
                if (isLocked) return;
                if (!this._layerSelectedItems) this._layerSelectedItems = new Map();
                if (!this._layerSelectedItems.has(el)) {
                    this._clearLayerSelection();
                    this._layerSelectedItems.set(el, $row);
                }
                this._deleteSelectedLayerItems();
            });

            // ── Drag-to-reorder ───────────────────────────────────
            const rowEl = $row[0];
            rowEl._svgEl = el;

            rowEl.addEventListener('dragstart', e => {
                this._layerDragEl = el;
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => $row.css('opacity', 0.4), 0);
            });
            rowEl.addEventListener('dragend', () => {
                $row.css('opacity', '');
                $('#layersPanel .layer-drop-indicator').remove();
            });

            rowEl.addEventListener('dragover', e => {
                if (!this._layerDragEl || this._layerDragEl === el) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                $('#layersPanel .layer-drop-indicator').remove();
                const $ind = $('<div class="layer-drop-indicator">');
                $row.before($ind);
            });

            rowEl.addEventListener('drop', e => {
                e.preventDefault();
                if (!this._layerDragEl || this._layerDragEl === el) return;
                const src = this._layerDragEl;
                const srcContainer = src.closest?.('.wire-group, .component-group') || src;
                const tgtContainer = el.closest?.('.wire-group, .component-group') || el;
                const tgtParent = tgtContainer.parentNode;
                const isCrossLevel = srcContainer.parentNode !== tgtParent;

                // Guard: never create circular DOM (src is ancestor of tgt's parent)
                if (srcContainer === tgtParent || srcContainer.contains?.(tgtParent)) {
                    this.showToast('Cannot move a group into one of its own children', 'error');
                } else {
                    const before = this._captureFullState?.();
                    tgtParent.insertBefore(srcContainer, tgtContainer);
                    this.pushHistory?.(isCrossLevel ? 'Move to Group' : 'Reorder', before, this._captureFullState?.());
                    if (isCrossLevel) this._scheduleGeoAnalysis?.();
                    this.buildLayersTree();
                    if (isCrossLevel) this.showToast('Moved to new level', 'success');
                }
                this._layerDragEl = null;
                $('#layersPanel .layer-drop-indicator').remove();
            });

            $panel.append($row);

            // Recurse into named groups and unclassified <g> — never into wire-group/component-group internals
            if (isGroup && childEls.length && !isGeoGrp) {
                $panel.append($children);
                this._buildStructureView($children, childEls, depth + 1);
            }
        });
    },

    // ── Topology badge helper ──────────────────────────────────
    _getTopoBadge(el) {
        if (!el) return '';
        const manualCls = el.getAttribute('data-geo-class');
        if (manualCls) return `<span class="layer-topo-badge badge-${manualCls}">${manualCls}</span>`;
        const inWires = (this.wires || []).some(w => w.element === el);
        if (inWires) return `<span class="layer-topo-badge badge-wire">wire</span>`;
        const inComp  = (this.components || []).find(c => c.element === el);
        if (inComp)  return `<span class="layer-topo-badge badge-${inComp.type || 'component'}">${inComp.type || 'comp'}</span>`;
        const inConn  = (this.connectors || []).some(c => c.element === el);
        if (inConn)  return `<span class="layer-topo-badge badge-connector">pin</span>`;
        return '';
    },


    // ── Analysis view: GeoEngine topology buckets ─────────────
    // All live elements are visible here — no group exclusion.
    _buildAnalysisView($panel, liveWires, liveComponents, liveConnectors) {
        // Always-visible Run Analysis button — lets users manually trigger GeoEngine
        // after a timeline switch or import where analysis may not have re-run yet.
        const $runBtn = $(`
            <button title="Re-run geometry analysis on current SVG"
                    style="width:100%;background:rgba(79,172,254,0.1);border:1px solid rgba(79,172,254,0.25);
                           border-radius:5px;color:#4facfe;font-size:11px;padding:5px 8px;cursor:pointer;
                           display:flex;align-items:center;gap:5px;margin-bottom:8px;">
                <iconify-icon icon="material-symbols:refresh" style="font-size:12px;"></iconify-icon>
                Run Analysis
            </button>
        `);
        $runBtn.on('click', () => {
            if (typeof this.analyzeWiringDiagram === 'function') {
                this.analyzeWiringDiagram();
                this.buildLayersTree();
            }
        });
        $panel.append($runBtn);

        if (!liveWires.length && !liveComponents.length && !liveConnectors.length) {
            $panel.append('<p style="color:rgba(255,255,255,0.4);font-size:11px;padding:4px 0 8px;">No topology data — click Run Analysis or load an SVG with wires and components.</p>');
            return;
        }

        // Build semantic buckets from graph data
        const groups = {
            wires: { label: 'Wires', icon: 'material-symbols:route-outline', items: [], color: '#4facfe' },
            connectors: { label: 'Connectors', icon: 'material-symbols:radio-button-checked', items: [], color: '#a78bfa' },
            modules: { label: 'Modules', icon: 'material-symbols:memory-outline', items: [], color: '#34d399' },
            components: { label: 'Components', icon: 'material-symbols:category-outline', items: [], color: '#94a3b8' },
            junctions: { label: 'Junctions', icon: 'material-symbols:hub-outline', items: [], color: '#fbbf24' },
        };

        // Populate wires bucket (live records only)
        liveWires.forEach(w => {
            const extraArr = [];
            if (w.color !== 'black') extraArr.push(w.color);
            if (w.length) extraArr.push(`${w.length.toFixed(0)}px`);
            if (w.linearity != null) extraArr.push(`l: ${w.linearity.toFixed(2)}`);
            groups.wires.items.push({
                el: w.element, id: w.id, label: w.id,
                classType: 'wire',
                extra: extraArr.join(' · ')
            });
        });

        // Populate connectors bucket (live pin-points)
        liveConnectors.forEach(c => {
            groups.connectors.items.push({
                el: c.element, id: c.id, label: c.id,
                classType: 'connector',
                extra: 'pin',
            });
        });

        // Populate modules: bypass GeoEngine — query live DOM for domain symbols directly
        const trackedByGeo = new Set();
        this._contentRoot.querySelectorAll('[data-symbol]').forEach((el, i) => {
            if (!el.isConnected) return;
            const manualClass = el.getAttribute('data-geo-class');
            const symType = el.getAttribute('data-symbol');
            const domId   = el.id || `sym_${symType}_${i}`;
            const cls = manualClass || 'module';
            const item = {
                el, id: domId, label: domId,
                classType: cls,
                extra: symType,
            };
            
            if (cls === 'connector') groups.connectors.items.push(item);
            else if (cls === 'wire') groups.wires.items.push(item);
            else if (cls === 'junction') groups.junctions.items.push(item);
            else if (cls === 'component') groups.components.items.push(item);
            else groups.modules.items.push(item);
            
            trackedByGeo.add(el);
        });

        // Remaining GeoEngine components (live, non-domain-symbol shapes)
        liveComponents.forEach(c => {
            if (trackedByGeo.has(c.element)) return;
            const item = {
                el: c.element, id: c.id, label: c.id,
                classType: c.type,
                extra: c.circularity != null ? `C: ${c.circularity.toFixed(2)}` : ''
            };
            if (c.type === 'connector')
                groups.connectors.items.push(item);
            else if (c.type === 'module' || c.type === 'resistor' || c.type === 'capacitor' ||
                c.type === 'relay' || c.type === 'switch')
                groups.modules.items.push(item);
            else
                groups.components.items.push(item);
        });

        // Populate junction bucket from graph
        if (this.graph?.nodes) {
            this.graph.nodes.forEach(node => {
                if (node.kind === 'junction') {
                    groups.junctions.items.push({
                        el: null, id: node.id, label: node.id,
                        classType: 'junction',
                        extra: `deg ${node.degree} (${node.x.toFixed(1)}, ${node.y.toFixed(1)})`,
                    });
                }
            });
        }

        // Render each group
        Object.values(groups).forEach(group => {
            if (!group.items.length) return;   // skip empty groups

            const groupId = `lg_${group.label.toLowerCase()}`;
            const $group = $(`
                <div class="layer-group" id="${groupId}">
                    <div class="layer-group-header" data-group="${groupId}">
                        <span class="layer-group-arrow">▾</span>
                        <iconify-icon icon="${group.icon}" style="font-size:13px;color:${group.color};"></iconify-icon>
                        <span class="layer-group-label" style="color:${group.color};">${group.label}</span>
                        <span class="layer-group-count">${group.items.length}</span>
                        <button class="layer-group-vis" title="Toggle group visibility"
                                style="margin-left:auto;background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.5);font-size:11px;"
                                data-vis-group="${groupId}">
                            <iconify-icon icon="material-symbols:visibility-outline" style="font-size:12px;"></iconify-icon>
                        </button>
                    </div>
                    <div class="layer-group-body" id="${groupId}_body"></div>
                </div>
            `);

            // Group collapse/expand
            $group.find('.layer-group-header').on('click', e => {
                if ($(e.target).closest('.layer-group-vis').length) return;
                const $arrow = $group.find('.layer-group-arrow');
                const $body = $group.find('.layer-group-body');
                const collapsed = $body.hasClass('collapsed');
                $body.toggleClass('collapsed', !collapsed);
                $arrow.text(collapsed ? '▾' : '▸');
            });

            // Group visibility toggle — hides all DOM elements in this bucket
            $group.find('.layer-group-vis').on('click', e => {
                e.stopPropagation();
                const $body = $group.find('.layer-group-body');
                const hidden = $group.data('hidden');
                group.items.forEach(item => {
                    if (item.el) $(item.el).css('display', hidden ? '' : 'none');
                });
                $group.data('hidden', !hidden).css('opacity', hidden ? 1 : 0.45);
            });

            // Render individual items inside the group
            const $body = $group.find(`#${groupId}_body`);
            group.items.forEach(item => {
                const isLocked = item.el ? item.el.dataset.locked === 'true' : false;
                const lockIcon = isLocked ? 'material-symbols:lock-outline' : 'material-symbols:lock-open-outline';
                const lockTitle = isLocked ? 'Unlock element' : 'Lock element';
                const canChangeClass = !!item.el && item.classType !== 'junction';

                // The dropdown HTML for overriding GeoEngine classes
                const classDropdown = canChangeClass ? `
                    <select class="geo-class-select" style="background:transparent;border:none;color:inherit;outline:none;font-size:11px;cursor:pointer;opacity:0.8;margin-right:6px;width:75px;">
                        <option value="module" ${item.classType === 'module' ? 'selected' : ''} style="background:#1e293b;">Module</option>
                        <option value="component" ${item.classType === 'component' ? 'selected' : ''} style="background:#1e293b;">Component</option>
                        <option value="wire" ${item.classType === 'wire' ? 'selected' : ''} style="background:#1e293b;">Wire</option>
                        <option value="connector" ${item.classType === 'connector' ? 'selected' : ''} style="background:#1e293b;">Connector</option>
                    </select>
                ` : `<span style="font-size:11px;opacity:0.5;margin-right:6px;width:75px;display:inline-block;">${item.classType || ''}</span>`;

                const $item = $(`
                    <div class="layer-item topo-item ${isLocked ? 'layer-item-locked' : ''}" data-element-id="${item.id}"
                         title="${item.label}  ${item.extra}">
                        <span class="layer-dot" style="background:${group.color};"></span>
                        ${classDropdown}
                        <span class="layer-name">${item.label}</span>
                        ${item.extra ? `<span class="layer-extra">${item.extra}</span>` : ''}

                        <div style="margin-left:auto; display:flex; gap:2px; align-items:center;">
                            ${item.el ? `
                            <button class="layer-toggle layer-lock-btn" title="${lockTitle}"
                                    style="background:none;border:none;cursor:pointer;color:${isLocked ? '#fbbf24' : 'rgba(255,255,255,0.3)'};">
                                <iconify-icon icon="${lockIcon}" style="font-size:12px;"></iconify-icon>
                            </button>
                            <button class="layer-toggle layer-vis-btn" title="Toggle visibility"
                                    style="background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.4);">
                                <iconify-icon icon="material-symbols:visibility-outline" style="font-size:12px;"></iconify-icon>
                            </button>
                            <button class="layer-toggle layer-del-btn" title="Delete layer"
                                    style="background:none;border:none;cursor:pointer;color:rgba(255,100,100,0.45);">
                                <iconify-icon icon="material-symbols:delete-outline-rounded" style="font-size:12px;"></iconify-icon>
                            </button>
                            ` : ''}
                        </div>
                    </div>
                `);

                // Class override dropdown — re-run GeoEngine so the element physically
                // moves to the new semantic bucket. Arrow function preserves editor `this`.
                $item.find('.geo-class-select').on('change', (e) => {
                    e.stopPropagation();
                    if (!item.el) return;
                    const newClass = $(e.target).val();
                    item.el.setAttribute('data-geo-class', newClass);
                    if (typeof this._runGeometryPipeline === 'function') {
                        this._runGeometryPipeline();
                        this.buildLayersTree();
                    }
                });

                // Click → single select or shift+click to add to multi-selection
                $item.on('click', e => {
                    if ($(e.target).closest('.layer-vis-btn, .layer-lock-btn, .layer-del-btn, .geo-class-select').length) return;
                    if (isLocked) {
                        this.showToast('Element is locked — click the lock icon to unlock', 'error');
                        return;
                    }

                    if (e.shiftKey && item.el) {
                        if (!this._layerSelectedItems) this._layerSelectedItems = new Map();
                        if (this._layerSelectedItems.has(item.el)) {
                            this._layerSelectedItems.delete(item.el);
                            $item.removeClass('layer-selected active');
                        } else {
                            this._layerSelectedItems.set(item.el, $item);
                            $item.addClass('layer-selected active');
                            this.selectEl?.(item.el, true); // additive canvas select
                        }
                    } else {
                        this._clearLayerSelection();
                        if (item.el) {
                            this._layerSelectedItems.set(item.el, $item);
                            $item.addClass('layer-selected');
                            this.selectEl?.(item.el);
                            // scrollIntoView does nothing for an SVG node inside a
                            // pan/zoom canvas — the page is not what needs to move.
                            // Fly the camera instead.
                            this.flyToElement?.(item.el);
                        }
                        $('.topo-item').removeClass('active');
                        $item.addClass('active');
                    }
                });

                // Right-click → context menu
                $item.on('contextmenu', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!this._layerSelectedItems) this._layerSelectedItems = new Map();
                    // If this item isn't already in the selection, make it the sole selection
                    if (item.el && !this._layerSelectedItems.has(item.el)) {
                        this._clearLayerSelection();
                        this._layerSelectedItems.set(item.el, $item);
                        $item.addClass('layer-selected active');
                    }
                    this._showLayerContextMenu(e.clientX, e.clientY);
                });

                // Double click → rename layer
                $item.find('.layer-name').on('dblclick', e => {
                    e.stopPropagation();
                    if (isLocked) return;
                    if (!item.el) return;
                    this.startLayerRename(item.el, $item, $(e.currentTarget));
                });

                // Hover preview
                if (item.el) {
                    $item.on('mouseenter', () => $(item.el).addClass('layer-hover-highlight'))
                        .on('mouseleave', () => $(item.el).removeClass('layer-hover-highlight'));
                }

                // Per-item lock toggle
                $item.find('.layer-lock-btn').on('click', e => {
                    e.stopPropagation();
                    if (!item.el) return;
                    const locked = item.el.dataset.locked === 'true';
                    item.el.setAttribute('data-locked', locked ? 'false' : 'true');
                    this.showToast(locked ? 'Element unlocked' : 'Element locked', 'success');
                    this.buildLayersTree();
                });

                // Per-item visibility toggle
                $item.find('.layer-vis-btn').on('click', e => {
                    e.stopPropagation();
                    if (!item.el) return;
                    const hidden = $(item.el).css('display') === 'none';
                    $(item.el).css('display', hidden ? '' : 'none');
                    $item.css('opacity', hidden ? 1 : 0.4);
                });

                // Per-item delete
                $item.find('.layer-del-btn').on('click', e => {
                    e.stopPropagation();
                    if (!item.el || item.el.dataset?.locked === 'true') return;
                    if (!this._layerSelectedItems) this._layerSelectedItems = new Map();
                    // Delete just this item unless it's part of a multi-selection
                    if (!this._layerSelectedItems.has(item.el)) {
                        this._clearLayerSelection();
                        this._layerSelectedItems.set(item.el, $item);
                    }
                    this._deleteSelectedLayerItems();
                });

                $body.append($item);
            });

            $panel.append($group);
        });

        // Topology stats footer
        const nodeCount = this.graph?.nodes?.size || 0;
        const edgeCount = this.graph?.edges?.size || 0;
        $panel.append(`
            <div style="margin-top:10px;padding:6px 8px;border-top:1px solid rgba(255,255,255,0.07);
                        font-size:10px;color:rgba(255,255,255,0.3);line-height:1.7;">
                <iconify-icon icon="material-symbols:schema-outline" style="font-size:11px;"></iconify-icon>
                Graph: ${nodeCount} nodes · ${edgeCount} edges ·
                ${this._quadTree ? '<span style="color:#34d399;">QuadTree active</span>' : 'QuadTree inactive'}
            </div>
        `);
    },

    // ── Flat DOM walk (delegated to Structure view) ─────────────
    // Kept as a stub so any external callers don't crash.
    _buildFlatLayerTree($panel, rootElements) {
        this._buildStructureView($panel, rootElements, 0);
    },

    selectLayer(element, $layerItem) {
        $('.layer-item.active').removeClass('active');
        $layerItem.addClass('active');
        $(element).removeClass('layer-hover-highlight');
        this.clearSelection();
        this.selectedElements = [element];
        $(element).addClass('component-highlight');
        this.showToast(`Selected: ${element.tagName}#${$(element).attr('id') || 'unnamed'}`, 'success');
    },

    startLayerRename(svgEl, $item, $nameSpan) {
        if ($item.find('.layer-name-input').length) return;

        // Pre-fill with the friendly display name (data-layer-name), falling back to id.
        const currentName = svgEl.getAttribute('data-layer-name') || svgEl.id || '';
        const currentId   = svgEl.id || '';

        const $input = $('<input type="text" class="layer-name-input">')
            .val(currentName)
            .attr('placeholder', 'layer name');

        $nameSpan.replaceWith($input);
        $input[0].focus();
        $input[0].select();

        const commit = () => {
            const raw = $input.val().trim() || currentName;

            // data-layer-name gets the raw user-typed string (special chars allowed).
            svgEl.setAttribute('data-layer-name', raw);

            // id gets a sanitized slug. Keep existing id if input is empty or identical.
            const newId = raw.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_\-:.]/g, '') || currentId;
            if (newId && newId !== currentId) svgEl.setAttribute('id', newId);
            $item.attr('data-element-id', newId || currentId);

            // Rebuild the panel so the new friendly name shows immediately,
            // without waiting for the MutationObserver debounce.
            this.buildLayersTree();
        };

        $input.on('blur', commit);
        $input.on('keydown', (e) => {
            if (e.key === 'Enter') { $input.trigger('blur'); }
            if (e.key === 'Escape') { $input.replaceWith($nameSpan); }
        });
    },

    // ── Timeline thumbnail filmstrip ──────────────────────────

    showTimeline() {
        $('#timelinePanel').toggleClass('open');
        if ($('#timelinePanel').hasClass('open')) this.buildTimeline();
    },

    buildTimeline() {
        const $tracks = $('#timelineTracks');
        $tracks.empty();

        this.displays.forEach((display, idx) => {
            const isActive = idx === this.activeDisplayIdx;

            // Build SVG thumbnail from stored content
            let thumbHtml = '<iconify-icon icon="material-symbols:description-outline" style="font-size:22px;opacity:0.4;"></iconify-icon>';
            try {
                const parser = new DOMParser();
                const svgDoc = parser.parseFromString(display.svgContent, 'image/svg+xml');
                const svgEl = svgDoc.querySelector('svg');
                if (svgEl) {
                    const vb = svgEl.getAttribute('viewBox') || '0 0 400 300';
                    thumbHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${svgEl.innerHTML}</svg>`;
                }
            } catch (_) { /* fallback icon */ }

            const shortName = display.name.length > 10
                ? display.name.slice(0, 9) + '…'
                : display.name;

            const $card = $(`
                <div class="timeline-card${isActive ? ' active' : ''}" data-idx="${idx}" title="${display.name}">
                    <div class="timeline-card-preview">${thumbHtml}</div>
                    <div class="timeline-card-name">${shortName}</div>
                    <button class="timeline-card-del" title="Remove">✕</button>
                </div>
            `);

            $card.on('mousedown', () => { this._panelOpenSnap = this.$sidePanel.hasClass('open'); });
            $card.on('click', e => {
                if (!$(e.target).closest('.timeline-card-del').length) {
                    this.switchDisplay(idx);
                }
            });

            $card.find('.timeline-card-del').on('click', e => {
                e.stopPropagation();
                this.removeDisplay(idx);
            });

            $tracks.append($card);
        });

        // Add (+) card at the end
        const $addCard = $(`
            <div class="timeline-card timeline-add-card" title="Add diagram">
                <div class="timeline-card-preview">
                    <iconify-icon icon="material-symbols:add" style="font-size:24px;opacity:0.5;"></iconify-icon>
                </div>
                <div class="timeline-card-name">Add</div>
            </div>
        `);
        $addCard.on('click', () => $('#hiddenFileInput').click());
        $tracks.append($addCard);
    },

    // ── Layer multi-select helpers ────────────────────────────

    _clearLayerSelection() {
        $('#layersPanel .layer-item, #layersPanel .topo-item').removeClass('layer-selected');
        this._layerSelectedItems = new Map();
    },

    // ── Merge selected layers into a single <g> group ─────────
    _mergeSelectedLayers() {
        if (!this._layerSelectedItems || this._layerSelectedItems.size < 2) {
            this.showToast('Select 2+ layers to merge (Shift+click)', 'error');
            return;
        }
        const els = [...this._layerSelectedItems.keys()].filter(el => el?.isConnected);
        if (els.length < 2) {
            this.showToast('Not enough connected layers to merge', 'error');
            return;
        }

        // Auto-name: "Group N" where N increments across the canvas
        if (!this._groupCounter) this._groupCounter = 0;
        const groupName = `Group ${++this._groupCounter}`;

        const before = this._captureFullState?.();
        const NS = this.SVG_NS;
        const g = document.createElementNS(NS, 'g');
        g.id = groupName.replace(/\s+/g, '-').toLowerCase();
        // Named group container — identified by data-layer-name; not wire-group/component-group
        g.setAttribute('data-layer-name', groupName);

        // Resolve containers (wire-group / component-group wrappers if present)
        const containers = els.map(el => el.closest?.('.wire-group, .component-group') || el);

        // Insert before the first container in document order
        const parent = containers[0].parentNode || this._contentRoot;
        const anchor = containers.reduce((first, c) =>
            first.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING ? c : first
        );
        parent.insertBefore(g, anchor);
        containers.forEach(c => g.appendChild(c));

        const after = this._captureFullState?.();
        this.pushHistory?.('Merge Layers', before, after);

        this._clearLayerSelection();
        this.wires      = (this.wires      || []).filter(w => w.element?.isConnected);
        this.components = (this.components || []).filter(c => c.element?.isConnected);
        this.connectors = (this.connectors || []).filter(c => c.element?.isConnected);
        this._scheduleGeoAnalysis?.();
        // Switch to Structure view — the new user group is only visible there,
        // not in Analysis view (which shows topology buckets, not user groups).
        this._layerPanelMode = 'structure';
        this.buildLayersTree();

        // Auto-trigger rename on the new group so user can name it immediately
        setTimeout(() => {
            const $groupItem = $(`#layersPanel [data-element-id="${g.id}"]`).first();
            if ($groupItem.length) {
                const $nameSpan = $groupItem.find('.layer-name').first();
                if ($nameSpan.length) this.startLayerRename(g, $groupItem, $nameSpan);
            }
        }, 80);

        this.showToast(`Merged ${els.length} layers into "${groupName}" — switched to Structure view`, 'success');
    },

    // ── Delete all currently selected layer items ─────────────
    _deleteSelectedLayerItems() {
        if (!this._layerSelectedItems || !this._layerSelectedItems.size) return;

        const els = [...this._layerSelectedItems.keys()].filter(el =>
            el?.isConnected &&
            el?.dataset?.locked !== 'true' &&
            el?.dataset?.seSystem !== 'true'
        );
        const skipped = this._layerSelectedItems.size - els.length;
        if (skipped) this.showToast(`${skipped} locked/system element(s) skipped`, 'error');
        if (!els.length) return;

        const before = this._captureFullState?.();
        els.forEach(el => {
            (el.closest?.('.wire-group, .component-group') || el).remove();
        });

        this._clearLayerSelection();
        this.wires      = (this.wires      || []).filter(w => w.element?.isConnected);
        this.components = (this.components || []).filter(c => c.element?.isConnected);
        this.connectors = (this.connectors || []).filter(c => c.element?.isConnected);
        this._scheduleGeoAnalysis?.();
        const after = this._captureFullState?.();
        this.pushHistory?.('Delete Layers', before, after);
        this.showToast(`Deleted ${els.length} layer${els.length > 1 ? 's' : ''}`, 'success');
    },

    // ── Right-click context menu for layer items ──────────────
    _showLayerContextMenu(x, y) {
        $('#layerCtxMenu').remove();
        const count = this._layerSelectedItems?.size || 0;

        // firstEl: the selected SVG element (may be a visual path inside a wire-group in Analysis view)
        const firstEl = this._layerSelectedItems?.keys().next().value || null;

        // firstContainer: the operative node for Z-order / delete — the wire-group or
        // component-group wrapper when in Analysis view, or firstEl itself in Structure view.
        const firstContainer = firstEl
            ? (firstEl.closest?.('.wire-group, .component-group') || firstEl)
            : null;

        // isUngrouppable: firstEl is itself a named <g> (Structure view), OR it lives
        // inside a named <g> user group (Analysis view — e.g. wire inside a merged group).
        const ownGroup = firstEl?.tagName?.toLowerCase() === 'g' && firstEl?.hasAttribute('data-layer-name');
        const ancestorGroup = !ownGroup ? (firstEl?.closest?.('[data-layer-name]') || null) : null;
        const isUngrouppable = count === 1 && (ownGroup || !!ancestorGroup);
        const groupToUngroup = ownGroup ? firstEl : ancestorGroup;

        const BTN = 'background:none;border:none;width:100%;text-align:left;padding:7px 14px;' +
                    'cursor:pointer;display:flex;align-items:center;gap:9px;font-size:12px;color:#e2e8f0;';
        const SEP = () => $('<hr>').css({ margin: '4px 0', border: 'none', borderTop: '1px solid rgba(255,255,255,0.07)' });
        const HDR = (label) => $(`<div style="padding:3px 14px;font-size:10px;opacity:0.4;letter-spacing:0.5px;text-transform:uppercase;">${label}</div>`);

        const mkItem = (label, icon, action, disabled = false) => {
            const $b = $(`<button style="${BTN}opacity:${disabled ? 0.35 : 1};pointer-events:${disabled ? 'none' : 'auto'};">
                <iconify-icon icon="${icon}" style="font-size:13px;flex-shrink:0;"></iconify-icon>
                <span>${label}</span>
            </button>`);
            if (!disabled) {
                $b.on('mouseenter', () => $b.css('background', 'rgba(79,172,254,0.15)'));
                $b.on('mouseleave', () => $b.css('background', ''));
                $b.on('click', () => { $('#layerCtxMenu').remove(); action(); });
            }
            return $b;
        };

        const $menu = $('<div id="layerCtxMenu">').css({
            position: 'fixed', zIndex: 9999,
            background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px', padding: '4px 0', minWidth: '190px',
            boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
        });

        $menu.append(mkItem(
            `Select in Canvas (${count})`,
            'material-symbols:touch-app-outline',
            () => {
                this.deselectAll?.();
                this._layerSelectedItems?.forEach((_, el) => this.selectEl?.(el, true));
            },
            count === 0
        ));

        $menu.append(SEP());

        $menu.append(mkItem(
            `Merge  (Alt+M)`,
            'material-symbols:merge-outline',
            () => this._mergeSelectedLayers(),
            count < 2
        ));

        // Ungroup: dissolve a named <g> container.
        // Works in both views: Structure (firstEl IS the group) and
        // Analysis (firstEl is inside a group — ungroupToUngroup is the ancestor).
        $menu.append(mkItem(
            'Ungroup',
            'material-symbols:grid-view-outline',
            () => {
                const el = groupToUngroup;
                const gname = el.getAttribute('data-layer-name') || el.id || 'group';
                const before = this._captureFullState?.();
                const parent = el.parentNode;
                Array.from(el.children).forEach(child => parent.insertBefore(child, el));
                el.remove();
                this.pushHistory?.('Ungroup', before, this._captureFullState?.());
                this.buildLayersTree();
                this.showToast(`Ungrouped "${gname}"`, 'success');
            },
            !isUngrouppable
        ));

        $menu.append(mkItem(
            `Delete  (${count})`,
            'material-symbols:delete-outline-rounded',
            () => this._deleteSelectedLayerItems(),
            count === 0
        ));

        // ── Z-order actions ───────────────────────────────────
        $menu.append(SEP());
        $menu.append(HDR('Z-order'));

        const doZOrder = (op) => {
            if (!firstContainer) return;
            const target = firstContainer;
            const parent = target.parentNode;
            if (!parent) return;
            const before = this._captureFullState?.();
            switch (op) {
                case 'front': parent.appendChild(target); break;
                case 'back':  parent.insertBefore(target, parent.firstElementChild); break;
                case 'up': {
                    const next = target.nextElementSibling;
                    if (next) parent.insertBefore(next, target);
                    break;
                }
                case 'down': {
                    const prev = target.previousElementSibling;
                    if (prev) parent.insertBefore(target, prev);
                    break;
                }
            }
            this.pushHistory?.(`Z-order: ${op}`, before, this._captureFullState?.());
            // Switch to Structure view — Z-order is a draw-order concept; only visible there.
            this._layerPanelMode = 'structure';
            this.buildLayersTree();
        };

        $menu.append(mkItem('Bring to Front', 'material-symbols:flip-to-front', () => doZOrder('front'), count !== 1));
        $menu.append(mkItem('Move Up',        'material-symbols:arrow-upward',  () => doZOrder('up'),    count !== 1));
        $menu.append(mkItem('Move Down',      'material-symbols:arrow-downward', () => doZOrder('down'), count !== 1));
        $menu.append(mkItem('Send to Back',   'material-symbols:flip-to-back',  () => doZOrder('back'),  count !== 1));

        $('body').append($menu);

        // Clamp to viewport
        const mw = $menu.outerWidth(true) || 190;
        const mh = $menu.outerHeight(true) || 160;
        $menu.css({
            left: Math.min(x, window.innerWidth  - mw - 8),
            top:  Math.min(y, window.innerHeight - mh - 8),
        });

        // Close on outside interaction
        setTimeout(() => {
            $(document).one('mousedown.layerCtx', (e) => {
                if (!$(e.target).closest('#layerCtxMenu').length) $('#layerCtxMenu').remove();
            });
        }, 0);
    },

    removeDisplay(idx) {
        this.displays.splice(idx, 1);

        if (!this.displays.length) {
            this.$svgDisplay.empty();
            this.wires = [];
            this.components = [];
            this.activeDisplayIdx = -1;
            this.buildTimeline();
            return;
        }

        this.switchDisplay(Math.min(idx, this.displays.length - 1));
    },
});
