/* ============================================================
   Schematics Editor — ERC (Electrical Rule Check) + BOM
   Consumes the geometry pipeline's output (graph.nets, components,
   wires) plus COMPONENT_SPECS. Findings panel + BOM table.
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Rule pack ─────────────────────────────────────────────
    // Each rule: { id, severity: error|warning|info, check(ctx) → findings }
    // ctx = { nets, components, wires, specs }
    // finding = { message, elementIds: [domId, ...] }
    _ERC_RULES: [
        {
            id: 'unconnected-pin', severity: 'error',
            check(ctx) {
                const out = [];
                ctx.components.forEach(c => {
                    const symbol = c.element?.getAttribute?.('data-symbol');
                    const spec = symbol && ctx.specs[symbol];
                    if (!spec?.pinCount) return;
                    const connected = (c.ports || []).length;
                    if (connected < spec.pinCount) {
                        out.push({
                            message: `${symbol} "${c.element?.id || c.id}": ${connected}/${spec.pinCount} pins connected`,
                            elementIds: [c.element?.id].filter(Boolean),
                        });
                    }
                });
                return out;
            },
        },
        {
            id: 'floating-wire', severity: 'warning',
            check(ctx) {
                return ctx.nets
                    .filter(n => n.compIds.size === 0)
                    .map(n => ({
                        message: `Net ${n.id}: ${n.wireIds.length} wire(s) not connected to any component`,
                        elementIds: n.wireIds
                            .map(wid => ctx.wires.find(w => w.id === wid)?.element?.id)
                            .filter(Boolean),
                    }));
            },
        },
        {
            id: 'dangling-wire', severity: 'warning',
            check(ctx) {
                return ctx.nets
                    .filter(n => n.wireIds.length === 1 && n.compIds.size === 1)
                    .map(n => ({
                        message: `Net ${n.id}: wire has one end unconnected`,
                        elementIds: n.wireIds
                            .map(wid => ctx.wires.find(w => w.id === wid)?.element?.id)
                            .filter(Boolean),
                    }));
            },
        },
        {
            id: 'duplicate-refdes', severity: 'error',
            check(ctx) {
                const byRef = new Map();
                ctx.components.forEach(c => {
                    const ref = c.element?.querySelector?.('text.sym-value')?.textContent?.trim();
                    if (!ref) return;
                    if (!byRef.has(ref)) byRef.set(ref, []);
                    byRef.get(ref).push(c);
                });
                return [...byRef.entries()]
                    .filter(([, comps]) => comps.length > 1)
                    .map(([ref, comps]) => ({
                        message: `Duplicate designator "${ref}" on ${comps.length} components`,
                        elementIds: comps.map(c => c.element?.id).filter(Boolean),
                    }));
            },
        },
        {
            id: 'missing-value', severity: 'info',
            check(ctx) {
                return ctx.components.filter(c => {
                    const symbol = c.element?.getAttribute?.('data-symbol');
                    if (!symbol || !ctx.specs[symbol]?.keyParams?.length) return false;
                    return !c.element?.querySelector?.('text.sym-value')?.textContent?.trim();
                }).map(c => ({
                    message: `${c.element?.getAttribute?.('data-symbol')} "${c.element?.id || c.id}" has no value/designator`,
                    elementIds: [c.element?.id].filter(Boolean),
                }));
            },
        },
        {
            id: 'power-short', severity: 'error',
            check(ctx) {
                const isPower  = (s) => /vcc|vdd|power|v\+|battery/i.test(s || '');
                const isGround = (s) => /gnd|ground|earth/i.test(s || '');
                return ctx.nets.filter(n => {
                    const syms = [...n.compIds].map(id =>
                        ctx.components.find(c => c.id === id)?.element?.getAttribute?.('data-symbol'));
                    return syms.some(isPower) && syms.some(isGround);
                }).map(n => ({
                    message: `Net ${n.id} connects power directly to ground`,
                    elementIds: n.wireIds
                        .map(wid => ctx.wires.find(w => w.id === wid)?.element?.id)
                        .filter(Boolean),
                }));
            },
        },
    ],

    // ── Run + panel ───────────────────────────────────────────
    runErc() {
        if (!this.graph?.nets?.length && !this.components?.length) {
            this.showToast('Nothing analyzed yet — add components and wires first', 'error');
            return;
        }
        const ctx = {
            nets:       this.graph?.nets || [],
            components: (this.components || []).filter(c => c.element?.isConnected),
            wires:      (this.wires || []).filter(w => w.element?.isConnected),
            specs:      window.COMPONENT_SPECS || {},
        };
        const findings = [];
        this._ERC_RULES.forEach(rule => {
            try {
                rule.check(ctx).forEach(f => findings.push({ ...f, ruleId: rule.id, severity: rule.severity }));
            } catch (_) { /* one broken rule must not kill the run */ }
        });
        this._renderErcPanel(findings, ctx);
    },

    _renderErcPanel(findings, ctx) {
        document.getElementById('ercPanel')?.remove();
        const panel = document.createElement('div');
        panel.id = 'ercPanel';
        panel.style.cssText =
            'position:fixed;top:70px;right:12px;width:320px;max-height:70vh;overflow-y:auto;' +
            'background:rgba(18,22,30,.96);color:#dfe6ee;border:1px solid rgba(255,255,255,.14);' +
            'border-radius:10px;padding:12px;font-size:12px;z-index:950;';

        const order  = { error: 0, warning: 1, info: 2 };
        const icons  = { error: '⛔', warning: '⚠️', info: 'ℹ️' };
        findings.sort((a, b) => order[a.severity] - order[b.severity]);

        const counts = findings.reduce((m, f) => (m[f.severity] = (m[f.severity] || 0) + 1, m), {});
        const rows = findings.map((f, i) =>
            `<div class="erc-row" data-idx="${i}" style="padding:6px 8px;margin:2px 0;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.04);">
                ${icons[f.severity]} <span style="opacity:.65">[${f.ruleId}]</span> ${f.message}
            </div>`
        ).join('') || '<div style="padding:8px;opacity:.7">✓ No issues found</div>';

        const bom = this.buildBom(ctx);
        const bomRows = bom.map(r =>
            `<tr><td style="padding:2px 6px">${r.qty}×</td><td style="padding:2px 6px">${r.symbol}</td>` +
            `<td style="padding:2px 6px">${r.value || '—'}</td></tr>`
        ).join('');

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong>Design check</strong>
                <span style="opacity:.7">${counts.error || 0} errors · ${counts.warning || 0} warnings</span>
                <button id="ercCloseBtn" style="background:none;border:none;color:inherit;cursor:pointer;font-size:14px">×</button>
            </div>
            ${rows}
            <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,.12);padding-top:8px">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <strong>BOM (${bom.length} line items)</strong>
                    <button id="ercBomCsvBtn" style="background:rgba(79,172,254,.18);border:1px solid rgba(79,172,254,.5);color:#9fd2ff;border-radius:5px;cursor:pointer;font-size:11px;padding:2px 8px">CSV</button>
                </div>
                <table style="width:100%;margin-top:6px;border-collapse:collapse">${bomRows}</table>
            </div>`;
        document.body.appendChild(panel);

        panel.querySelector('#ercCloseBtn').addEventListener('click', () => panel.remove());
        panel.querySelector('#ercBomCsvBtn').addEventListener('click', () => this._downloadBomCsv(bom));
        panel.querySelectorAll('.erc-row').forEach(row => {
            row.addEventListener('click', () => {
                this.clearAllHighlights?.();
                const f = findings[+row.dataset.idx];
                f.elementIds.forEach(id => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    el.classList.add(el.getAttribute('data-geo-class') === 'wire' || el.tagName === 'path'
                        ? 'wire-trace' : 'component-highlight');
                });
            });
        });
    },

    // ── BOM ───────────────────────────────────────────────────
    buildBom(ctx) {
        const comps = ctx.components;
        const groups = new Map();
        comps.forEach(c => {
            const symbol = c.element?.getAttribute?.('data-symbol');
            if (!symbol) return;   // heuristic blobs stay out of the BOM
            const value = c.element?.querySelector?.('text.sym-value')?.textContent?.trim() || '';
            const key = `${symbol} ${value}`;
            if (!groups.has(key)) groups.set(key, { symbol, value, qty: 0, ids: [] });
            const g = groups.get(key);
            g.qty++;
            if (c.element?.id) g.ids.push(c.element.id);
        });
        return [...groups.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    },

    _downloadBomCsv(bom) {
        const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
        const csv = ['Qty,Symbol,Value,Description,Elements']
            .concat(bom.map(r => [
                r.qty, esc(r.symbol), esc(r.value),
                esc(window.COMPONENT_SPECS?.[r.symbol]?.description || ''),
                esc(r.ids.join(' ')),
            ].join(',')))
            .join('\n');
        this._triggerDownload(csv, 'bom.csv', 'text/csv');
    },
});
