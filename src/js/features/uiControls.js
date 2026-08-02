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
            // Provenance assembly is intelligence-layer POLICY and lives in the
            // shell-provided GxProvenance module (assets/os/provenance.js), NOT in
            // this forkable tool. Standalone/forked builds have no GxProvenance, so
            // the send simply carries no lineage — the tool still works.
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

    // Generic tables → TAFNE send (gx-tables-v1). tables = [{ name, rows: [{...}] }]
    // Reuses the netlist pipeline's probe/launch plumbing; standalone → JSON download.
    async sendTablesToTafne(tables, title = 'tables') {
        if (!tables?.length || !tables.some(t => t.rows?.length)) {
            this.showToast('Nothing to send', 'error');
            return;
        }
        const payload = { schema: 'gx-tables-v1', tables, meta: { source: 'schema-editor', title } };

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
            const el = this._contentRoot?.querySelector(`g#${CSS.escape(ch.id)}[data-symbol]`);
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

    // ── Measure Tool ─────────────────────────────────────────

    toggleMeasureTool() {
        if (this._measuring) {
            this._measuring = false;
            this._measurePoints = [];
            this._clearMeasureTape();
            this.$svgDisplay.off('click.measure mousemove.measure');
            $('#measureBtn').removeClass('active');
            this.showToast('Measure tool OFF', 'success');
            return;
        }
        this._showMeasureModal();
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

    _startMeasuring() {
        this._measuring = true;
        this._measurePoints = [];
        this._measureOverlay = null;
        $('#measureBtn').addClass('active');
        this.showToast(`Measure ON — click a point or wire (${this._measureUnit || 'px'})`, 'success');

        // ── Mouse move: live tape after first point ──
        this.$svgDisplay.on('mousemove.measure', (e) => {
            if (!this._measuring || this._measurePoints.length !== 1) return;
            const svgPt = this.screenToSVG(e.clientX, e.clientY);
            const snapped = this.smartSnap?.(svgPt.x, svgPt.y, []) || svgPt;
            this._drawMeasureTape(this._measurePoints[0], snapped, false);
        });

        // ── Click: place points or auto-measure wire ──
        this.$svgDisplay.on('click.measure', (e) => {
            if (!this._measuring) return;

            // Wire click: instant auto-measurement
            const target = e.target?.closest?.('path[data-geo-class="wire"], path.wire-path') ||
                           (this._isWireElement?.(e.target) ? e.target : null);
            if (target) {
                this._measureWireClick(target);
                return;
            }

            const svgPt  = this.screenToSVG(e.clientX, e.clientY);
            const snap   = this.smartSnap?.(svgPt.x, svgPt.y, []) || svgPt;
            const pt = { x: snap.x, y: snap.y };

            this._measurePoints.push(pt);

            if (this._measurePoints.length === 1) {
                // Draw Point A marker
                this._ensureMeasureOverlay();
                this._drawMeasurePoint(pt.x, pt.y, 'a');
                this.showToast('Point A set — move to Point B', 'success');
            } else if (this._measurePoints.length === 2) {
                this._drawMeasureTape(this._measurePoints[0], pt, true);
                this._finalizeMeasurement();
            }
        });
    },

    // ── Wire auto-measurement ─────────────────────────────────
    _measureWireClick(wireEl) {
        try {
            const rawLen = wireEl.getTotalLength();
            const result = this._formatMeasureResult(rawLen);
            const d = wireEl.getAttribute('d') || '';
            const segs = d.split(/(?=[ML])/).filter(s => s.trim()).length - 1;

            this._clearMeasureTape();
            this._ensureMeasureOverlay();
            const mid = wireEl.getPointAtLength(rawLen / 2);
            this._drawMeasureCallout(mid.x, mid.y, result, `${segs} seg${segs !== 1 ? 's' : ''}`);

            this.showToast(`Wire: ${result} · ${segs} segment${segs !== 1 ? 's' : ''}`, 'success');
        } catch (_) {
            this.showToast('Could not measure wire', 'error');
        }
    },

    // ── Finalize two-point measurement ───────────────────────
    _finalizeMeasurement() {
        const [a, b] = this._measurePoints;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const result = this._formatMeasureResult(dist);
        const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
        const angleLabel = this._classifyAngle(angleDeg);

        const dxResult = this._formatMeasureResult(Math.abs(dx));
        const dyResult = this._formatMeasureResult(Math.abs(dy));

        this.showToast(`${result}  Δx:${dxResult}  Δy:${dyResult}  ∠${Math.abs(angleDeg).toFixed(1)}° ${angleLabel}`, 'success');

        // Reset to allow next measurement without full mode exit
        this._measurePoints = [];
        this._measureOverlay = null;
    },

    // ── Format a distance in SVG units → display unit ────────
    _formatMeasureResult(distPx) {
        if (!this._measureScaleFactor || this._measureUnit === 'px') {
            return `${distPx.toFixed(1)} px`;
        }
        return `${(distPx * this._measureScaleFactor).toFixed(3)} ${this._measureUnit}`;
    },

    // ── Classify angle ───────────────────────────────────────
    _classifyAngle(deg) {
        const norm = ((deg % 180) + 180) % 180;
        if (norm < 1 || norm > 179)    return 'Straight';
        if (Math.abs(norm - 90) < 1.5) return 'Right';
        if (Math.abs(norm - 45) < 2 || Math.abs(norm - 135) < 2) return 'Diagonal';
        if (norm < 90)                 return 'Acute';
        return 'Obtuse';
    },

    // ── Ensure a <g class="measure-overlay"> exists in contentRoot ──
    _ensureMeasureOverlay() {
        if (this._measureOverlay?.isConnected) return this._measureOverlay;
        const NS  = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const g   = document.createElementNS(NS, 'g');
        g.classList.add('measure-overlay');
        g.setAttribute('pointer-events', 'none');
        const root = this._contentRoot || this.$svgDisplay?.[0];
        root?.appendChild(g);
        this._measureOverlay = g;
        return g;
    },

    // ── Draw Point A / B marker ───────────────────────────────
    _drawMeasurePoint(x, y, which) {
        const NS   = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const g    = this._ensureMeasureOverlay();
        const zoom = this.camera?.zoom || 1;
        const c = document.createElementNS(NS, 'circle');
        c.classList.add('measure-point', `measure-point-${which}`);
        c.setAttribute('cx', x);
        c.setAttribute('cy', y);
        c.setAttribute('r', 5 / zoom);
        g.appendChild(c);
    },

    // ── Draw live measure tape line + angle arc + HUD labels ──
    _drawMeasureTape(a, b, isFinal = false) {
        const NS   = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const g    = this._ensureMeasureOverlay();
        const zoom = this.camera?.zoom || 1;

        // Clear previous live elements (keep Point A dot)
        g.querySelectorAll('.measure-tape, .measure-hud, .measure-angle-arc, .measure-point-b').forEach(el => el.remove());

        const dx   = b.x - a.x;
        const dy   = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.5) return;

        const angle     = Math.atan2(dy, dx);
        const perpAngle = angle + Math.PI / 2;
        const tickLen   = 8 / zoom;

        // ── Main tape line ──
        const line = document.createElementNS(NS, 'line');
        line.classList.add('measure-tape');
        if (isFinal) line.classList.add('measure-tape-final');
        line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
        g.appendChild(line);

        // ── End-cap ticks ──
        [a, b].forEach((pt, idx) => {
            const tick = document.createElementNS(NS, 'line');
            tick.classList.add('measure-tape');
            tick.setAttribute('x1', pt.x + Math.cos(perpAngle) * tickLen);
            tick.setAttribute('y1', pt.y + Math.sin(perpAngle) * tickLen);
            tick.setAttribute('x2', pt.x - Math.cos(perpAngle) * tickLen);
            tick.setAttribute('y2', pt.y - Math.sin(perpAngle) * tickLen);
            g.appendChild(tick);
        });

        // ── Point B dot ──
        const cb = document.createElementNS(NS, 'circle');
        cb.classList.add('measure-point', 'measure-point-b');
        cb.setAttribute('cx', b.x); cb.setAttribute('cy', b.y);
        cb.setAttribute('r', 4 / zoom);
        g.appendChild(cb);

        // ── Angle arc at Point A ──
        const ARC_R = Math.min(dist * 0.18, 28 / zoom);
        if (ARC_R > 4 / zoom) {
            const arc     = document.createElementNS(NS, 'path');
            const startX  = a.x + ARC_R; // 0° reference
            const startY  = a.y;
            const arcEndX = a.x + ARC_R * Math.cos(angle);
            const arcEndY = a.y + ARC_R * Math.sin(angle);
            const sweepFlag = dy >= 0 ? 1 : 0;
            const largeFlag = Math.abs(angle) > Math.PI ? 1 : 0;
            arc.classList.add('measure-angle-arc');
            arc.setAttribute('d',
                `M ${startX} ${startY} A ${ARC_R} ${ARC_R} 0 ${largeFlag} ${sweepFlag} ${arcEndX} ${arcEndY}`);
            g.appendChild(arc);
        }

        // ── Distance label at midpoint (perpendicular offset) ──
        const mx  = (a.x + b.x) / 2;
        const my  = (a.y + b.y) / 2;
        const OFF = 14 / zoom;
        const lx  = mx + Math.cos(perpAngle) * -OFF;
        const ly  = my + Math.sin(perpAngle) * -OFF;

        const distTxt = document.createElementNS(NS, 'text');
        distTxt.classList.add('measure-hud', 'measure-hud-dist');
        distTxt.setAttribute('x', lx); distTxt.setAttribute('y', ly);
        distTxt.setAttribute('text-anchor', 'middle');
        distTxt.setAttribute('font-size', 11 / zoom);
        distTxt.textContent = this._formatMeasureResult(dist);
        g.appendChild(distTxt);

        // ── Angle label + Δx / Δy (only on final placement) ──
        if (isFinal) {
            const angleDeg   = angle * 180 / Math.PI;
            const angleClass = this._classifyAngle(angleDeg);

            const angTxt = document.createElementNS(NS, 'text');
            angTxt.classList.add('measure-hud', 'measure-hud-angle');
            angTxt.setAttribute('x', a.x + 18 / zoom);
            angTxt.setAttribute('y', a.y - 9 / zoom);
            angTxt.setAttribute('font-size', 9 / zoom);
            angTxt.textContent = `${Math.abs(angleDeg).toFixed(1)}° ${angleClass}`;
            g.appendChild(angTxt);

            if (Math.abs(dx) > 2) {
                const dxTxt = document.createElementNS(NS, 'text');
                dxTxt.classList.add('measure-hud', 'measure-hud-delta');
                dxTxt.setAttribute('x', (a.x + b.x) / 2);
                dxTxt.setAttribute('y', Math.max(a.y, b.y) + 16 / zoom);
                dxTxt.setAttribute('text-anchor', 'middle');
                dxTxt.setAttribute('font-size', 9 / zoom);
                dxTxt.textContent = `Δx ${this._formatMeasureResult(Math.abs(dx))}`;
                g.appendChild(dxTxt);
            }
            if (Math.abs(dy) > 2) {
                const dyTxt = document.createElementNS(NS, 'text');
                dyTxt.classList.add('measure-hud', 'measure-hud-delta');
                dyTxt.setAttribute('x', Math.max(a.x, b.x) + 10 / zoom);
                dyTxt.setAttribute('y', (a.y + b.y) / 2 + 3 / zoom);
                dyTxt.setAttribute('font-size', 9 / zoom);
                dyTxt.textContent = `Δy ${this._formatMeasureResult(Math.abs(dy))}`;
                g.appendChild(dyTxt);
            }
        }
    },

    // ── Wire callout bubble (inline on wire path) ─────────────
    _drawMeasureCallout(x, y, distLabel, subLabel) {
        const NS   = this.SVG_NS || 'http://www.w3.org/2000/svg';
        const g    = this._ensureMeasureOverlay();
        const zoom = this.camera?.zoom || 1;
        const W = 88 / zoom, H = 20 / zoom;

        const bg = document.createElementNS(NS, 'rect');
        bg.classList.add('measure-callout-bg');
        bg.setAttribute('x', x - W / 2); bg.setAttribute('y', y - H - 4 / zoom);
        bg.setAttribute('width', W); bg.setAttribute('height', H);
        bg.setAttribute('rx', 3 / zoom);
        g.appendChild(bg);

        const txt = document.createElementNS(NS, 'text');
        txt.classList.add('measure-hud', 'measure-hud-dist');
        txt.setAttribute('x', x);
        txt.setAttribute('y', y - 8 / zoom);
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('font-size', 10 / zoom);
        txt.textContent = `${distLabel}  ·  ${subLabel}`;
        g.appendChild(txt);
    },

    // ── Clear all measure overlays from canvas ────────────────
    _clearMeasureTape() {
        const root = this._contentRoot || this.$svgDisplay?.[0];
        root?.querySelectorAll('.measure-overlay').forEach(el => el.remove());
        this._measureOverlay = null;
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
            const pointerId = await CwsBridge.requestStore(JSON.stringify(fsm), 'json-data');
            CwsBridge.offerData(CwsContracts.createEnvelope({
                pointer:     pointerId,
                contentType: 'json-data',
                metadata: {
                    source:      'schema-editor',
                    diagramName: fsm.name,
                    stateCount:  fsm.states.length,
                },
                hints: { suggestedTarget: 'tifany', action: 'load-fsm' },
            }));
            this._trackExport();
            this.showToast(`Sent ${fsm.states.length} states → TAFNE`, 'success');
        } catch (e) {
            this.showToast('Send failed: ' + e.message, 'error');
        }
    },
});
