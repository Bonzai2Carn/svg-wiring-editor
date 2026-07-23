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
                    // Count DISTINCT pins — two wires on one pin is still one connected pin
                    const connected = new Set(
                        (c.ports || []).map(p => p.pinId ?? `${p.x},${p.y}`)).size;
                    if (connected < spec.pinCount) {
                        const name = c.element?.getAttribute?.('data-refdes') || c.element?.id || c.id;
                        out.push({
                            message: `${symbol} "${name}": ${connected}/${spec.pinCount} pins connected`,
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
                    const ref = c.element?.getAttribute?.('data-refdes') ||
                                c.element?.querySelector?.('text.sym-refdes')?.textContent?.trim();
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

    // ── Connection-validity rules (separate pack, enabled when specs have pins) ──
    _CONNECTION_RULES: [
        {
            id: 'output-to-output', severity: 'error',
            check(ctx) {
                const findings = [];
                ctx.nets.forEach(n => {
                    const roles = {};
                    const compMap = {};
                    ctx.components.forEach(c => { compMap[c.id] = c; });
                    [...n.compIds].forEach(cid => {
                        const c = compMap[cid];
                        if (!c) return;
                        const sym = c.element?.getAttribute?.('data-symbol');
                        const specPins = sym && ctx.specs[sym]?.pins;
                        if (!specPins) return;
                        (c.ports || []).forEach(p => {
                            if (!n.wireIds.includes(p.wireId)) return;
                            const spec = specPins[p.pinId];
                            if (spec) roles[p.pinId + '@' + cid] = spec.role;
                        });
                    });
                    const outputs = Object.values(roles).filter(r => r === 'output');
                    if (outputs.length >= 2) {
                        findings.push({
                            message: `${n.id}: ${outputs.length} output pins on the same net (bus contention)`,
                            elementIds: n.wireIds.map(wid => ctx.wires.find(w => w.id === wid)?.element?.id).filter(Boolean),
                        });
                    }
                });
                return findings;
            },
        },
        {
            id: 'no-driver', severity: 'warning',
            check(ctx) {
                const findings = [];
                ctx.nets.forEach(n => {
                    const roles = {};
                    const compMap = {};
                    ctx.components.forEach(c => { compMap[c.id] = c; });
                    [...n.compIds].forEach(cid => {
                        const c = compMap[cid];
                        if (!c) return;
                        const sym = c.element?.getAttribute?.('data-symbol');
                        const specPins = sym && ctx.specs[sym]?.pins;
                        if (!specPins) return;
                        (c.ports || []).forEach(p => {
                            if (!n.wireIds.includes(p.wireId)) return;
                            const spec = specPins[p.pinId];
                            if (spec) roles[p.pinId + '@' + cid] = spec.role;
                        });
                    });
                    // A net is driverless only if it has input pins and NOTHING that
                    // could source current: no output/power/bidir, and no passive pin
                    // (a passive two-terminal part propagates a driver from its far pin,
                    // so its presence means drive can arrive — don't false-flag it).
                    const rvals = Object.values(roles);
                    const canDrive = rvals.some(r => r === 'output' || r === 'power' || r === 'bidir' || r === 'passive');
                    const hasInput = rvals.some(r => r === 'input');
                    if (hasInput && !canDrive) {
                        findings.push({
                            message: `${n.id}: no driver — only input pins on this net`,
                            elementIds: n.wireIds.map(wid => ctx.wires.find(w => w.id === wid)?.element?.id).filter(Boolean),
                        });
                    }
                });
                return findings;
            },
        },
        {
            id: 'signal-domain-mismatch', severity: 'warning',
            check(ctx) {
                const findings = [];
                ctx.nets.forEach(n => {
                    const types = {};
                    const compMap = {};
                    ctx.components.forEach(c => { compMap[c.id] = c; });
                    [...n.compIds].forEach(cid => {
                        const c = compMap[cid];
                        if (!c) return;
                        const sym = c.element?.getAttribute?.('data-symbol');
                        const specPins = sym && ctx.specs[sym]?.pins;
                        if (!specPins) return;
                        (c.ports || []).forEach(p => {
                            if (!n.wireIds.includes(p.wireId)) return;
                            const spec = specPins[p.pinId];
                            if (spec && spec.signalType) types[p.pinId + '@' + cid] = spec.signalType;
                        });
                    });
                    const vals = Object.values(types);
                    if (vals.includes('digital') && vals.includes('analog')) {
                        findings.push({
                            message: `${n.id}: digital and analog signal types on the same net`,
                            elementIds: n.wireIds.map(wid => ctx.wires.find(w => w.id === wid)?.element?.id).filter(Boolean),
                        });
                    }
                });
                return findings;
            },
        },
        {
            id: 'polarity-reversed', severity: 'warning',
            check(ctx) {
                const findings = [];
                ctx.nets.forEach(n => {
                    const polarities = {};
                    const compMap = {};
                    ctx.components.forEach(c => { compMap[c.id] = c; });
                    [...n.compIds].forEach(cid => {
                        const c = compMap[cid];
                        if (!c) return;
                        const sym = c.element?.getAttribute?.('data-symbol');
                        const specPins = sym && ctx.specs[sym]?.pins;
                        if (!specPins) return;
                        (c.ports || []).forEach(p => {
                            if (!n.wireIds.includes(p.wireId)) return;
                            const spec = specPins[p.pinId];
                            if (spec && spec.polarity) polarities[cid] = spec.polarity;
                        });
                    });
                    const vals = Object.values(polarities).filter(Boolean);
                    if (vals.length >= 2 && new Set(vals).size > 1) {
                        const names = [...n.compIds].map(cid => {
                            const c = compMap[cid];
                            return c?.element?.getAttribute?.('data-refdes') || cid;
                        });
                        findings.push({
                            message: `${n.id}: polarity mismatch on net (${names.join(' vs ')})`,
                            elementIds: n.wireIds.map(wid => ctx.wires.find(w => w.id === wid)?.element?.id).filter(Boolean),
                        });
                    }
                });
                return findings;
            },
        },
        {
            id: 'power-to-signal', severity: 'error',
            check(ctx) {
                const findings = [];
                ctx.nets.forEach(n => {
                    const roles = {};
                    const compMap = {};
                    ctx.components.forEach(c => { compMap[c.id] = c; });
                    [...n.compIds].forEach(cid => {
                        const c = compMap[cid];
                        if (!c) return;
                        const sym = c.element?.getAttribute?.('data-symbol');
                        const specPins = sym && ctx.specs[sym]?.pins;
                        if (!specPins) return;
                        (c.ports || []).forEach(p => {
                            if (!n.wireIds.includes(p.wireId)) return;
                            const spec = specPins[p.pinId];
                            if (spec) roles[p.pinId + '@' + cid] = spec.role;
                        });
                    });
                    const hasPower = Object.values(roles).some(r => r === 'power' || r === 'ground');
                    const hasSignalOutput = Object.values(roles).some(r => r === 'output');
                    if (hasPower && hasSignalOutput) {
                        findings.push({
                            message: `${n.id}: power/ground pin shorted to signal output`,
                            elementIds: n.wireIds.map(wid => ctx.wires.find(w => w.id === wid)?.element?.id).filter(Boolean),
                        });
                    }
                });
                return findings;
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
        // Connection-validity rules (requires COMPONENT_SPECS.pins)
        if (this._CONNECTION_RULES && ctx.specs && Object.values(ctx.specs).some(s => s.pins)) {
            this._CONNECTION_RULES.forEach(rule => {
                try {
                    rule.check(ctx).forEach(f => findings.push({ ...f, ruleId: rule.id, severity: rule.severity }));
                } catch (_) { /* one broken rule must not kill the run */ }
            });
        }
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
            `<tr><td style="padding:2px 6px">${r.qty}×</td><td style="padding:2px 6px">${r.refs?.join(' ') || r.symbol}</td>` +
            `<td style="padding:2px 6px">${r.symbol}</td><td style="padding:2px 6px">${r.value || '—'}</td></tr>`
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
                    <span>
                        <button id="ercBomCsvBtn" style="background:rgba(79,172,254,.18);border:1px solid rgba(79,172,254,.5);color:#9fd2ff;border-radius:5px;cursor:pointer;font-size:11px;padding:2px 8px">CSV</button>
                        <button id="ercBomTafneBtn" style="background:rgba(132,204,22,.18);border:1px solid rgba(132,204,22,.5);color:#d3f79f;border-radius:5px;cursor:pointer;font-size:11px;padding:2px 8px">→ TAFNE</button>
                    </span>
                </div>
                <table style="width:100%;margin-top:6px;border-collapse:collapse">${bomRows}</table>
            </div>`;
        document.body.appendChild(panel);

        panel.querySelector('#ercCloseBtn').addEventListener('click', () => panel.remove());
        panel.querySelector('#ercBomCsvBtn').addEventListener('click', () => this._downloadBomCsv(bom));
        panel.querySelector('#ercBomTafneBtn').addEventListener('click', () => {
            const specs = window.COMPONENT_SPECS || {};
            const tables = [{
                name: 'BOM',
                rows: bom.map(r => ({
                    qty: String(r.qty), symbol: r.symbol, value: r.value,
                    description: specs[r.symbol]?.description || '',
                    elements: r.ids.join(' '),
                })),
            }];
            if (findings.length) {
                tables.push({
                    name: 'Findings',
                    rows: findings.map(f => ({
                        severity: f.severity, rule: f.ruleId,
                        message: f.message, elements: f.elementIds.join(' '),
                    })),
                });
            }
            this.sendTablesToTafne(tables, 'design-check');
        });
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
            if (!groups.has(key)) groups.set(key, { symbol, value, qty: 0, ids: [], refs: [] });
            const g = groups.get(key);
            g.qty++;
            if (c.element?.id) g.ids.push(c.element.id);
            const ref = c.element?.getAttribute?.('data-refdes');
            if (ref) g.refs.push(ref);
        });
        return [...groups.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    },

    // ── Structured ERC (for AI consumption) ────────────────────
    // Returns findings as JSON, same logic as runErc but without rendering.
    runErcStructured() {
        if (!this.graph?.nets?.length && !this.components?.length) {
            return { findings: [], summary: 'no data' };
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
            } catch (_) {}
        });
        if (this._CONNECTION_RULES && ctx.specs && Object.values(ctx.specs).some(s => s.pins)) {
            this._CONNECTION_RULES.forEach(rule => {
                try {
                    rule.check(ctx).forEach(f => findings.push({ ...f, ruleId: rule.id, severity: rule.severity }));
                } catch (_) {}
            });
        }
        const errors = findings.filter(f => f.severity === 'error').length;
        const warnings = findings.filter(f => f.severity === 'warning').length;
        return { findings: findings, errorCount: errors, warningCount: warnings, total: findings.length };
    },

    _downloadBomCsv(bom) {
        const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
        const csv = ['Qty,Refs,Symbol,Value,Description,Elements']
            .concat(bom.map(r => [
                r.qty, esc(r.refs?.join(' ') || ''), esc(r.symbol), esc(r.value),
                esc(window.COMPONENT_SPECS?.[r.symbol]?.description || ''),
                esc(r.ids.join(' ')),
            ].join(',')))
            .join('\n');
        this._triggerDownload(csv, 'bom.csv', 'text/csv');
    },
});
