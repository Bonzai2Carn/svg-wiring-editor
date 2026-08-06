/* ============================================================
   Schematics Editor — Analysis Labels
   ------------------------------------------------------------
   Turns the geometry analysis from an invisible pass into something
   you can see and argue with.

   Toggling Labels runs the geometry pipeline and then puts a chip on
   every analyzed element showing what the analysis decided it is
   (wire / component / module / connector / junction). The chip is a
   dropdown: pick a different class and the element is reclassified.

   The point is not the label, it is the PROVENANCE. Three different
   things can decide what an element is, and after the fact you need to
   be able to tell them apart:

       blue    the deterministic recognizer classified it from an
               explicit label. Ground truth.
       amber   the recognizer INFERRED it from raw geometry. A guess,
               and the thing most worth confirming.
       green   a human corrected it.
       violet  the AI driver placed or relabelled it.

   A correction also records what the recognizer had said, so the
   document accumulates model-said-X / truth-was-Y pairs as a
   by-product of ordinary use.

   This file is the VIEW. Scoring, the ranking rule (a human
   correction outranks a later engine re-run) and the correction
   corpus come from `window.GxSchemaTags`, an optional capability the
   host may supply. Every call to it is behind a presence guard, so a
   standalone build still gets working labels and a working dropdown,
   just without the provenance layer.

   Chips are positioned in SCREEN space over the canvas, not in SVG,
   for the same reason the selection handles are: SVG scales
   infinitely and a label that scales with it is unreadable at both
   ends of the zoom range.
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // The classes a user can assign. 'ink' is deliberately offered: marking a
    // stray path as decoration is the single most common correction on an
    // imported drawing, and it removes the element from the netlist.
    _LABEL_CLASSES: ['wire', 'component', 'module', 'connector', 'junction', 'ink'],

    _LABEL_COLORS: {
        wire:      '#4facfe',
        component: '#94a3b8',
        module:    '#34d399',
        connector: '#a78bfa',
        junction:  '#fbbf24',
        ink:       '#64748b',
    },

    // Chips sit on top of the drawing, so they compete with it for space. A
    // schematic can carry hundreds, and "component" spelled out buries the very
    // thing it is annotating. Shortcodes keep the overlay readable; the full
    // word is one hover away in the tooltip and spelled out in the dropdown.
    _LABEL_CODES: {
        wire:      'WR',
        component: 'CMP',
        module:    'MOD',
        connector: 'CON',
        junction:  'JNC',
        ink:       'INK',
    },

    _labelCode(cls) {
        return this._LABEL_CODES[cls] || (cls || '?').slice(0, 3).toUpperCase();
    },

    // Chip tint by who decided. Mirrors GxSchemaTags.SOURCES.
    _LABEL_SOURCE_STYLE: {
        'internal-draw': { tint: '#4facfe', mark: '',  title: 'Deterministic analysis' },
        'pdf-extract':   { tint: '#f5a623', mark: '?', title: 'Recognized from an imported artifact' },
        'measured':      { tint: '#4facfe', mark: '',  title: 'Measured' },
        'user-confirm':  { tint: '#34d399', mark: '✓', title: 'Confirmed by you' },
        'ai-driver':     { tint: '#c084fc', mark: '✦', title: 'Placed by the AI driver' },
    },

    initLabels() {
        this._labelsOn = false;
        this._labelChips = [];
    },

    // Presence guard in one place so no call site has to repeat it.
    get _tags() { return window.GxSchemaTags || null; },

    // ── Toggle ────────────────────────────────────────────────

    toggleLabels() {
        this._labelsOn = !this._labelsOn;
        $('#labelsBtn').toggleClass('active', this._labelsOn);

        if (!this._labelsOn) {
            this._destroyLabelLayer();
            this.showToast('Labels off', 'success');
            return;
        }

        // Labels are a view of the analysis, so the analysis has to have run.
        if (typeof this._runGeometryPipeline === 'function') this._runGeometryPipeline();
        this._stampAnalysisTags();
        this._renderLabels();

        const n = this._labelChips.length;
        if (!n) {
            this.showToast('Nothing analyzed yet — draw something or load an SVG', 'error');
            return;
        }
        const s = this._tags?.provenanceSummary?.(this._contentRoot);
        const inferred = s ? (s['pdf-extract'] || 0) : 0;
        this.showToast(
            `Labels on — ${n} element${n > 1 ? 's' : ''} analyzed` +
            (inferred ? `, ${inferred} inferred and worth confirming` : '') +
            '. Click a chip to reclassify.', 'success');
    },

    // ── Recording what the analysis decided ───────────────────

    // Every element the pipeline classified gets a `class` tag. An element
    // carrying an explicit data-geo-class was labelled by the drawing tool or a
    // human and bypassed the heuristics, so it is ground truth; anything the
    // recognizer had to infer from raw geometry is a guess and is scored as one.
    // The no-overwrite rule lives in the injected policy, not here.
    _stampAnalysisTags() {
        const tags = this._tags;
        if (!tags?.tagAnalysis) return;   // standalone fork: chips still work, no provenance

        this._analyzedElements().forEach(({ el, cls, inferred }) => {
            tags.tagAnalysis(el, cls, {
                inferred,
                source: inferred ? tags.SOURCES.PDF_EXTRACT : tags.SOURCES.INTERNAL_DRAW,
            });
        });
    },

    /**
     * The elements the analysis has an opinion about, with the class it
     * decided and whether that was inferred rather than read off a label.
     * Drives both the tag stamping and the chip rendering, so the chips
     * cannot disagree with what was recorded.
     */
    _analyzedElements() {
        const out = [];
        const seen = new Set();
        const root = this._contentRoot;
        if (!root) return out;

        const push = (el, cls, inferred) => {
            if (!el || !el.isConnected || seen.has(el)) return;
            if (el.dataset?.seSystem === 'true') return;
            if (el.classList?.contains('wire-hitbox') ||
                el.classList?.contains('component-hitbox')) return;
            seen.add(el);
            out.push({ el, cls, inferred });
        };

        // Explicitly tagged — the recognizer took these at their word.
        root.querySelectorAll('[data-geo-class]').forEach(el =>
            push(el, el.getAttribute('data-geo-class'), false));

        // Placed symbols without an explicit override are modules by label.
        root.querySelectorAll('[data-symbol]').forEach(el =>
            push(el, el.getAttribute('data-geo-class') || 'module', false));

        // Whatever the geometry pipeline worked out for itself. These carry no
        // label, so the class is a heuristic result and is marked inferred.
        (this.wires || []).forEach(w => push(w.element, 'wire', true));
        (this.components || []).forEach(c => push(c.element, c.type || 'component', true));
        (this.connectors || []).forEach(c => push(c.element, 'connector', true));

        return out;
    },

    /**
     * THE shared analysis index. One list, read by the Labels chips, ERC, the
     * netlist/BOM payload, the highlight tools and the Artifacts panel.
     *
     *   Before this existed, the ecosystem had two sources of truth and each
     *   consumer picked one. `data-geo-class` says what KIND of thing an element
     *   is and drives the geometry pipeline; `data-symbol` says what it
     *   SPECIFICALLY is and drives COMPONENT_SPECS. Reclassifying wrote the
     *   first and not the second, so Layers and Inspect followed the edit while
     *   ERC's pin rules skipped the element, BOM listed it as "unknown", and the
     *   Artifacts panel (which queried `[data-symbol]` alone) could not see it.
     *
     * Each row: { el, id, cls, symbol, inferred, source, score, corrected }
     *   cls    — the class in force, after any user correction
     *   symbol — the semantic label, or null. `cls` without `symbol` is the
     *            actionable gap: we know it is a component, not which one.
     */
    analysisIndex() {
        return this._analyzedElements().map(({ el, cls, inferred }) => {
            const prov = this._tags?.provenanceOf?.(el) || null;
            return {
                el,
                id: el.id || null,
                cls: prov?.cls || cls,
                symbol: el.getAttribute?.('data-symbol') || null,
                refdes: el.getAttribute?.('data-refdes') ||
                        el.querySelector?.('text.sym-value')?.textContent?.trim() || null,
                inferred,
                source: prov?.source || 'internal-draw',
                score: prov?.score != null ? prov.score : 1.0,
                corrected: !!prov?.corrected,
            };
        });
    },

    // Elements the analysis calls a component/module but cannot name. These are
    // the ones BOM lists as "unknown" and every spec-driven ERC rule skips.
    unnamedComponents() {
        return this.analysisIndex().filter(r =>
            (r.cls === 'component' || r.cls === 'module') && !r.symbol);
    },

    // Anything downstream of the analysis has to be told when the analysis
    // changed, or it keeps showing a result computed against the old classes.
    _invalidateAnalysisConsumers() {
        // ERC findings are computed on demand; if the panel is open it is now
        // showing conclusions about classes that no longer exist.
        if ($('#ercPanel').hasClass('open') && typeof this.runErc === 'function') {
            this.runErc();
        }
        // The Artifacts panel enumerates artifacts from the DOM (root-injected).
        window.GxArtifactsPanel?.refresh?.();
        // Live highlight overlays are keyed on the old component/wire sets.
        if (typeof this.clearAllHighlights === 'function' && this._highlightActive) {
            this.clearAllHighlights();
        }
        if (typeof this.buildLayersTree === 'function') this.buildLayersTree();
    },

    // ── Screen-space chip layer ───────────────────────────────

    _labelLayer() {
        let layer = document.getElementById('gxLabelLayer');
        if (!layer) {
            layer = document.createElement('div');
            layer.id = 'gxLabelLayer';
            layer.className = 'gx-label-layer';
            this.$svgContainer[0].appendChild(layer);
        }
        return layer;
    },

    _destroyLabelLayer() {
        document.getElementById('gxLabelLayer')?.remove();
        this._closeLabelMenu();
        this._labelChips = [];
    },

    // Reading the chips tells you what each element is. The legend tells you the
    // thing the whole feature exists for: how much of this drawing the machine
    // decided versus how much a human did.
    _renderLabelLegend(layer) {
        const s = this._tags?.provenanceSummary?.(this._contentRoot);
        const bar = document.createElement('div');
        bar.className = 'gx-label-legend';

        if (!s) {
            // Standalone fork: no provenance layer, so say so rather than
            // showing counts that would all be zero.
            bar.innerHTML = `<span class="gx-legend-item">Classes shown · provenance layer not loaded</span>`;
            layer.appendChild(bar);
            return;
        }

        const rows = [
            ['internal-draw', 'deterministic'],
            ['pdf-extract',   'inferred'],
            ['user-confirm',  'user'],
            ['ai-driver',     'AI'],
        ].filter(([k]) => s[k]);

        bar.innerHTML = rows.map(([k, label]) => {
            const st = this._LABEL_SOURCE_STYLE[k];
            return `<span class="gx-legend-item" title="${st.title}">` +
                   `<i style="background:${st.tint}"></i>${s[k]} ${label}</span>`;
        }).join('');

        if (s.corrected) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'gx-legend-export';
            btn.textContent = `${s.corrected} corrected ↓`;
            btn.title = 'Export the corrections as model-said / truth-was pairs';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.exportCorrectionCorpus();
            });
            bar.appendChild(btn);
        }

        layer.appendChild(bar);
    },

    _renderLabels() {
        if (!this._labelsOn) return;
        const layer = this._labelLayer();
        layer.innerHTML = '';
        this._labelChips = [];
        this._renderLabelLegend(layer);

        this._analyzedElements().forEach(({ el, cls }) => {
            const prov = this._tags?.provenanceOf?.(el);
            const shown = prov?.cls || cls;
            const source = prov?.source || 'internal-draw';
            const style = this._LABEL_SOURCE_STYLE[source] || this._LABEL_SOURCE_STYLE['internal-draw'];

            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'gx-label-chip';
            chip.style.setProperty('--chip', this._LABEL_COLORS[shown] || '#94a3b8');
            chip.style.setProperty('--src', style.tint);
            chip.dataset.source = source;

            const pct = prov && prov.score != null && prov.score < 0.999
                ? ` ${Math.round(prov.score * 100)}%` : '';
            chip.innerHTML =
                `<span class="gx-label-dot"></span>` +
                `<span class="gx-label-text">${this._labelCode(shown)}${pct}</span>` +
                (style.mark ? `<span class="gx-label-mark">${style.mark}</span>` : '');

            const bits = [`${shown}`, style.title];
            if (prov?.score != null) bits.push(`confidence ${Math.round(prov.score * 100)}%`);
            if (prov?.corrected) {
                const last = prov.corrections[prov.corrections.length - 1];
                bits.push(`corrected from "${last.said}"`);
            }
            chip.title = bits.join('  ·  ') + '\nClick to reclassify';

            // A chip is only useful if you can tell WHICH element it is talking
            // about. Hover previews it, click commits: selects the element so the
            // handles and property panel follow, and flashes it so the eye lands
            // on the right shape before the dropdown opens over the top.
            chip.addEventListener('mouseenter', () => this._peekLabelTarget(el, true));
            chip.addEventListener('mouseleave', () => this._peekLabelTarget(el, false));
            chip.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this._focusLabelTarget(el);
                this._openLabelMenu(el, shown, chip);
            });

            layer.appendChild(chip);
            this._labelChips.push({ el, chip });
        });

        this._positionLabels();
    },

    // ── Showing which element a chip belongs to ───────────────

    _peekLabelTarget(el, on) {
        if (!el?.classList) return;
        el.classList.toggle('gx-label-peek', !!on);
    },

    // Is the element inside the visible viewport right now?
    _isElementOnScreen(el) {
        try {
            const r = el.getBoundingClientRect();
            const c = this.$svgContainer[0].getBoundingClientRect();
            return r.right > c.left && r.left < c.right &&
                   r.bottom > c.top && r.top < c.bottom;
        } catch (_) { return true; }   // unknown: do not yank the camera
    },

    _focusLabelTarget(el) {
        if (!el?.isConnected) return;
        this._peekLabelTarget(el, false);
        // Real selection, not just a glow: handles appear, the property panel
        // fills in, and the element is ready to act on. Only fly if it is
        // actually off-screen — a chip you just clicked is usually right there,
        // and moving the camera under the pointer would be disorienting.
        this.selectEl(el);
        if (!this._isElementOnScreen?.(el)) this.flyToElement?.(el);
        el.classList.add('gx-label-flash');
        setTimeout(() => el.classList?.remove('gx-label-flash'), 700);
    },

    // Chips are re-projected on every camera change AND on every geometry
    // change, so this runs inside drag loops. One pass per frame, no more.
    _schedulePositionLabels() {
        if (!this._labelsOn || this._labelPosRaf) return;
        this._labelPosRaf = requestAnimationFrame(() => {
            this._labelPosRaf = null;
            this._positionLabels();
        });
    },

    // Project each element's bbox to screen space and park its chip at the
    // top-left corner. Chips outside the viewport are hidden rather than
    // removed so a pan does not have to rebuild the layer.
    _positionLabels() {
        if (!this._labelsOn || !this._labelChips.length) return;
        const svg = this.$svgDisplay[0];
        const rotGrp = svg.querySelector('#_cameraRotGroup');
        const ctm = rotGrp ? rotGrp.getScreenCTM() : svg.getScreenCTM();
        if (!ctm) return;
        const box = this.$svgContainer[0].getBoundingClientRect();
        const pt = svg.createSVGPoint();

        this._labelChips.forEach(({ el, chip }) => {
            if (!el.isConnected) { chip.style.display = 'none'; return; }
            let bb;
            try { bb = el.getBBox(); } catch (_) { chip.style.display = 'none'; return; }

            // element-local → document-local, then document-local → screen
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
            const doc = new DOMPoint(bb.x, bb.y).matrixTransform(m);
            pt.x = doc.x; pt.y = doc.y;
            const sp = pt.matrixTransform(ctm);

            const x = sp.x - box.left;
            const y = sp.y - box.top;
            const pad = 60;
            if (x < -pad || y < -pad || x > box.width + pad || y > box.height + pad) {
                chip.style.display = 'none';
                return;
            }
            chip.style.display = '';
            chip.style.left = `${x}px`;
            chip.style.top  = `${y - 20}px`;
        });
    },

    // ── Reclassify dropdown ───────────────────────────────────

    _openLabelMenu(el, current, chip) {
        this._closeLabelMenu();
        const menu = document.createElement('div');
        menu.className = 'gx-label-menu';
        menu.id = 'gxLabelMenu';

        this._LABEL_CLASSES.forEach(cls => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'gx-label-menu-item' + (cls === current ? ' is-current' : '');
            item.innerHTML =
                `<span class="gx-label-dot" style="--chip:${this._LABEL_COLORS[cls]}"></span>` +
                `<b class="gx-menu-code">${this._labelCode(cls)}</b>${cls}`;
            item.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._closeLabelMenu();
                if (cls !== current) this._reclassify(el, cls);
            });
            menu.appendChild(item);
        });

        const r = chip.getBoundingClientRect();
        menu.style.left = `${r.left}px`;
        menu.style.top  = `${r.bottom + 4}px`;
        document.body.appendChild(menu);

        // Defer so this click does not immediately close the menu it opened
        setTimeout(() => {
            this._labelMenuAway = (ev) => {
                if (!menu.contains(ev.target)) this._closeLabelMenu();
            };
            document.addEventListener('mousedown', this._labelMenuAway, true);
        }, 0);
    },

    _closeLabelMenu() {
        document.getElementById('gxLabelMenu')?.remove();
        if (this._labelMenuAway) {
            document.removeEventListener('mousedown', this._labelMenuAway, true);
            this._labelMenuAway = null;
        }
    },

    // A correction is an edit to the document: it changes what the netlist
    // contains, so it goes through history like any other edit.
    _reclassify(el, cls) {
        const before = this._captureFullState();
        const prev = el.getAttribute('data-geo-class');

        el.setAttribute('data-geo-class', cls);
        this._tags?.confirmClass?.(el, cls);

        if (typeof this._runGeometryPipeline === 'function') this._runGeometryPipeline();
        this.pushHistory('Reclassify', before, this._captureFullState());

        this._renderLabels();
        this._invalidateAnalysisConsumers();
        this.showToast(prev && prev !== cls
            ? `Reclassified: ${prev} → ${cls}`
            : `Classified as ${cls}`, 'success');
    },

    // ── Corrections made in this document ─────────────────────
    // The by-product that matters: every correction is a graded example of
    // where the recognizer was wrong.
    exportCorrectionCorpus() {
        const corpus = this._tags?.correctionCorpus?.(this._contentRoot) || [];
        if (!corpus.length) {
            this.showToast('No corrections recorded yet', 'error');
            return;
        }
        const name = this.displays?.[this.activeDisplayIdx]?.name || 'diagram';
        this._triggerDownload(
            JSON.stringify({ document: name, generated: new Date().toISOString(), corrections: corpus }, null, 2),
            `${name.replace(/\.[^.]+$/, '')}-corrections.json`,
            'application/json');
        this.showToast(`Exported ${corpus.length} correction${corpus.length > 1 ? 's' : ''}`, 'success');
    },
});
