/* ============================================================
   SVG Wiring Editor; UI Controls Feature
   Side panel, bottom controls, dark mode, export, toast,
   loading indicator, mini-map, measure tool
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Side Panel ───────────────────────────────────────────

    toggleSidePanel() {
        this.$sidePanel.toggleClass('open');
    },

    closeSidePanel() {
        this.$sidePanel.removeClass('open');
    },

    // ── Bottom Controls Toggle ───────────────────────────────

    toggleBottomControls() {
        this.$bottomControls.toggleClass('expanded');
    },

    // ── Canvas background colour ─────────────────────────────
    //
    //   Edits the fill of #_canvasBg, the page rect. Not a CSS/editor-chrome
    //   setting: the page is part of the document, so its colour is part of the
    //   document and travels with export, save and round-trip. Dark mode is the
    //   editor chrome; this is the paper.

    setCanvasBackground(color) {
        const bg = this.$svgDisplay?.[0]?.querySelector('#_canvasBg');
        if (!bg) {
            this.showToast('No canvas page — create one with New Canvas', 'error');
            return;
        }
        const before = this._captureFullState();
        if (color === 'none') {
            bg.setAttribute('fill', 'none');
            // The drop shadow traces the fill; on a transparent page it would
            // hang in space around nothing.
            bg.removeAttribute('filter');
        } else {
            bg.setAttribute('fill', color);
            bg.setAttribute('filter', 'url(#_pageShadow)');
        }
        this.pushHistory('Canvas Background', before, this._captureFullState());
        this._syncCanvasBgControls();
    },

    // Reflect the live page colour back into the picker + swatch row. Called on
    // load/switch too, so the control never lies about what the document says.
    _syncCanvasBgControls() {
        const bg = this.$svgDisplay?.[0]?.querySelector('#_canvasBg');
        const fill = bg?.getAttribute('fill') || '';
        if (/^#[0-9a-f]{6}$/i.test(fill)) $('#canvasBgColor').val(fill.toLowerCase());
        $('#canvasBgSwatches .canvas-bg-swatch').each((_, btn) => {
            $(btn).toggleClass('active',
                (btn.dataset.bg || '').toLowerCase() === fill.toLowerCase());
        });
    },

    bindCanvasBackgroundControls() {
        $('#canvasBgColor').on('input', (e) => this.setCanvasBackground(e.target.value));
        $(document).on('click', '.canvas-bg-swatch', (e) => {
            const c = e.currentTarget.dataset.bg;
            if (c) this.setCanvasBackground(c);
        });
    },

    // ── Dark Mode ────────────────────────────────────────────

    toggleDarkMode() {
        const isDark = $('body').toggleClass('dark-mode').hasClass('dark-mode');
        $('#darkModeBtn iconify-icon').attr('icon',
            isDark ? 'material-symbols:light-mode-outline' : 'material-symbols:dark-mode-outline'
        );
        this.showToast(isDark ? 'Dark mode' : 'Light mode', 'success');
    },

    // ── Export ───────────────────────────────────────────────

    _trackExport() {
        try {
            const n = parseInt(localStorage.getItem('schema_export_count') || '0', 10);
            localStorage.setItem('schema_export_count', String(n + 1));
        } catch (_) {}
    },

    _triggerDownload(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url  = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        this._trackExport();
    },

    exportCurrentView() {
        // Use clean serializer: content lifted out of _cameraRotGroup with originalViewBox,
        // so the exported file round-trips through _mountParsedSvg without data loss.
        const svgData = this._serializeCurrentDisplay();
        this._triggerDownload(svgData, 'wiring_diagram.svg', 'image/svg+xml;charset=utf-8');
        this.showToast('SVG exported', 'success');
    },

    exportAsHtml() {
        const svgData = new XMLSerializer().serializeToString(this.$svgDisplay[0]);
        const title = this.displays[this.activeDisplayIdx]?.name || 'Wiring Diagram';
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; background: #111; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
${svgData}
</body>
</html>`;
        const base = title.replace(/\.[^.]+$/, '');
        this._triggerDownload(html, `${base}.html`, 'text/html;charset=utf-8');
        this.showToast('HTML exported', 'success');
    },

    exportAsJson() {
        const diagram = this._buildDiagramPayload();
        const base = diagram.name.replace(/\.[^.]+$/, '');
        this._triggerDownload(JSON.stringify(diagram, null, 2), `${base}.json`, 'application/json');
        this.showToast('JSON exported', 'success');
    },

    // ── Walk _contentRoot for user-named <g> groups ─────────────
    _buildStructureGroups() {
        const groups = [];
        const root = this._contentRoot;
        if (!root) return groups;
        root.querySelectorAll('[data-layer-name]').forEach(g => {
            const children = [];
            g.querySelectorAll('[id]').forEach(el => { if (el.id) children.push(el.id); });
            groups.push({
                id:       g.id || null,
                name:     g.getAttribute('data-layer-name') || '',
                children,
            });
        });
        return groups;
    },

    // ── CWS Netlist IPC ──────────────────────────────────────

    buildNetlistJson() {
        const name = this.displays[this.activeDisplayIdx]?.name || 'diagram';

        const components = this.components.map(comp => {
            const el = comp.element || comp.$element?.[0];
            const labelEl = el?.querySelector?.('text.sym-value');
            const label = labelEl?.textContent || '';

            let x = 0, y = 0;
            const tfm = el?.getAttribute?.('transform') || '';
            const m = tfm.match(/translate\(\s*([\d.+-]+)[,\s]+([\d.+-]+)\s*\)/);
            if (m) { x = parseFloat(m[1]); y = parseFloat(m[2]); }

            const ports = this.graph?.nodes?.get(comp.id)?.ports || comp.ports || [];

            return {
                id:         comp.id || '',
                refdes:     label,
                value:      label,
                symbolType: el?.getAttribute?.('data-symbol') || comp.type || 'unknown',
                // The class the analysis settled on, plus who settled it. A
                // consumer downstream can now tell a recognized resistor from a
                // shape a human asserted was a component.
                geoClass:   el?.getAttribute?.('data-geo-class') || comp.type || null,
                provenance: window.GxSchemaTags?.provenanceOf?.(el) || null,
                domain:     el?.getAttribute?.('data-domain') || this.activeMode || '',
                x, y,
                ports: ports.map(p => ({ wireId: p.wireId || '', x: p.x || 0, y: p.y || 0 })),
                bbox: comp.bbox || {},
            };
        });

        const wireMap = new Map(this.wires.map(w => [w.id, w]));
        const connections = [...(this.graph?.edges?.values() || [])].map(edge => {
            const wire = wireMap.get(edge.id) || {};
            return {
                id:         edge.id || '',
                from:       edge.from || null,
                to:         edge.to   || null,
                color:      edge.color || wire.color || '',
                length:     edge.length ?? wire.length ?? 0,
                signalType: edge.signalType || null,
                linearity:  wire.linearity ?? null,
                endpoints:  wire.endpoints || [],
            };
        });

        return {
            schema:      'cws-netlist-v1',
            diagramName: name,
            exportedAt:  new Date().toISOString(),
            components,
            connections,
        };
    },

    // ── TAFNE Pipeline ───────────────────────────────────────────
    //
    //  Steps:
    //   0  Gather schema
    //   1  Check kernel heartbeat   (wake if sleeping)
    //   2  Probe TAFNE              (is table-formatter running?)
    //   3  Open TAFNE               (if not, ask kernel to launch it)
    //   4  Store data               (kernel pointer store)
    //   5  Deliver to TAFNE
    //
    // ── Build ginexys-diagram-v2 payload (export + IPC send) ─────
    // v2 adds: meta, structure.groups, wire.path, wire.layer,
    // component.layer, component.symbol, top-level connections[].
    // Grouped elements (inside a <g data-layer-name>) → type:"module".
    _buildDiagramPayload() {
        const name = this.displays[this.activeDisplayIdx]?.name || 'diagram';
        const svgEl = this.$svgDisplay[0];

        const meta = {
            viewBox:      this.originalViewBox || null,
            elementCount: svgEl ? svgEl.querySelectorAll('*').length : 0,
            analyzed:     !!(this.wires?.length || this.components?.length),
            exportedAt:   new Date().toISOString(),
        };

        const structure = { groups: this._buildStructureGroups() };

        // ── Components ────────────────────────────────────────────
        // Elements inside a user group (<g data-layer-name>) → type:"module"
        const components = (this.components || []).filter(c => c.element?.isConnected).map(c => {
            const el = c.element;
            const layerGroup = el?.closest?.('[data-layer-name]');
            const layer      = layerGroup
                ? (layerGroup.getAttribute('data-layer-name') || layerGroup.id || null)
                : null;
            const type   = layer ? 'module' : (c.type || 'component');
            const symbol = el?.getAttribute?.('data-symbol') || c.type || null;

            const labelEl = el?.querySelector?.('text.sym-value');
            const refdes  = labelEl?.textContent?.trim() || '';

            let x = 0, y = 0;
            const m = (el?.getAttribute?.('transform') || '').match(/translate\(\s*([\d.+-]+)[,\s]+([\d.+-]+)/);
            if (m) { x = parseFloat(m[1]); y = parseFloat(m[2]); }

            const ports = this.graph?.nodes?.get(c.id)?.ports || c.ports || [];

            return {
                id:     el?.id || c.id || null,
                type, symbol,
                refdes, value: refdes,
                domain: el?.getAttribute?.('data-domain') || this.activeMode || null,
                layer,
                x, y,
                ports:  ports.map(p => ({ wireId: p.wireId || '', x: p.x || 0, y: p.y || 0 })),
                bbox:   c.bbox || null,
            };
        });

        // ── Wires ─────────────────────────────────────────────────
        const wires = (this.wires || []).filter(w => w.element?.isConnected).map(w => {
            const el = w.element;
            const layerGroup = el?.closest?.('[data-layer-name]');
            const layer      = layerGroup
                ? (layerGroup.getAttribute('data-layer-name') || layerGroup.id || null)
                : null;
            // Use actual SVG path length (getTotalLength) for accuracy;
            // fall back to stored w.length if element is not in DOM.
            let length = w.length ?? null;
            try {
                if (el?.tagName?.toLowerCase() === 'path') {
                    const raw = el.getTotalLength();
                    length = (this._measureScaleFactor && this._measureUnit !== 'px')
                        ? parseFloat((raw * this._measureScaleFactor).toFixed(4))
                        : parseFloat(raw.toFixed(2));
                }
            } catch (_) {}
            return {
                id:        el?.id || w.id || null,
                color:     w.color     || null,
                width:     w.width     || null,
                length,
                linearity: w.linearity ?? null,
                path:      el?.getAttribute?.('d') || null,
                layer,
                endpoints: w.endpoints || [],
                bbox:      w.bbox      || null,
            };
        });

        // ── Connectors ────────────────────────────────────────────
        const connectors = (this.connectors || []).filter(c => c.element?.isConnected).map(c => ({
            id:   c.element?.id || c.id || null,
            bbox: c.bbox || null,
        }));

        // ── Connections (flattened graph edges) ────────────────────
        const wireMap = new Map((this.wires || []).map(w => [w.id, w]));
        const connections = [...(this.graph?.edges?.values() || [])].map(edge => {
            const wire = wireMap.get(edge.id) || {};
            return {
                id:         edge.id || '',
                from:       edge.from || null,
                to:         edge.to   || null,
                color:      edge.color || wire.color || null,
                length:     edge.length ?? wire.length ?? null,
                signalType: edge.signalType || null,
            };
        });

        return {
            schema: 'ginexys-diagram-v2',
            name,
            svg:    this._serializeCurrentDisplay(),
            meta,
            structure,
            topology: { components, wires, connectors, connections },
        };
    },

    async sendNetlistToTafne() {
        // ── Build diagram payload (ginexys-diagram-v2) ─────────
        const diagram = this._buildDiagramPayload();
        const { components, wires } = diagram.topology;
        if (!components.length && !wires.length) {
            this.showToast('No wiring data — run analysis first', 'error');
            return;
        }

        // ── Standalone (not inside OS shell) → download JSON ───
        if (!CwsBridge.isEmbedded) {
            const base = diagram.name.replace(/\.[^.]+$/, '');
            this._triggerDownload(JSON.stringify(diagram, null, 2),
                `${base}__diagram.json`, 'application/json');
            this.showToast('Saved diagram JSON (not in OS shell)', 'success');
            return;
        }

        // ── Open pipeline modal ────────────────────────────────
        const pipeline = this._openTafnePipeline();

        try {
            // ── Step 0: Schema gathered ────────────────────────
            pipeline.step(0, 'done',
                `${components.length} components · ${wires.length} wires`);

            // ── Step 1: Kernel heartbeat ───────────────────────
            pipeline.step(1, 'running', 'Checking…');
            if (!CwsBridge.isConnected) {
                pipeline.step(1, 'running', 'Kernel sleeping — waking…');
                try { window.parent.postMessage({ type: 'cws:ready' }, window.location.origin); } catch (_) {}
                const connected = await this._cwsWaitForConnection(8000);
                if (pipeline.cancelled) return;
                if (!connected) {
                    pipeline.step(1, 'error', 'Kernel offline');
                    pipeline.fail('Kernel did not respond. Make sure the Ginexys OS shell is open.');
                    return;
                }
            }
            pipeline.step(1, 'done', 'Connected');

            // ── Step 2: Probe TAFNE ────────────────────────────
            pipeline.step(2, 'running', 'Probing Table Formatter…');
            const tafneRunning = await this._cwsProbeTafne(3500);
            if (pipeline.cancelled) return;

            // ── Step 3: Open TAFNE if not running ─────────────
            if (tafneRunning) {
                pipeline.step(2, 'done', 'Already open');
                pipeline.step(3, 'skipped', 'Not needed');
            } else {
                pipeline.step(2, 'done', 'Not running');
                pipeline.step(3, 'running', 'Requesting kernel to open TAFNE…');
                CwsBridge.send('cws:tool:launch', { toolId: 'tifany', focusAfterLaunch: true }, 'os');
                const launched = await this._cwsWaitForToolLaunch('tifany', 12000);
                if (pipeline.cancelled) return;
                pipeline.step(3, launched ? 'done' : 'running',
                    launched ? 'TAFNE opened' : 'No ack — continuing anyway…');
            }

            // ── Step 4: Store diagram ──────────────────────────
            pipeline.step(4, 'running', 'Storing diagram…');
            const pointerId = await CwsBridge.requestStore(JSON.stringify(diagram), 'json-data');
            if (pipeline.cancelled) return;
            pipeline.step(4, 'done', `ID: ${pointerId.slice(0, 10)}…`);

            // ── Step 5: Deliver ────────────────────────────────
            pipeline.step(5, 'running', 'Delivering…');
            // Lineage assembly is an optional host-provided capability. When
            // window.GxProvenance is absent the send simply carries no lineage
            // and the tool works exactly as before.
            const fullLineage = window.GxProvenance
                ? window.GxProvenance.build('svg_wiring', CwsContracts.PROVENANCE_STAGES.ANALYSIS, {
                    source: diagram.name,
                    ops: ['place_component', 'connect', 'set_label'],
                    score: null,
                })
                : [];
            CwsBridge.offerData(CwsContracts.createEnvelope({
                pointer:     pointerId,
                contentType: 'json-data',
                metadata: {
                    source:         'schema-editor',
                    diagramName:    diagram.name,
                    componentCount: components.length,
                    wireCount:      wires.length,
                },
                hints: { suggestedTarget: 'tifany', action: 'load-diagram' },
                provenance: fullLineage,
            }));
            this._trackExport();
            pipeline.step(5, 'done',
                `${components.length} components · ${wires.length} wires → TAFNE`);
            pipeline.success(`Sent ${components.length} components and ${wires.length} wires`);

        } catch (err) {
            pipeline.fail(err.message || 'Unexpected error');
        }
    },

    // ── Pipeline modal factory ────────────────────────────────
    _openTafnePipeline() {
        $('#tafnePipelineModal').remove();

        const STEPS = [
            'Gather schema',
            'Check kernel heartbeat',
            'Probe Table Formatter',
            'Open Table Formatter',
            'Store data',
            'Deliver to TAFNE',
        ];

        const stepsHtml = STEPS.map((label, i) => `
            <div class="tafne-step" data-idx="${i}" data-state="pending">
                <div class="tafne-step-icon pending">○</div>
                <div class="tafne-step-text">
                    <span class="tafne-step-label">${label}</span>
                    <span class="tafne-step-detail"></span>
                </div>
            </div>`).join('');

        const $modal = $(`
            <div class="modal-backdrop open" id="tafnePipelineModal" role="dialog" aria-modal="true">
                <div class="modal tafne-pipeline-modal">
                    <h3 class="modal-title">
                        <iconify-icon icon="material-symbols:send-outline" style="font-size:16px;"></iconify-icon>
                        Send to TAFNE
                    </h3>
                    <div class="tafne-steps">${stepsHtml}</div>
                    <div class="tafne-pipeline-footer info" id="tafnePipelineFooter">Initializing…</div>
                    <div class="modal-actions">
                        <button class="btn btn-ghost" id="tafnePipelineCancel">Cancel</button>
                        <button class="btn btn-ghost" id="tafnePipelineClose" style="display:none;">Close</button>
                    </div>
                </div>
            </div>`);

        $('body').append($modal);

        // Set first step immediately to running
        this._tafnePipelineStep(0, 'running', 'Building…');

        let _cancelled = false;
        let _currentRunningStep = -1;
        $('#tafnePipelineCancel').on('click', () => {
            _cancelled = true;
            $modal.remove();
        });
        $('#tafnePipelineClose').on('click', () => $modal.remove());

        const self = this;
        return {
            get cancelled() { return _cancelled; },
            step(idx, state, detail) {
                if (state === 'running') _currentRunningStep = idx;
                else if (_currentRunningStep === idx) _currentRunningStep = -1;
                self._tafnePipelineStep(idx, state, detail);
            },
            success(msg) {
                $('#tafnePipelineFooter').text(`✓ ${msg}`).attr('class', 'tafne-pipeline-footer success');
                $('#tafnePipelineCancel').hide();
                $('#tafnePipelineClose').show();
                setTimeout(() => $modal.remove(), 3000);
            },
            fail(msg) {
                if (_currentRunningStep >= 0) {
                    self._tafnePipelineStep(_currentRunningStep, 'error', msg);
                    _currentRunningStep = -1;
                }
                $('#tafnePipelineFooter').text(`✗ ${msg}`).attr('class', 'tafne-pipeline-footer error');
                $('#tafnePipelineCancel').hide();
                $('#tafnePipelineClose').show();
            },
        };
    },

    _tafnePipelineStep(idx, state, detail) {
        const $step = $(`#tafnePipelineModal .tafne-step[data-idx="${idx}"]`);
        if (!$step.length) return;
        const ICONS = { pending: '○', running: '', done: '✓', error: '✗', skipped: '–' };
        $step.attr('data-state', state);
        $step.find('.tafne-step-icon')
            .attr('class', `tafne-step-icon ${state}`)
            .text(ICONS[state] ?? '○');
        if (detail != null) $step.find('.tafne-step-detail').text(detail);
    },

    // ── CWS helpers ───────────────────────────────────────────

    _cwsWaitForConnection(timeout) {
        return new Promise(resolve => {
            if (CwsBridge.isConnected) { resolve(true); return; }
            const deadline = Date.now() + timeout;
            const timer = setInterval(() => {
                if (CwsBridge.isConnected) { clearInterval(timer); resolve(true); }
                else if (Date.now() >= deadline) { clearInterval(timer); resolve(false); }
            }, 250);
        });
    },

    // Sends cws:tool:probe to the kernel and waits for cws:tool:probe-result.
    // If kernel does not support the message type, resolves false after timeout.
    _cwsProbeTafne(timeout) {
        return new Promise(resolve => {
            let resolved = false;
            const probeId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `probe_${Date.now()}`;

            const handler = (e) => {
                if (e.data?.type === 'cws:tool:probe-result' &&
                    e.data?.payload?.probeId === probeId) {
                    if (!resolved) {
                        resolved = true;
                        window.removeEventListener('message', handler);
                        resolve(e.data.payload.running === true);
                    }
                }
            };
            window.addEventListener('message', handler);
            CwsBridge.send('cws:tool:probe', { toolId: 'tifany', probeId }, 'os');

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    window.removeEventListener('message', handler);
                    resolve(false);
                }
            }, timeout);
        });
    },

    // Waits for a cws:tool:launch-ack from the kernel confirming the tool opened.
    _cwsWaitForToolLaunch(toolId, timeout) {
        return new Promise(resolve => {
            let resolved = false;
            const handler = (e) => {
                if ((e.data?.type === 'cws:tool:launch-ack' ||
                     e.data?.type === 'cws:lifecycle:registered') &&
                    (e.data?.payload?.toolId === toolId || !e.data?.payload?.toolId)) {
                    if (!resolved) {
                        resolved = true;
                        window.removeEventListener('message', handler);
                        resolve(true);
                    }
                }
            };
            window.addEventListener('message', handler);
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    window.removeEventListener('message', handler);
                    resolve(false);
                }
            }, timeout);
        });
    },

    // Generic tables → TAFNE send. tables = [{ name, rows: [{...}], candidate? }]
    // (flat rows-of-objects — the shape buildBom/ERC findings already produce).
    // Reuses the netlist pipeline's probe/launch plumbing; standalone → JSON download.
    // Sent through window.GxTables (root-injected, private — see assets/os/tables.js)
    // when present, which is what carries `candidate:false` correctly: a BOM or an
    // ERC finding is schema's OWN computed data, not an extracted guess, and the
    // pre-2026-08-14e wire format (gx-tables-v1) had no field for that distinction
    // at all. Falls back to the legacy flat envelope for a forked standalone tool,
    // which never gets tables.js injected — same degrade-gracefully pattern as
    // every other GxThing guard in this file.
    async sendTablesToTafne(tables, title = 'tables') {
        if (!tables?.length || !tables.some(t => t.rows?.length)) {
            this.showToast('Nothing to send', 'error');
            return;
        }
        const payload = window.GxTables
            ? window.GxTables.createEnvelope({
                source: 'schema-editor', title,
                tables: tables.map(t => {
                    const rows = t.rows || [];
                    const headerKeys = rows.length ? Object.keys(rows[0]) : [];
                    const grid = headerKeys.length
                        ? [headerKeys.map(k => window.GxTables.cell(k, { header: true }))]
                        : [];
                    rows.forEach(r => grid.push(headerKeys.map(k => window.GxTables.cell(r[k]))));
                    return window.GxTables.createTable({
                        name: t.name || null, rows: grid,
                        candidate: typeof t.candidate === 'boolean' ? t.candidate : false,
                        // Explicitly null, not omitted: a BOM or a findings table
                        // is computed here, so there is no upstream page/region
                        // to send an edit back to. Leaving the field out would be
                        // indistinguishable from forgetting to set it, which is
                        // how the PDF send path lost its return address.
                        origin: t.origin || null,
                    });
                }),
            })
            : { schema: 'gx-tables-v1', tables, meta: { source: 'schema-editor', title } };

        if (!CwsBridge.isEmbedded) {
            this._triggerDownload(JSON.stringify(payload, null, 2),
                `${title}.json`, 'application/json');
            this.showToast('Saved JSON (not in OS shell)', 'success');
            return;
        }
        try {
            const running = await this._cwsProbeTafne(3500);
            if (!running) {
                CwsBridge.send('cws:tool:launch', { toolId: 'tifany', focusAfterLaunch: true }, 'os');
                await this._cwsWaitForToolLaunch('tifany', 12000);
            }
            const pointerId = await CwsBridge.requestStore(JSON.stringify(payload), 'json-data');
            CwsBridge.offerData(CwsContracts.createEnvelope({
                pointer: pointerId,
                contentType: 'json-data',
                metadata: { source: 'schema-editor', title, tableCount: tables.length },
                hints: { suggestedTarget: 'tifany', action: 'load-tables' },
            }));
            this.showToast(`Sent ${tables.length} table${tables.length > 1 ? 's' : ''} to TAFNE`, 'success');
        } catch (err) {
            this.showToast(`Send failed: ${err.message || err}`, 'error');
        }
    },

    // CWS inbound: svg-vector envelope (e.g. pdf-processor's CTM-resolved vector
    // extraction). Fetch, validate, mount through the normal import path so the
    // geometry pipeline (classify → topology → nets) runs on it.
    async receiveSvgVector(envelope) {
        let svg;
        try {
            svg = envelope.pointer
                ? await CwsBridge.getStore(envelope.pointer)
                : envelope.inline;
        } catch (e) {
            this.showToast('Vector import: could not fetch data', 'error');
            return;
        }
        const validate = window.CwsContracts?.VALIDATORS?.['svg-vector'];
        if (validate && !validate(svg)) {
            this.showToast('Vector import: invalid SVG payload', 'error');
            return;
        }
        this._mountParsedSvg(svg, `Imported: ${envelope.metadata?.name || 'vector document'}`);
    },

    /**
     * Incoming images/figures from another tool — one ARTBOARD each.
     *
     * The artboard list (`displays`) is the editor's native way of holding
     * several loaded drawings side by side, which is exactly what a multi-image
     * handoff is. Mounting them into the current canvas instead (what a single
     * merged svg-vector payload forces) piles unrelated artwork on top of
     * whatever was already there and throws away which page each piece came
     * from. Each item keeps its `origin`, so a figure stays traceable to the
     * page and region it was extracted from.
     */
    async receiveVectorArtifacts(envelope) {
        let raw;
        try {
            raw = envelope.pointer ? await CwsBridge.getStore(envelope.pointer) : envelope.inline;
        } catch (e) {
            this.showToast('Artifact import: could not fetch data', 'error');
            return;
        }
        let data;
        try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch (e) { this.showToast('Artifact import: invalid JSON', 'error'); return; }

        const items = (data && data.schema === 'gx-artifacts/1' && Array.isArray(data.items))
            ? data.items.filter(it => it && (it.raster || it.scene || typeof it.svg === 'string'))
            : [];
        if (!items.length) {
            this.showToast('Artifact import: no usable items', 'error');
            return;
        }

        const built = [];
        let rejected = 0;
        for (const it of items) {
            const svg = this._artifactToSvg(it);
            if (svg) built.push({ it, svg }); else rejected++;
        }
        if (!built.length) {
            this.showToast('Artifact import: nothing could be rendered', 'error');
            return;
        }

        const firstNewIdx = this.displays.length;
        built.forEach(({ it, svg }, i) => {
            this.displays.push({
                id: `disp_gx_${Date.now()}_${i}`,
                analyzed: false,
                snapshot: null,
                name: it.name || `Artifact ${firstNewIdx + i + 1}`,
                svgContent: svg,
                origin: it.origin || null,
                // Kept so a later send-back knows what arrived vs what was drawn.
                sourceScene: it.scene || null,
            });
        });
        this.switchDisplay(firstNewIdx);

        const vec = built.filter(b => b.it.scene?.nodes?.length).length;
        this.showToast(
            `${built.length} artboard${built.length !== 1 ? 's' : ''} added` +
            (vec ? ` · ${vec} with editable geometry` : ' · reference only') +
            (rejected ? ` (${rejected} skipped)` : ''),
            'success');
    },

    /**
     * Compose one artifact into a single SVG document: the rasterised crop as a
     * locked backdrop, the Scene's geometry as real, editable elements on top.
     *
     * The backdrop is deliberately inert — `data-se-system` keeps it out of the
     * artifacts index, `pointer-events:none` keeps it from swallowing clicks
     * meant for the geometry, and it is never analyzed (the geometry engine has
     * no reader for <image> and would drop it anyway).
     *
     * Keeping both layers is the point: the vectors are what you can edit, the
     * raster is what the page actually looked like. Anything the segment pass
     * missed shows up as a visible gap between them rather than as a number in
     * `meta.coverage` that nobody reads.
     */
    _artifactToSvg(it) {
        // Legacy single-SVG item (pre-Scene senders).
        if (!it.raster && !it.scene && typeof it.svg === 'string') {
            const v = window.CwsContracts?.VALIDATORS?.['svg-vector'];
            return (!v || v(it.svg)) ? it.svg : null;
        }

        const scene = it.scene || null;
        if (scene && window.GxScene) {
            const errs = window.GxScene.validate(scene);
            if (errs.length) {
                console.warn('[schema] rejecting malformed Scene:', errs[0]);
                return null;
            }
        }
        // One renderer, shared with the PDF tool via GxScene.toSvg — mounting a
        // Scene here and embedding the same Scene there must produce identical
        // pixels, or every approved round trip would visibly redraw the figure.
        if (!scene && !it.raster) return null;
        if (window.GxScene) {
            return window.GxScene.toSvg(scene || { width: it.width, height: it.height, nodes: [] },
                { backdrop: it.raster || null });
        }
        // No GxScene injected (forked standalone): a raster-only underlay is
        // still honest — it just is not editable, which is what it looks like.
        if (!it.raster) return null;
        const w = Math.round(it.width || 200), h = Math.round(it.height || 200);
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
            `<image href="${this._escHtml(it.raster)}" x="0" y="0" width="${w}" height="${h}" ` +
            `data-gx-underlay="true" data-se-system="true" style="pointer-events:none" preserveAspectRatio="none" /></svg>`;
    },

    /**
     * Serialize the CURRENT artboard geometry back into a Scene.
     *
     * Nodes that arrived from upstream keep their `data-gx-node` id, so a diff
     * can tell "this stroke moved" from "this stroke was deleted and another
     * drawn". Anything the user drew here has no such attribute and becomes a
     * new node at origin 'declared' — the highest-confidence origin there is,
     * because a human put it there deliberately.
     *
     * Coordinates are resolved through `_elWorldMatrix`. Moves, scales and
     * rotations in this editor are applied as element TRANSFORMS rather than by
     * rewriting x1/y1, so reading raw attributes would report every edited
     * stroke at its original position — the annotation would land back in the
     * PDF exactly where the user dragged it away from.
     */
    _canvasToScene() {
        const root = this._contentRoot;
        if (!root || !window.GxScene) return null;

        const nodes = [];
        let newCount = 0;
        const px = (m, x, y) => {
            const p = new DOMPoint(x, y).matrixTransform(m);
            return { x: p.x, y: p.y };
        };

        root.querySelectorAll('line, rect, ellipse, circle, path, polyline, polygon, text').forEach((el) => {
            // Skip everything that is not user content: the raster backdrop, the
            // page rect, grid, interaction hitboxes and transient handles.
            if (el.dataset.seSystem === 'true' || el.closest('[data-se-system="true"]')) return;
            if (el.id === '_canvasBg' || el.closest('#_gridLayer')) return;
            if (el.classList.contains('wire-hitbox') || el.classList.contains('component-hitbox')) return;
            if (el.closest('.selection-handle-group')) return;

            const tag = el.tagName.toLowerCase();
            const m = this._elWorldMatrix(el);
            const declaredId = el.getAttribute('data-gx-node');
            const id = declaredId || `add_${++newCount}`;
            const base = {
                id,
                origin: declaredId ? 'primitive' : 'declared',
                confidence: 1,
                role: el.getAttribute('data-gx-role') || el.getAttribute('data-geo-class') || undefined,
                stroke: el.getAttribute('stroke') || '#111827',
                strokeWidth: parseFloat(el.getAttribute('stroke-width')) || 1,
                fill: el.getAttribute('fill') || 'none',
            };

            if (tag === 'line') {
                const a = px(m, +el.getAttribute('x1') || 0, +el.getAttribute('y1') || 0);
                const b = px(m, +el.getAttribute('x2') || 0, +el.getAttribute('y2') || 0);
                nodes.push({ ...base, kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
            } else if (tag === 'rect') {
                const a = px(m, +el.getAttribute('x') || 0, +el.getAttribute('y') || 0);
                const b = px(m, (+el.getAttribute('x') || 0) + (+el.getAttribute('width') || 0),
                    (+el.getAttribute('y') || 0) + (+el.getAttribute('height') || 0));
                nodes.push({ ...base, kind: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                    w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
                    rx: parseFloat(el.getAttribute('rx')) || 0 });
            } else if (tag === 'circle' || tag === 'ellipse') {
                const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0;
                const rx = tag === 'circle' ? (+el.getAttribute('r') || 0) : (+el.getAttribute('rx') || 0);
                const ry = tag === 'circle' ? (+el.getAttribute('r') || 0) : (+el.getAttribute('ry') || 0);
                const c = px(m, cx, cy), e = px(m, cx + rx, cy + ry);
                nodes.push({ ...base, kind: 'ellipse', cx: c.x, cy: c.y,
                    rx: Math.abs(e.x - c.x), ry: Math.abs(e.y - c.y) });
            } else if (tag === 'text') {
                const a = px(m, +el.getAttribute('x') || 0, +el.getAttribute('y') || 0);
                nodes.push({ ...base, kind: 'text', x: a.x, y: a.y,
                    text: el.textContent || '', fontSize: parseFloat(el.getAttribute('font-size')) || 12,
                    fill: el.getAttribute('fill') || '#111827' });
            } else {
                // path / polyline / polygon: keep the geometry verbatim and carry
                // any transform on the element, rather than re-fitting the curve
                // and quietly changing the shape on every round trip.
                const d = tag === 'path' ? el.getAttribute('d')
                    : this._pointsToPathD(el.getAttribute('points'), tag === 'polygon');
                if (!d) return;
                const t = el.getAttribute('transform');
                nodes.push({ ...base, kind: 'path', d, transform: t || undefined });
            }
        });

        const d = this.displays[this.activeDisplayIdx];
        const src = d?.sourceScene;
        return window.GxScene.create({
            width: src?.width || this._sceneWidthFallback() || 0,
            height: src?.height || this._sceneHeightFallback() || 0,
            producer: 'svg_wiring', detector: 'declared', nodes,
        });
    },

    /**
     * Send the active artboard's edits back to the tool the figure came from.
     *
     * Only meaningful for an artboard that arrived with an origin AND the Scene
     * it arrived as — the diff is computed against that basis, so without it
     * there is nothing to compare and every stroke would read as "added".
     * Refusing is the honest outcome; shipping a diff against nothing is not.
     */
    async sendFigureBackAnnotation() {
        const d = this.displays[this.activeDisplayIdx];
        if (!d) { this.showToast('No active artboard', 'error'); return; }
        if (!d.origin || d.origin.page == null || d.origin.regionId == null) {
            this.showToast('This artboard has no source region to send back to', 'error');
            return;
        }
        if (!window.CwsBridge?.isEmbedded || !window.CwsContracts || !window.GxScene) {
            this.showToast('Not embedded in the OS shell — cannot send', 'error');
            return;
        }

        const after = this._canvasToScene();
        if (!after) { this.showToast('Could not read the canvas geometry', 'error'); return; }
        const before = d.sourceScene || null;
        const delta = window.GxScene.diff(before, after);
        if (!delta.total) {
            this.showToast('Nothing changed on this artboard', 'success');
            return;
        }

        try {
            const C = window.CwsContracts;
            const target = d.origin.tool === 'pdf-processor' ? 'pdf_processor' : d.origin.tool;
            window.CwsBridge.send('cws:tool:launch', { toolId: target, focusAfterLaunch: true }, 'os');
            const provenance = window.GxProvenance
                ? window.GxProvenance.build('svg_wiring', C.PROVENANCE_STAGES.ANALYSIS, {
                    source: d.name, ops: ['edit', 'back-annotate'], score: null,
                })
                : [];
            const payload = {
                schema: 'gx-figure-annotation/1',
                origin: d.origin,
                scene: after,
                // The basis travels too, so the receiver diffs against exactly
                // what it sent rather than re-deriving it and risking a
                // different answer from a re-extraction in between.
                basis: before,
                summary: { added: delta.added.length, removed: delta.removed.length, moved: delta.moved.length },
            };
            const pointer = await window.CwsBridge.requestStore(JSON.stringify(payload), 'json-data');
            window.CwsBridge.offerData(C.createEnvelope({
                pointer, contentType: 'json-data',
                metadata: { source: 'svg_wiring', title: d.name },
                hints: { suggestedTarget: target, action: 'back-annotate-figure' },
                provenance,
            }));
            this.showToast(
                `Sent for review: ${delta.added.length} added, ${delta.removed.length} removed, ${delta.moved.length} moved`,
                'success');
        } catch (err) {
            this.showToast(`Send failed: ${err.message || err}`, 'error');
        }
    },

    /** polyline/polygon `points` → an equivalent path `d`, so Scene needs no extra kind. */
    _pointsToPathD(points, close) {
        const nums = (points || '').trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
        if (nums.length < 4) return null;
        let d = `M ${nums[0]} ${nums[1]}`;
        for (let i = 2; i < nums.length - 1; i += 2) d += ` L ${nums[i]} ${nums[i + 1]}`;
        return close ? d + ' Z' : d;
    },

    _sceneWidthFallback() {
        const vb = (this._pageViewBox?.() || this.originalViewBox || '').split(/[\s,]+/);
        return vb.length === 4 ? +vb[2] : 0;
    },
    _sceneHeightFallback() {
        const vb = (this._pageViewBox?.() || this.originalViewBox || '').split(/[\s,]+/);
        return vb.length === 4 ? +vb[3] : 0;
    },

    // Incoming table (BOM/sheet) from TAFNE or another tool's Send. Schema has
    // no generic "insert an arbitrary table onto the canvas" primitive — that's
    // a real feature, not a wiring fix — so this is deliberately a READ-ONLY
    // preview: honest about landing, honest about not being inserted, instead
    // of the previous behaviour (the message arrived and vanished with no
    // receiver at all).
    async receiveTableArtifact(envelope) {
        let raw;
        try {
            raw = envelope.pointer ? await CwsBridge.getStore(envelope.pointer) : envelope.inline;
        } catch (e) {
            this.showToast('Table import: could not fetch data', 'error');
            return;
        }
        let data;
        try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch (e) { this.showToast('Table import: invalid JSON', 'error'); return; }

        const known = data?.schema === 'gx-tables-v1' ||
            (!!window.GxTables && data?.schema === window.GxTables.SCHEMA);
        const tables = known ? (data.tables || []) : [];
        if (!tables.length) {
            this.showToast('Table import: no tables in payload', 'error');
            return;
        }
        this._openTablePreviewModal(tables, envelope.metadata?.source || 'unknown');
    },

    _escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    _openTablePreviewModal(tables, source) {
        $('#tablePreviewModal').remove();
        const esc = this._escHtml;
        // One <details> per table. A received batch is often a dozen sheets of
        // 30 rows; rendering them all expanded pushed the modal past the
        // viewport and the actions off-screen, so the only visible control was
        // whatever happened to fit. Accordion + a scroll box per table keeps
        // the buttons reachable no matter what arrives. First table open so the
        // common single-table case still reads at a glance.
        const sectionsHtml = tables.map((t, i) => {
            const rows = t.rows || [];
            const cols = (rows[0] || []).length;
            const rowsHtml = rows.slice(0, 30).map(row => `<tr>${row.map(c => {
                const cell = c && typeof c === 'object' ? c : { text: c };
                const tag = cell.header ? 'th' : 'td';
                const span = cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '';
                return `<${tag}${span}>${esc(String(cell.text ?? ''))}</${tag}>`;
            }).join('')}</tr>`).join('');
            return `
                <details class="ba-section tbl-acc"${i === 0 ? ' open' : ''}>
                    <summary class="ba-section-hdr safe tbl-acc-hdr">
                        <span class="tbl-acc-name">${esc(t.name || 'Table')}</span>
                        <span class="tbl-acc-meta">${rows.length} row${rows.length !== 1 ? 's' : ''}${cols ? ` · ${cols} col${cols !== 1 ? 's' : ''}` : ''}</span>
                    </summary>
                    <div class="tbl-scroll">
                        <table class="tbl-preview">${rowsHtml}</table>
                    </div>
                    ${rows.length > 30 ? `<div class="ba-empty">…${rows.length - 30} more rows not shown</div>` : ''}
                </details>`;
        }).join('');

        // One road, three meanings. The transport is identical for every domain
        // — a gx-tables envelope — and only the INTERPRETATION differs, so the
        // route is chosen from the canvas's active domain rather than from a
        // single hardcoded handler. Previously this always offered "Insert as
        // entity", which is the software reading of a table, even on an
        // electrical or construction canvas.
        const route = this._tableRouteForDomain(tables);
        const $modal = $(`
            <div class="modal-backdrop open" id="tablePreviewModal" role="dialog" aria-modal="true">
                <div class="modal ba-modal tbl-modal">
                    <h3 class="modal-title">
                        <iconify-icon icon="material-symbols:table-chart-outline" style="font-size:16px;"></iconify-icon>
                        Received from ${esc(source)}
                    </h3>
                    <p class="ba-summary">${tables.length} table${tables.length !== 1 ? 's' : ''} — ${esc(route.summary)}</p>
                    <div class="tbl-body">${sectionsHtml}</div>
                    <div class="modal-actions">
                        ${route.run ? `<button class="btn btn-primary" id="tblPromoteBtn">${esc(route.label)}</button>` : ''}
                        <button class="btn btn-ghost" id="tblDismissBtn">Dismiss</button>
                    </div>
                </div>
            </div>`);
        $('body').append($modal);
        $('#tblDismissBtn').on('click', () => $modal.remove());
        if (route.run) {
            $('#tblPromoteBtn').on('click', () => route.run.call(this, tables, source, $modal));
        }
        this.showToast(`Received ${tables.length} table${tables.length !== 1 ? 's' : ''} from ${source}`, 'success');
    },

    /**
     * What an incoming table MEANS on this canvas.
     *
     * Each domain models a different thing, so the same rows land differently:
     * software reads them as entities and columns, electrical as a component
     * list to reconcile against the schematic, construction as a quantity
     * takeoff. The envelope, the address, and the approve-before-apply modal
     * are shared; only this table changes.
     *
     * A domain with no model yet returns `run: null` and SAYS so. That is the
     * honest state — a preview with no insert button is a missing feature the
     * user can see, whereas offering the software button on a construction
     * canvas would insert the wrong kind of object and look like a bug.
     */
    _tableRouteForDomain(tables) {
        const mode = this.activeMode || 'general';

        // `general` is the default nobody has changed yet, not a domain with its
        // own reading of a table — and it is the mode the editor boots into, so
        // it is what a table sent from TAFNE lands in unless the user happened
        // to pick Software first. Refusing there produced the reported dead end:
        // "reference only, not inserted onto the canvas", with no hint that the
        // feature exists one pill away. A table's structural reading IS the
        // software one, so general borrows it and says that it is switching.
        if (mode === 'software' || mode === 'general') {
            if (!window.GxSchemaPromote || !window.GxSpe) {
                return { run: null, summary: 'reference only — the schema model is not loaded' };
            }
            const switching = mode === 'general';
            return {
                label: switching ? 'Insert as entity (Software)' : 'Insert as entity',
                summary: switching
                    ? 'promote and insert as ERD entities — this switches the canvas to Software'
                    : 'promote and insert as ERD entities, or dismiss',
                run(tbls, source, $modal) {
                    // Switch BEFORE inserting so the software kit and its
                    // palette are active for the symbols about to be placed.
                    if (switching && typeof this.switchMode === 'function') this.switchMode('software');
                    this._insertTablesAsEntities(tbls, source, $modal);
                },
            };
        }

        if (mode === 'electrical') {
            // The netlist path is KEPT rather than replaced by a generic table
            // insert: a component list carries refdes/value/symbolType semantics
            // that a flat grid insert would throw away, and reconciling it
            // against the existing schematic is the whole point of sending it.
            if (!this._tablesLookLikeComponents(tables)) {
                return { run: null, summary: 'reference only — no component columns (refdes / value / type) found' };
            }
            return {
                label: 'Reconcile with schematic',
                summary: 'compare against the components on this canvas, or dismiss',
                run: this._backAnnotateFromTables,
            };
        }

        if (mode === 'construction') {
            return { run: null, summary: 'reference only — the quantity-takeoff model is not built yet' };
        }

        return { run: null, summary: 'reference only, not inserted onto the canvas' };
    },

    /** Rows of a table as objects keyed by its header row — both wire shapes. */
    _tableToObjects(table) {
        const rows = table?.rows || [];
        if (!rows.length) return [];
        // gx-tables-v1 rows are already objects keyed by header.
        if (!Array.isArray(rows[0])) return rows.filter(r => r && typeof r === 'object');

        const cellText = (c) => String((c && typeof c === 'object' ? c.text : c) ?? '').trim();
        // The header row is the one MARKED as header, not simply the first row —
        // a table can arrive with a caption or a blank lead row above it.
        const headerIdx = rows.findIndex(r => r.some(c => c && typeof c === 'object' && c.header));
        const hi = headerIdx >= 0 ? headerIdx : 0;
        const headers = rows[hi].map((c, j) => cellText(c) || `col_${j + 1}`);
        return rows.slice(hi + 1).map(r => {
            const o = {};
            headers.forEach((h, j) => { o[h] = cellText(r[j]); });
            return o;
        });
    },

    // Header synonyms, declared rather than inferred, so the match is auditable
    // by reading this list — the same discipline the promotion ladder uses.
    _COMPONENT_FIELD_SYNONYMS: {
        id:         ['id', 'component id', 'componentid', 'uid'],
        refdes:     ['refdes', 'ref', 'reference', 'designator', 'ref des', 'label'],
        value:      ['value', 'val', 'rating'],
        symbolType: ['symboltype', 'symbol type', 'type', 'symbol', 'part', 'device'],
    },

    _componentFieldOf(header) {
        const h = String(header || '').trim().toLowerCase();
        for (const [field, names] of Object.entries(this._COMPONENT_FIELD_SYNONYMS)) {
            if (names.includes(h)) return field;
        }
        return null;
    },

    _tablesLookLikeComponents(tables) {
        return (tables || []).some(t => {
            const objs = this._tableToObjects(t);
            if (!objs.length) return false;
            const fields = new Set(Object.keys(objs[0]).map(h => this._componentFieldOf(h)).filter(Boolean));
            // refdes or id is the minimum: without something to MATCH on, every
            // incoming row would read as "added" and the diff would be noise.
            return (fields.has('refdes') || fields.has('id')) && fields.size >= 2;
        });
    },

    /**
     * Electrical: an incoming table becomes a component list and goes through
     * the SAME diff + approve modal as the netlist back-annotation, instead of
     * a second review path that could disagree with it.
     */
    _backAnnotateFromTables(tables, source, $modal) {
        const components = [];
        for (const t of tables || []) {
            for (const o of this._tableToObjects(t)) {
                const c = {};
                for (const [h, v] of Object.entries(o)) {
                    const field = this._componentFieldOf(h);
                    if (field) c[field] = v;
                }
                if (!c.id && !c.refdes) continue;   // nothing to match on
                c.id = c.id || '';
                components.push(c);
            }
        }
        if (!components.length) {
            this.showToast('No component rows found in the received tables', 'error');
            return;
        }
        const diff = this._diffNetlists({ components, connections: [] }, this.buildNetlistJson());
        if ($modal) $modal.remove();
        if (!diff.safe.length && !diff.review.length) {
            this.showToast('No differences from the current schematic', 'success');
            return;
        }
        this._openBackAnnotateModal(diff);
    },

    // GxSchema promote → SPE generate → canvas. Runs the §5 ladder on the
    // batch so rungs 4-6 (pk/fk/cardinality) actually fire, then places one
    // ENTITY per sheet at a cascading offset. Private orchestration: the
    // engine only knows how to draw what the portfolio tells it to draw.
    _insertTablesAsEntities(tables, source, $modal) {
        try {
            const batch = window.GxSchemaPromote.promoteBatch(
                tables.map((t) => ({
                    id: t.id || t.name, name: t.name || t.label,
                    headerRow: t.headerRow, rows: t.rows || [],
                    // The address rides along so the promoted columns can be
                    // pointed back at the cell they came from. It cannot be
                    // reconstructed after promotion — this is the only moment
                    // it is available.
                    origin: t.origin || null,
                }))
            );
            if (!(batch.entities || []).length) {
                this.showToast('Promotion produced no entities', 'error');
                return;
            }
            this._insertModelEntities(batch.model || batch, source);
            $modal.remove();
        } catch (e) {
            this.showToast('Insert failed: ' + (e && e.message), 'error');
        }
    },

    // Place a GxSchema model on the canvas: one generated ENTITY per entity,
    // one wire per fk relation, one undo step, and the model retained as the
    // source of truth. Shared by promotion (TAFNE) and Mermaid import, so the
    // two paths cannot drift into placing entities differently.
    /**
     * A pipeline graph from TAFNE — `gx-pipeline/1`.
     *
     * The rows a pipeline computed carry its RESULT; the node configs carry its
     * EVIDENCE. A vlookup's `{keyPort, refNodeId, refKeyPort}` is a foreign key
     * a human declared, and arriving that way it is promoted at `inferred:false`
     * instead of being re-guessed from a column name at 0.85.
     *
     * The refusals are shown, not swallowed: a `lateral` join has no recoverable
     * structure and says so, and a filter whose terminal disposition the
     * pipeline never declared becomes a QUESTION rather than a `CHECK` constraint
     * that would permanently reject rows the user only meant to hide in a report.
     */
    async receivePipelineArtifact(envelope) {
        let raw;
        try {
            raw = envelope.pointer ? await CwsBridge.getStore(envelope.pointer) : envelope.inline;
        } catch (e) {
            this.showToast('Pipeline import: could not fetch data', 'error');
            return;
        }
        let data;
        try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch (e) { this.showToast('Pipeline import: invalid JSON', 'error'); return; }

        if (!window.GxSchemaPromote || !window.GxSpe) {
            this.showToast('Pipeline import: the schema model is not loaded', 'error');
            return;
        }
        if (data?.schema !== 'gx-pipeline/1') {
            this.showToast('Pipeline import: unrecognised payload', 'error');
            return;
        }

        let batch;
        try {
            batch = window.GxSchemaPromote.promotePipeline(data, {});
        } catch (e) {
            this.showToast('Pipeline import failed: ' + (e && e.message), 'error');
            return;
        }
        this._openPipelinePreviewModal(batch, envelope.metadata?.source || 'TAFNE');
    },

    _openPipelinePreviewModal(batch, source) {
        $('#pipelinePreviewModal').remove();
        const esc = this._escHtml;
        const model = batch.model || batch;
        const entities = model.entities || [];
        const relations = model.relations || [];
        const declared = relations.filter((r) => r.inferred === false).length;

        const list = (title, items, cls) => items.length
            ? `<details class="ba-section"${cls === 'warn' ? ' open' : ''}>
                   <summary class="ba-section-hdr ${cls === 'warn' ? 'review' : 'safe'}">
                       ${esc(title)} <span class="tbl-acc-meta">${items.length}</span>
                   </summary>
                   <ul class="ba-list">${items.map((i) => `<li>${esc(String(i))}</li>`).join('')}</ul>
               </details>`
            : '';

        const $modal = $(`
            <div class="modal-backdrop open" id="pipelinePreviewModal" role="dialog" aria-modal="true">
                <div class="modal ba-modal tbl-modal">
                    <h3 class="modal-title">
                        <iconify-icon icon="material-symbols:account-tree-outline" style="font-size:16px;"></iconify-icon>
                        Pipeline received from ${esc(source)}
                    </h3>
                    <p class="ba-summary">
                        ${entities.length} entit${entities.length !== 1 ? 'ies' : 'y'},
                        ${relations.length} relation${relations.length !== 1 ? 's' : ''}${declared
                            ? ` — ${declared} declared, not guessed` : ''}
                    </p>
                    <div class="tbl-body">
                        ${list('Entities', entities.map((e) =>
                            `${e.name} · ${(e.columns || []).length} column${(e.columns || []).length !== 1 ? 's' : ''}`), 'safe')}
                        ${list('Relations', relations.map((r) =>
                            `${r.kind}: ${r.from?.entity || '?'} → ${r.to?.entity || '?'}` +
                            (r.cardinality ? ` (${r.cardinality})` : '') +
                            (r.inferred === false ? ' · declared' : ' · inferred')), 'safe')}
                        ${list('Not translatable', batch.refused || [], 'warn')}
                        ${list('Needs an answer before it can become DDL',
                            (batch.questions || []).map((q) => typeof q === 'string' ? q : (q.question || JSON.stringify(q))), 'warn')}
                    </div>
                    <div class="modal-actions">
                        ${entities.length ? '<button class="btn btn-primary" id="pipeInsertBtn">Insert on canvas</button>' : ''}
                        <button class="btn btn-ghost" id="pipeDismissBtn">Dismiss</button>
                    </div>
                </div>
            </div>`);
        $('body').append($modal);
        $('#pipeDismissBtn').on('click', () => $modal.remove());
        if (entities.length) {
            $('#pipeInsertBtn').on('click', () => {
                if (this.activeMode !== 'software' && typeof this.switchMode === 'function') {
                    this.switchMode('software');
                }
                this._insertModelEntities(model, source);
                $modal.remove();
            });
        }
        this.showToast(`Pipeline received from ${source}`, 'success');
    },

    _insertModelEntities(model, source) {
        const ed = window.editor;
        const entities = model.entities || [];
        if (!entities.length) { this.showToast('Nothing to insert', 'error'); return 0; }

        // Update, never duplicate. An entity already on the canvas that came
        // from the same place is the SAME entity: re-sending an edited sheet
        // must not grow a second `users` beside the first. Matched on the
        // return address when there is one, and on the entity id otherwise —
        // never on the name, which the user is free to change on either side.
        const replaced = this._removeMatchingEntities(entities);

        // One undo step for the whole insert. _placeSymbol pushes its own
        // entry per symbol, so a 6-table batch would otherwise cost six
        // undos to reverse one action.
        const beforeAll = ed._captureFullState ? ed._captureFullState() : null;
        const histLen = Array.isArray(ed._historyStack) ? ed._historyStack.length : -1;
        const histIdx = ed._historyIndex;

        const placed = new Map();      // entity id → placed <g>
        entities.forEach((ent, i) => {
            const gen = window.GxSpe.generateEntity({
                id: ent.id,
                name: ent.name,
                label: ent.name,
                variant: ent.kind === 'weak' ? 'weak' : undefined,
                // Pass the column through whole. Dropping unique/identity/fk
                // here silently disagreed with the model that produced them:
                // the gutter could not show a constraint the model knew about.
                columns: (ent.columns || []).map((c) => ({
                    id: c.id, name: c.name, type: c.type,
                    pk: c.pk, identity: c.identity, unique: c.unique,
                    nullable: c.nullable, fk: c.fk, comment: c.comment,
                })),
            });
            const x = 200 + (i % 3) * (gen.record.bodyWidth + 80);
            const y = 160 + Math.floor(i / 3) * 260;
            const el = ed._placeSymbol ? ed._placeSymbol(gen.symbol, x, y) : null;
            if (!el) return;
            // _placeSymbol ids by `sym_<symbolId>_<Date.now()>`, and every
            // entity now shares the symbol id 'entity' — a tight loop lands
            // inside one millisecond and produces DUPLICATE DOM ids, which
            // breaks flyTo, highlighting and back-annotation. Re-id by the
            // model entity, which is unique by construction and stable.
            el.id = `sym_entity_${ent.id}`;
            el.setAttribute('data-source', source);
            el.setAttribute('data-entity-id', ent.id);
            if (ent.candidate) el.setAttribute('data-candidate', '1');
            placed.set(ent.id, el);
        });

        const relCount = this._drawSchemaRelations(model.relations || [], placed);

        if (histLen >= 0) {
            ed._historyStack.length = histLen;
            ed._historyIndex = histIdx;
            ed.pushHistory(
                `Insert ${entities.length} entit${entities.length !== 1 ? 'ies' : 'y'} from ${source}`,
                beforeAll, ed._captureFullState());
        }

        // The model is the source of truth from here — the canvas is one
        // projection of it. Without this the serializers (SQL, Mermaid) have
        // nothing to read and every export falls back to scraping glyph text.
        this._schemaModel = model;
        // The BASIS: the model exactly as it arrived, frozen before any edit.
        // A back-annotation must diff against what the sender shipped, not
        // against a fresh read of the canvas — the same rule the figure path
        // states (`artifactsPanel.js` _handleFigureAnnotation), for the same
        // reason: anything that changes between send and receive would silently
        // change the answer. Deep-cloned, or "the basis" would be a second
        // reference to the object the editor is about to mutate.
        this._schemaBasis = JSON.parse(JSON.stringify(model));

        this.showToast(
            `${replaced ? 'Updated' : 'Inserted'} ${entities.length} entit${entities.length !== 1 ? 'ies' : 'y'}` +
            (relCount ? ` and ${relCount} relation${relCount !== 1 ? 's' : ''}` : '') +
            (replaced ? ` from ${source} (${replaced} replaced)` : ` from ${source}`), 'success');
        return relCount;
    },

    /**
     * Remove the on-canvas entities an incoming batch supersedes.
     *
     * Identity is the return address first (`origin.tool + doc + page/sheet +
     * regionId`), the model entity id second. Deliberately NOT the name: a user
     * renaming `users` to `app_users` on either side would otherwise get a
     * duplicate, and two entities whose names happen to collide would be merged
     * when they are unrelated.
     *
     * Relations attached to a removed entity go with it. Leaving them would
     * leave wires whose endpoint ports no longer exist, which the geometry
     * engine indexes as real nets — a relation between an entity and nothing.
     */
    _removeMatchingEntities(incoming) {
        const ed = window.editor;
        const root = ed && ed._contentRoot;
        if (!root || !incoming.length) return 0;

        const addr = (o) => (o && o.regionId != null
            ? `${o.tool || ''}|${o.doc || ''}|${o.page != null ? o.page : (o.sheetId || '')}|${o.regionId}`
            : null);
        const wantedAddrs = new Set(incoming.map((e) => addr(e.origin)).filter(Boolean));
        const wantedIds = new Set(incoming.map((e) => e.id).filter(Boolean));

        const prior = (this._schemaModel && this._schemaModel.entities) || [];
        const priorById = new Map(prior.map((e) => [e.id, e]));

        let removed = 0;
        Array.from(root.querySelectorAll('[data-entity-id]')).forEach((el) => {
            const id = el.getAttribute('data-entity-id');
            const p = priorById.get(id);
            const a = p ? addr(p.origin) : null;
            const match = (a && wantedAddrs.has(a)) || wantedIds.has(id);
            if (!match) return;

            // Wires first: a relation whose endpoint symbol is gone is worse
            // than no relation, because it still resolves as a net.
            Array.from(root.querySelectorAll('[data-relation-kind]')).forEach((w) => {
                if (w.getAttribute('data-from-sym') === el.id || w.getAttribute('data-to-sym') === el.id) {
                    if (ed.wires) ed.wires = ed.wires.filter((x) => x.id !== w.id);
                    w.remove();
                }
            });
            if (ed.components) ed.components = ed.components.filter((c) => c.id !== el.id);
            if (ed.graph && ed.graph.nodes && typeof ed.graph.nodes.delete === 'function') {
                ed.graph.nodes.delete(el.id);
            }
            el.remove();
            removed++;
        });
        return removed;
    },

    // ── Relations are wires ──────────────────────────────────────
    // A foreign key between two column ports is topologically the same object
    // as a wire between two component pins, so it is drawn as one: the
    // geometry engine indexes it, dragging an entity re-routes it, and a
    // hand-drawn relation and a promoted one are the same thing.
    _drawSchemaRelations(relations, placed) {
        const ed = window.editor;
        const root = ed._contentRoot;
        if (!root || !relations.length) return 0;
        const NS = ed.SVG_NS;
        let drawn = 0;

        const portAt = (el, colId, side) => {
            const pin = el.querySelector(`.pin-point[data-pin="col:${CSS.escape(colId)}:${side}"]`);
            if (!pin) return null;
            const tf = el.getAttribute('transform') || '';
            const m = tf.match(/translate\(\s*([\d.eE+-]+)[,\s]+([\d.eE+-]+)/);
            const ox = m ? parseFloat(m[1]) : 0, oy = m ? parseFloat(m[2]) : 0;
            return { x: ox + parseFloat(pin.getAttribute('cx')), y: oy + parseFloat(pin.getAttribute('cy')) };
        };

        relations.forEach((rel) => {
            // Only 'fk' is a line between two columns. 'union' is a merge claim
            // and 'derives' is a dependency — drawing either as a foreign key
            // would assert a constraint the model never made.
            if (rel.kind && rel.kind !== 'fk') return;
            const fromEl = placed.get(rel.from && rel.from.entity);
            const toEl   = placed.get(rel.to && rel.to.entity);
            if (!fromEl || !toEl) return;

            // Approach from whichever sides face each other.
            let a = portAt(fromEl, rel.from.column, 'right');
            let b = portAt(toEl, rel.to.column, 'left');
            if (a && b && b.x < a.x) {
                const a2 = portAt(fromEl, rel.from.column, 'left');
                const b2 = portAt(toEl, rel.to.column, 'right');
                if (a2 && b2) { a = a2; b = b2; }
            }
            if (!a || !b) return;

            // Relations are drawn in the editor's current route style, through
            // the same router the wire tool uses — an ERD in a bezier house
            // style and a hand-drawn wire must not disagree about what
            // "orthogonal" means.
            const style = ed._activeRouteStyle ? ed._activeRouteStyle() : 'orthogonal';
            const midX = (a.x + b.x) / 2;
            const waypoints = [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
            const d = window.GxEdgeRouter
                ? window.GxEdgeRouter.path(waypoints, style)
                : `M ${a.x} ${a.y} L ${midX} ${a.y} L ${midX} ${b.y} L ${b.x} ${b.y}`;
            const p = document.createElementNS(NS, 'path');
            p.id = `el_rel_${rel.id || (rel.from.entity + '_' + rel.from.column)}`;
            p.setAttribute('d', d);
            p.setAttribute('data-route-style', style);
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', '#48bb78');
            p.setAttribute('stroke-width', '1.8');
            p.setAttribute('data-geo-class', 'wire');
            p.setAttribute('data-from-sym', fromEl.id);
            p.setAttribute('data-from-pin', `col:${rel.from.column}:right`);
            p.setAttribute('data-to-sym', toEl.id);
            p.setAttribute('data-to-pin', `col:${rel.to.column}:left`);
            p.setAttribute('data-relation-kind', 'fk');
            if (rel.cardinality) p.setAttribute('data-cardinality', rel.cardinality);
            root.appendChild(p);
            drawn++;
        });
        return drawn;
    },

    async receiveBackAnnotation(envelope) {
        let raw;
        try {
            raw = envelope.pointer
                ? await CwsBridge.getStore(envelope.pointer)
                : envelope.inline;
        } catch (e) {
            this.showToast('Back-annotation: could not fetch data', 'error');
            return;
        }

        let incoming;
        try { incoming = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch (e) { this.showToast('Back-annotation: invalid JSON', 'error'); return; }

        if (Array.isArray(incoming)) incoming = { components: incoming, connections: [] };
        if (!incoming?.components?.length) {
            this.showToast('Back-annotation: no component data', 'error');
            return;
        }

        const current = this.buildNetlistJson();
        const diff = this._diffNetlists(incoming, current);

        if (!diff.safe.length && !diff.review.length) {
            this.showToast('Back-annotate: no changes detected', 'success');
            return;
        }

        this._openBackAnnotateModal(diff);
    },

    // ── Diff engine ────────────────────────────────────────────
    _diffNetlists(incoming, current) {
        const safe   = [];
        const review = [];

        const currentById = new Map(current.components.map(c => [c.id, c]));
        const incomingById = new Map(incoming.components.map(c => [c.id, c]));
        const seen = new Set();

        for (const inc of incoming.components) {
            // Match by ID first, then by refdes as fallback
            let cur = currentById.get(inc.id);
            if (!cur && inc.refdes) {
                cur = current.components.find(c => c.refdes && c.refdes === inc.refdes) || null;
            }

            if (!cur) {
                review.push({ kind: 'added', component: inc });
                continue;
            }

            seen.add(cur.id);

            const valueChanged  = inc.value   && inc.value   !== cur.value;
            const refdesChanged = inc.refdes   && inc.refdes  !== cur.refdes;
            const typeChanged   = inc.symbolType && inc.symbolType !== cur.symbolType;

            if (typeChanged) {
                review.push({ kind: 'type_changed', id: cur.id,
                    refdes: cur.refdes || cur.id, from: cur.symbolType, to: inc.symbolType });
            }
            if (valueChanged) {
                safe.push({ kind: 'modified', id: cur.id,
                    refdes: cur.refdes || cur.id, field: 'value', from: cur.value, to: inc.value });
            }
            if (refdesChanged && !typeChanged) {
                safe.push({ kind: 'modified', id: cur.id,
                    refdes: cur.refdes || cur.id, field: 'refdes', from: cur.refdes, to: inc.refdes });
            }
        }

        // Components in current but absent in incoming → removed
        for (const cur of current.components) {
            if (!seen.has(cur.id) && !incomingById.has(cur.id)) {
                review.push({ kind: 'removed', component: cur });
            }
        }

        return { safe, review };
    },

    // ── Back-annotate validation modal ────────────────────────
    _openBackAnnotateModal(diff) {
        $('#backAnnotateModal').remove();

        const nSafe   = diff.safe.length;
        const nReview = diff.review.length;

        const safeRowsHtml = nSafe
            ? diff.safe.map(ch => `
                <div class="ba-row">
                    <span class="ba-tag safe">${ch.field}</span>
                    <span class="ba-desc">
                        <strong>${ch.refdes}</strong>
                        <span class="ba-from">${ch.from || '—'}</span>
                        <span class="ba-arrow">→</span>
                        <span class="ba-to">${ch.to}</span>
                    </span>
                </div>`).join('')
            : '<div class="ba-empty">No safe changes</div>';

        const reviewRowsHtml = nReview
            ? diff.review.map(ch => {
                if (ch.kind === 'added') return `
                    <div class="ba-row">
                        <span class="ba-tag added">new</span>
                        <span class="ba-desc"><strong>${ch.component.refdes || ch.component.id}</strong>
                        (${ch.component.symbolType || 'unknown'}) — not in schema</span>
                    </div>`;
                if (ch.kind === 'removed') return `
                    <div class="ba-row">
                        <span class="ba-tag removed">del</span>
                        <span class="ba-desc"><strong>${ch.component.refdes || ch.component.id}</strong>
                        removed in TAFNE</span>
                    </div>`;
                if (ch.kind === 'type_changed') return `
                    <div class="ba-row">
                        <span class="ba-tag conflict">type</span>
                        <span class="ba-desc"><strong>${ch.refdes}</strong>
                        ${ch.from} → ${ch.to}</span>
                    </div>`;
                return '';
            }).join('')
            : '<div class="ba-empty">None</div>';

        const $modal = $(`
            <div class="modal-backdrop open" id="backAnnotateModal" role="dialog" aria-modal="true">
                <div class="modal ba-modal">
                    <h3 class="modal-title">
                        <iconify-icon icon="material-symbols:undo" style="font-size:16px;"></iconify-icon>
                        Back-Annotate from TAFNE
                    </h3>
                    <p class="ba-summary">
                        ${nSafe + nReview} change${nSafe + nReview !== 1 ? 's' : ''} ·
                        <span class="ba-safe-ct">${nSafe} safe</span> ·
                        <span class="ba-review-ct">${nReview} need${nReview !== 1 ? '' : 's'} review</span>
                    </p>
                    ${nSafe ? `
                    <div class="ba-section">
                        <div class="ba-section-hdr safe">✓ Safe to apply (${nSafe})</div>
                        <div class="ba-rows">${safeRowsHtml}</div>
                    </div>` : ''}
                    ${nReview ? `
                    <div class="ba-section">
                        <div class="ba-section-hdr review">⚠ Needs review (${nReview})</div>
                        <div class="ba-rows">${reviewRowsHtml}</div>
                    </div>` : ''}
                    <div class="modal-actions">
                        <button class="btn btn-ghost" id="baDismissBtn">Dismiss</button>
                        ${nSafe ? `<button class="btn btn-primary" id="baApplyBtn">
                            Apply ${nSafe} safe change${nSafe !== 1 ? 's' : ''}
                        </button>` : ''}
                    </div>
                </div>
            </div>`);

        $('body').append($modal);
        $('#baDismissBtn').on('click', () => $modal.remove());

        if (nSafe) {
            const self = this;
            $('#baApplyBtn').on('click', () => {
                const applied = self._applyBackAnnotateChanges(diff.safe);
                $modal.remove();
                self.showToast(
                    applied ? `Back-annotated: ${applied} change${applied !== 1 ? 's' : ''} applied`
                            : 'Back-annotate: no matching elements found',
                    applied ? 'success' : 'error'
                );
            });
        }
    },

    // ── Apply safe back-annotate changes to SVG ───────────────
    _applyBackAnnotateChanges(safeChanges) {
        if (!safeChanges.length) return 0;

        const before = this._captureFullState?.();
        let applied = 0;

        safeChanges.forEach(ch => {
            // Resolve through this.components, NOT a DOM id query.
            //
            // `ch.id` comes from buildNetlistJson, which emits the INTERNAL
            // component id (`component_0`). The DOM element's id is unrelated
            // (`sym_resistor_1786760018341`), so `g#component_0` never matched
            // and every back-annotation silently applied zero changes — the
            // diff was correct, the modal listed the right change, Apply closed
            // the modal, and nothing happened. Verified in a real browser
            // 2026-08-14g.
            //
            // The netlist deliberately keeps emitting the internal id (TAFNE's
            // sheets, get_netlist and the MCP surface all key on it), so the
            // fix belongs here: look the component up the way the rest of the
            // editor does, and fall back to refdes for a netlist that came from
            // a different session and carries ids this canvas never issued.
            const comp = (this.components || []).find(c => c.id === ch.id)
                || (ch.refdes ? (this.components || []).find(c =>
                    (c.element?.querySelector?.('text.sym-value')?.textContent || '') === ch.refdes) : null);
            const el = comp?.element;
            if (!el) return;
            const labelEl = el.querySelector('text.sym-value');
            if (!labelEl) return;
            labelEl.textContent = ch.to;
            applied++;
        });

        if (applied > 0 && typeof this.pushHistory === 'function') {
            const after = this._captureFullState?.();
            this.pushHistory('Back-annotate', before, after);
        }

        return applied;
    },

    batchExport() {
        if (!this.displays.length) {
            this.showToast('No diagrams loaded', 'error');
            return;
        }

        const saved = this.activeDisplayIdx;

        this.displays.forEach((display, idx) => {
            setTimeout(() => {
                const base = display.name.replace(/\.[^.]+$/, '');
                this._triggerDownload(display.svgContent, `${base}.svg`, 'image/svg+xml;charset=utf-8');
                if (idx === this.displays.length - 1) {
                    this.showToast(`${this.displays.length} SVG(s) exported`, 'success');
                    this.switchDisplay(saved);
                }
            }, idx * 300);
        });
    },

    // ── Mini Map ─────────────────────────────────────────────

    toggleMiniMap() {
        this.miniMapVisible = !this.miniMapVisible;
        this.$miniMap.toggleClass('visible', this.miniMapVisible);
        if (this.miniMapVisible) this.updateMiniMap();
    },

    updateMiniMap() {
        if (!this.miniMapVisible) return;
        const clone = this.$svgDisplay.clone();
        clone.removeAttr('id').find('*').removeAttr('id');
        this.$miniMapSvg.empty().append(clone);
        this.$miniMapViewport.css({ width: '20%', height: '20%', left: '40%', top: '40%' });
    },

    // ── Toast ────────────────────────────────────────────────

    showToast(message, type = 'success') {
        this.$toast.removeClass('show success error').addClass(type);
        this.$toast.text(message).addClass('show');
        clearTimeout(this.toastTimeout);
        this.toastTimeout = setTimeout(() => this.$toast.removeClass('show'), 3000);
    },

    // ── Loading Indicator ────────────────────────────────────

    showLoading(show) {
        $('#loadingIndicator').toggle(show);
    },

    // ── ERD → SQL DDL export ─────────────────────────────────

    exportAsSqlDdl() {
        const name = this.displays[this.activeDisplayIdx]?.name || 'diagram';

        // Model first. When a schema was promoted or imported, GxSchema is the
        // source of truth and the serializer reads FIELDS — so a comment
        // containing a colon, a composite key, and a FOREIGN KEY clause all
        // survive, none of which the scraper below can represent.
        if (this._schemaModel && window.GxSchemaSerializers) {
            const sql = window.GxSchemaSerializers.exportSql(this._schemaModel);
            const n = (this._schemaModel.entities || []).length;
            this._triggerDownload(sql, `${name.replace(/\.[^.]+$/, '')}.sql`, 'text/plain;charset=utf-8');
            this.showToast(`SQL exported (${n} table${n !== 1 ? 's' : ''})`, 'success');
            return;
        }

        // Legacy path: entities drawn by hand before the model existed. It
        // recovers meaning by regexing glyph text and cannot represent a
        // foreign key, so it is a MIGRATION path, not a fallback to rely on.
        const entities = this._contentRoot
            ? Array.from(this._contentRoot.querySelectorAll('[data-symbol="entity"],[data-symbol="weak-entity"]'))
            : [];

        if (!entities.length) {
            this.showToast('No entities on canvas', 'error');
            return;
        }

        const colRx = /^(?:[🔑🔗]\s*)?(.+?)\s*:\s*(.+)$/u;

        const sql = entities.map(g => {
            const tableName = (g.querySelector('text.sym-value')?.textContent || 'unknown')
                .trim().replace(/\s+/g, '_').toLowerCase();
            const isWeak = g.dataset.symbol === 'weak-entity';

            const cols = Array.from(g.querySelectorAll('text.erd-col'))
                .map(t => t.textContent.trim())
                .filter(t => t && !t.startsWith('+'));

            const colDefs = cols.map(raw => {
                const icon = raw.startsWith('🔑') ? 'PK' : raw.startsWith('🔗') ? 'FK' : '';
                const m = colRx.exec(raw);
                if (!m) return `    -- (unparsed) ${raw}`;
                const colName = m[1].trim().replace(/\s+/g, '_').toLowerCase();
                let typePart = m[2].trim();
                const isPK   = icon === 'PK' || /\bPK\b/i.test(typePart);
                const isFK   = icon === 'FK' || /\bFK\b/i.test(typePart);
                const isNN   = isPK || /\bNN\b|NOT\s*NULL/i.test(typePart);
                const isUQ   = /\bUQ\b|UNIQUE/i.test(typePart);
                typePart = typePart.replace(/\b(PK|FK|NN|UQ|NOT\s*NULL|UNIQUE)\b/gi, '').trim();

                let def = `    ${colName} ${typePart}`;
                if (isNN)  def += ' NOT NULL';
                if (isUQ)  def += ' UNIQUE';
                if (isPK)  def += ' PRIMARY KEY';
                return def;
            });

            const comment = isWeak ? ' -- WEAK ENTITY' : '';
            return `CREATE TABLE ${tableName} (${comment}\n${colDefs.join(',\n')}\n);`;
        }).join('\n\n');

        const base = name.replace(/\.[^.]+$/, '');
        this._triggerDownload(sql, `${base}.sql`, 'text/plain;charset=utf-8');
        this.showToast(`SQL exported (${entities.length} table${entities.length > 1 ? 's' : ''})`, 'success');
    },

    // ── ERD ⇄ Mermaid erDiagram ───────────────────────────────
    // The one software export that had no button at all. Both directions ship
    // together: the round trip (emit → parse → emit) is the cheapest proof the
    // model is complete, and a schema pasted from documentation then enters the
    // same pipeline as one promoted from a table.

    exportAsMermaidErd() {
        const S = window.GxSchemaSerializers;
        if (!S) { this.showToast('Mermaid export unavailable', 'error'); return; }
        const model = this._schemaModel || this._modelFromCanvas();
        if (!model || !model.entities.length) {
            this.showToast('No entities to export', 'error');
            return;
        }
        const name = this.displays[this.activeDisplayIdx]?.name || 'diagram';
        this._triggerDownload(S.exportMermaid(model),
            `${name.replace(/\.[^.]+$/, '')}.mmd`, 'text/plain;charset=utf-8');
        this.showToast(`Mermaid ERD exported (${model.entities.length} entities)`, 'success');
    },

    async importMermaidErd() {
        const S = window.GxSchemaSerializers;
        if (!S || !window.GxSpe) { this.showToast('Mermaid import unavailable', 'error'); return; }
        const text = window.prompt('Paste a Mermaid erDiagram:');
        if (!text || !text.trim()) return;
        let model;
        try { model = S.importMermaid(text); }
        catch (e) { this.showToast('Mermaid import failed: ' + (e && e.message), 'error'); return; }
        if (!model?.entities?.length) { this.showToast('No entities found in that diagram', 'error'); return; }
        // Imported entities are DECLARED, not inferred — they came from a
        // human-written diagram, so they are not candidates to verify.
        model.entities.forEach((e) => { e.candidate = false; });
        this._insertModelEntities(model, 'mermaid');
    },

    /**
     * Send the schema's edits back to TAFNE — `gx-schema-annotation/1`.
     *
     * The closing edge of the loop. A table came from a sheet, was promoted
     * into entities, was edited here, and the edit now goes back to the cell it
     * came from. Two kinds of change cross, and they are separated on purpose:
     *
     *   EDITS  a rename or a drop, addressable to a sheet and a header cell,
     *          applicable there.
     *   NOTES  a type, a foreign key, a primary key — structure a header cell
     *          cannot hold. They cross as QA tags: visible to whoever validates
     *          the data, applied by nothing.
     *
     * The alternative was to drop the second kind silently, which would mean a
     * type decision made here never reaches the person looking at the rows.
     */
    async sendSchemaAnnotation() {
        const P = window.GxSchemaPromote;
        if (!P || typeof P.annotateDiff !== 'function') {
            this.showToast('Back-annotation needs the schema model layer', 'error');
            return;
        }
        const basis = this._schemaBasis;
        if (!basis) {
            // Without a basis there is nothing to diff against, and diffing
            // against a fresh canvas read would report the whole schema as new.
            this.showToast('Nothing to send back — this schema was not promoted from TAFNE', 'error');
            return;
        }
        const current = this._schemaModel || this._modelFromCanvas();
        if (!current) { this.showToast('No schema model on this canvas', 'error'); return; }

        const origin = (basis.entities || []).map((e) => e.origin).find(Boolean) || null;
        const env = P.annotateDiff({ basis, current, origin });
        if (!env.edits.length && !env.notes.length) {
            this.showToast('No changes to send back', 'success');
            return;
        }
        if (!CwsBridge.isEmbedded) { this.showToast('Not embedded in the OS shell', 'error'); return; }

        try {
            CwsBridge.send('cws:tool:launch', { toolId: 'tifany', focusAfterLaunch: true }, 'os');
            const provenance = window.GxProvenance
                ? window.GxProvenance.build('svg_wiring', CwsContracts.PROVENANCE_STAGES.ANALYSIS, {
                    source: 'schema-annotation', ops: ['edit', 'annotate'], score: null,
                })
                : [];
            const pointerId = await CwsBridge.requestStore(JSON.stringify(env), 'json-data');
            CwsBridge.offerData(CwsContracts.createEnvelope({
                pointer: pointerId,
                contentType: 'json-data',
                metadata: {
                    source: 'schema-editor',
                    editCount: env.edits.length,
                    noteCount: env.notes.length,
                },
                hints: { suggestedTarget: 'tifany', action: 'back-annotate-schema' },
                provenance,
            }));
            this.showToast(
                `Sent ${env.edits.length} edit${env.edits.length !== 1 ? 's' : ''}` +
                (env.notes.length ? ` and ${env.notes.length} note${env.notes.length !== 1 ? 's' : ''}` : '') +
                ' → TAFNE', 'success');
        } catch (e) {
            this.showToast('Send failed: ' + (e && e.message), 'error');
        }
    },

    // Rebuild a model from a hand-drawn ERD, using the generated row attributes
    // (never glyph text). Returns null when the canvas holds legacy entities
    // with no attributes, so the caller can say so rather than emit an empty
    // schema that looks like a successful export of nothing.
    _modelFromCanvas() {
        const G = window.GxSchema;
        const root = this._contentRoot;
        if (!G || !root) return null;
        const els = Array.from(root.querySelectorAll('[data-symbol="entity"],[data-symbol="weak-entity"]'));
        const entities = els.map((g, i) => {
            const cols = Array.from(g.querySelectorAll('[data-col-id]')).map((cd) => {
                const nul = cd.getAttribute('data-nullable');
                return G.createColumn({
                    id: cd.getAttribute('data-col-id'),
                    name: cd.getAttribute('data-col-name') || cd.getAttribute('data-col-id'),
                    type: cd.getAttribute('data-col-type') || 'text',
                    pk: !!cd.getAttribute('data-pk'),
                    identity: !!cd.getAttribute('data-identity'),
                    unique: !!cd.getAttribute('data-unique'),
                    nullable: nul === '1' ? true : (nul === '0' ? false : null),
                    fk: cd.getAttribute('data-fk-entity')
                        ? { entity: cd.getAttribute('data-fk-entity'), column: cd.getAttribute('data-fk-column') }
                        : null,
                });
            });
            return G.createEntity({
                id: g.getAttribute('data-entity-id') || g.id || `e${i}`,
                name: (g.querySelector('text.sym-value')?.textContent || '').trim() || `Entity ${i + 1}`,
                kind: g.dataset.symbol === 'weak-entity' ? 'weak' : 'table',
                columns: cols, candidate: false,
            });
        }).filter((e) => e.columns.length);
        if (!entities.length) return null;

        const relations = Array.from(root.querySelectorAll('[data-relation-kind]')).map((p, i) => {
            const col = (s) => (/^col:(.+):(left|right)$/.exec(s || '') || [])[1] || null;
            const entOf = (symId) => {
                const el = symId && document.getElementById(symId);
                return el?.getAttribute('data-entity-id') || symId || null;
            };
            return G.createRelation({
                id: p.id || `r${i}`,
                kind: p.getAttribute('data-relation-kind') || 'fk',
                from: { entity: entOf(p.getAttribute('data-from-sym')), column: col(p.getAttribute('data-from-pin')) },
                to: { entity: entOf(p.getAttribute('data-to-sym')), column: col(p.getAttribute('data-to-pin')) },
                cardinality: p.getAttribute('data-cardinality') || null,
            });
        });
        return G.createModel({ entities, relations });
    },

    // ── Sequence → Mermaid export ─────────────────────────────

    exportAsMermaidSequence() {
        const name = this.displays[this.activeDisplayIdx]?.name || 'diagram';
        const root = this._contentRoot;
        if (!root) { this.showToast('No canvas', 'error'); return; }

        const getX = g => {
            const m = (g.getAttribute('transform') || '').match(/translate\(\s*([\d.+-]+)/);
            return m ? parseFloat(m[1]) : 0;
        };
        const getY = g => {
            const m = (g.getAttribute('transform') || '').match(/translate\(\s*[\d.+-]+[,\s]+([\d.+-]+)/);
            return m ? parseFloat(m[1]) : 0;
        };
        const label = g => (g.querySelector('text.sym-value')?.textContent || '').trim();

        // Participants sorted left → right
        const actors = Array.from(root.querySelectorAll('[data-symbol="sq-actor"],[data-symbol="sq-system"]'))
            .sort((a, b) => getX(a) - getX(b));

        // Messages sorted top → bottom
        const messages = Array.from(root.querySelectorAll('[data-symbol="sq-message"],[data-symbol="sq-return"]'))
            .sort((a, b) => getY(a) - getY(b));

        const actorNames = actors.map((a, i) => label(a) || `P${i + 1}`);

        const resolveActor = (msgX, msgW = 150) => {
            const cx = msgX + msgW / 2;
            const srcX = msgX;
            const dstX = msgX + msgW;
            // Nearest actor to srcX = sender; nearest to dstX = receiver
            let src = actorNames[0], dst = actorNames[0];
            let srcDist = Infinity, dstDist = Infinity;
            actors.forEach((a, i) => {
                const ax = getX(a) + 60; // center of 120px box
                if (Math.abs(ax - srcX) < srcDist) { srcDist = Math.abs(ax - srcX); src = actorNames[i]; }
                if (Math.abs(ax - dstX) < dstDist) { dstDist = Math.abs(ax - dstX); dst = actorNames[i]; }
            });
            return { src, dst };
        };

        const lines = ['sequenceDiagram'];
        actorNames.forEach(n => lines.push(`    participant ${n}`));

        messages.forEach(g => {
            const isReturn = g.dataset.symbol === 'sq-return';
            const x = getX(g);
            const { src, dst } = resolveActor(x);
            const text = label(g) || (isReturn ? 'return' : 'message()');
            const arrow = isReturn ? `${src}-->${dst}` : `${src}->>${dst}`;
            lines.push(`    ${arrow}: ${text}`);
        });

        const base = name.replace(/\.[^.]+$/, '');
        this._triggerDownload(lines.join('\n'), `${base}.mmd`, 'text/plain;charset=utf-8');
        this.showToast(`Mermaid exported (${messages.length} message${messages.length !== 1 ? 's' : ''})`, 'success');
    },

    // ── FSM → JSON / XState export ───────────────────────────

    buildFsmJson() {
        const root = this._contentRoot;
        if (!root) return null;
        const name = this.displays[this.activeDisplayIdx]?.name || 'diagram';

        const getTransform = g => {
            const m = (g.getAttribute('transform') || '').match(/translate\(\s*([\d.+-]+)[,\s]+([\d.+-]+)/);
            return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
        };

        const stateEls = Array.from(root.querySelectorAll(
            '[data-symbol="fsm-state"],[data-symbol="fsm-initial"],[data-symbol="fsm-final"],[data-symbol="fsm-choice"],[data-symbol="fsm-composite"]'
        ));

        const states = stateEls.map(g => {
            const { x, y } = getTransform(g);
            return {
                id:   g.id || `state_${Math.random().toString(36).slice(2, 7)}`,
                name: (g.querySelector('text.sym-value')?.textContent || '').trim() || g.dataset.symbol,
                type: g.dataset.symbol.replace('fsm-', ''),
                x, y,
            };
        });

        // Transition labels (fsm-transition symbols provide event/action text near wires)
        const transitionLabels = Array.from(root.querySelectorAll('[data-symbol="fsm-transition"]'))
            .map(g => ({
                text: (g.querySelector('text.sym-value')?.textContent || '').trim(),
                ...getTransform(g),
            }));

        // Wires between states — read from this.wires if available
        const stateIds = new Set(states.map(s => s.id));
        const transitions = (this.wires || [])
            .filter(w => w.from && w.to && stateIds.has(w.from) && stateIds.has(w.to))
            .map((w, i) => {
                // Find nearest transition label by proximity to wire midpoint
                const fromState = states.find(s => s.id === w.from);
                const toState   = states.find(s => s.id === w.to);
                let event = '', action = '';
                if (fromState && toState && transitionLabels.length) {
                    const mx = (fromState.x + toState.x) / 2;
                    const my = (fromState.y + toState.y) / 2;
                    const nearest = transitionLabels.reduce((best, t) =>
                        Math.hypot(t.x - mx, t.y - my) < Math.hypot(best.x - mx, best.y - my) ? t : best
                    );
                    const parts = nearest.text.split('/').map(p => p.trim());
                    event  = parts[0] || '';
                    action = parts[1] || '';
                }
                return { id: w.id || `t_${i}`, from: w.from, to: w.to, event, action };
            });

        return { schema: 'cws-fsm-v1', name, states, transitions };
    },

    exportAsFsmJson() {
        const fsm = this.buildFsmJson();
        if (!fsm) { this.showToast('No canvas', 'error'); return; }
        if (!fsm.states.length) { this.showToast('No states on canvas', 'error'); return; }

        const base = fsm.name.replace(/\.[^.]+$/, '');
        this._triggerDownload(JSON.stringify(fsm, null, 2), `${base}__fsm.json`, 'application/json');
        this.showToast(`FSM JSON exported (${fsm.states.length} states)`, 'success');
    },

    exportAsXState() {
        const fsm = this.buildFsmJson();
        if (!fsm?.states.length) { this.showToast('No states on canvas', 'error'); return; }

        const initial = fsm.states.find(s => s.type === 'initial') || fsm.states[0];
        const stateMap = {};
        fsm.states
            .filter(s => s.type !== 'initial' && s.type !== 'final')
            .forEach(s => {
                const safeName = s.name.replace(/\s+/g, '_').toUpperCase();
                const ons = fsm.transitions
                    .filter(t => t.from === s.id)
                    .reduce((acc, t) => {
                        const target = fsm.states.find(st => st.id === t.to);
                        if (target) acc[t.event || 'NEXT'] = target.name.replace(/\s+/g, '_').toUpperCase();
                        return acc;
                    }, {});
                stateMap[safeName] = Object.keys(ons).length ? { on: ons } : {};
            });

        const xstateConfig = {
            id:      fsm.name.replace(/\s+/g, '_').toLowerCase(),
            initial: (initial.name || 'idle').replace(/\s+/g, '_').toUpperCase(),
            states:  stateMap,
        };

        const base = fsm.name.replace(/\.[^.]+$/, '');
        const code = `import { createMachine } from 'xstate';\n\nexport const machine = createMachine(${JSON.stringify(xstateConfig, null, 2)});\n`;
        this._triggerDownload(code, `${base}__machine.ts`, 'text/plain;charset=utf-8');
        this.showToast(`XState machine exported`, 'success');
    },

    async sendFsmToTafne() {
        const fsm = this.buildFsmJson();
        if (!fsm?.states.length) { this.showToast('No states on canvas', 'error'); return; }

        if (!CwsBridge.isEmbedded) {
            const base = fsm.name.replace(/\.[^.]+$/, '');
            this._triggerDownload(JSON.stringify(fsm, null, 2), `${base}__fsm.json`, 'application/json');
            this.showToast('Saved FSM JSON (not embedded)', 'success');
            return;
        }
        if (!CwsBridge.isConnected) {
            this.showToast('OS connection lost — reload the page', 'error');
            return;
        }
        try {
            this.showToast('Sending FSM to TAFNE…', 'success');
            // A state machine crosses as two TABLES — states and transitions —
            // rather than as a bespoke `load-fsm` action.
            //
            // This button used to send `action: 'load-fsm'`, and no receiver in
            // TAFNE has ever compared against that name. The send reported
            // success and nothing arrived. TAFNE's model is sheets, so the fix
            // is not a new receiver branch: it is sending the shape TAFNE
            // already knows how to open. Two sheets is also the honest reading —
            // a transition table is what you sort, filter and check for
            // unreachable states in.
            const payload = this._fsmAsTables(fsm);
            const pointerId = await CwsBridge.requestStore(JSON.stringify(payload), 'json-data');
            CwsBridge.offerData(CwsContracts.createEnvelope({
                pointer:     pointerId,
                contentType: 'json-data',
                metadata: {
                    source:      'schema-editor',
                    diagramName: fsm.name,
                    stateCount:  fsm.states.length,
                },
                hints: { suggestedTarget: 'tifany', action: 'load-tables' },
            }));
            this._trackExport();
            this.showToast(
                `Sent ${fsm.states.length} state${fsm.states.length !== 1 ? 's' : ''} and ` +
                `${fsm.transitions.length} transition${fsm.transitions.length !== 1 ? 's' : ''} → TAFNE`,
                'success');
        } catch (e) {
            this.showToast('Send failed: ' + e.message, 'error');
        }
    },

    /** cws-fsm-v1 → a gx-tables envelope: one States sheet, one Transitions sheet. */
    _fsmAsTables(fsm) {
        const G = window.GxTables;
        const grid = (headers, rows) => {
            if (!G) return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
            return [headers.map(h => G.cell(h, { header: true })),
                ...rows.map(r => r.map(v => G.cell(v)))];
        };

        const stateRows = fsm.states.map(s => [s.name || s.id, s.type || 'normal', s.id]);
        // Names, not ids, in the from/to columns: a transition table a person
        // reads and edits is the point, and the id column is carried alongside
        // so nothing is lost.
        const nameOf = new Map(fsm.states.map(s => [s.id, s.name || s.id]));
        const transitionRows = fsm.transitions.map(t => [
            nameOf.get(t.from) || t.from, nameOf.get(t.to) || t.to,
            t.event || '', t.action || '', t.id,
        ]);

        const tables = [
            { name: 'States', rows: grid(['State', 'Type', 'Id'], stateRows) },
            { name: 'Transitions', rows: grid(['From', 'To', 'Event', 'Action', 'Id'], transitionRows) },
        ].filter(t => t.rows.length > 1 || !G);

        if (!G) return { schema: 'gx-tables-v1', tables, meta: { source: 'schema-editor', title: fsm.name } };
        return G.createEnvelope({
            source: 'schema-editor', title: fsm.name,
            // candidate:false — this is the editor's own drawn model, not an
            // extracted guess. origin:null explicitly: it was authored here, so
            // there is no upstream region to return an edit to.
            tables: tables.map(t => G.createTable({
                name: t.name, rows: t.rows, candidate: false, confidence: 1.0, origin: null,
            })),
        });
    },
});
