#!/usr/bin/env node
/* ============================================================
   Schematics Editor — real-parts regression harness (DSPE §07 fork)

   architecture/design-knowledge.md's §0 proof used a `define_ic`
   current-sensor as a stand-in for a fuse, because the kit had no real
   fuse/relay/motor/pump symbols — only the generic enclosure route could
   reach them. This session added those four to the catalog itself
   (assets/schema-editor/dsp/catalog.js + component-specs.js), so this
   harness re-runs the SAME two user requests ("a remote that lights up
   when a fuse goes over 300kW", "a quick schematic to control a water
   pump") using the real catalog parts an end user actually drags onto
   the canvas — not an AI-authored substitute.

   Three things this proves that check-knowledge.cjs's fabricated fixtures
   cannot:
     1. GxDspe.buildSymbols()/buildSpecs() actually produce a drawable
        'fuse'/'motor'/'pump'/'relay' symbol with a real component-specs.js
        entry behind it (not just a catalog record that never reaches ERC).
     2. component-value-mismatch's existing fuse->current keyword fallback
        (units.js CATEGORY_KEYWORDS) fires on the REAL symbol id, not a
        hand-typed description string.
     3. relay's 5-pin coil is honestly reported as an unchecked candidate
        (knowledgeCoverage), not silently skipped or falsely cleared —
        the same coverage discipline every other rule in this codebase
        already has to keep.

   Run: node scripts/check-real-parts.cjs
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(__dirname, '..', 'src', 'js', 'features');
const DSP_DIR = path.join(ROOT, 'assets', 'schema-editor', 'dsp');

const failures = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) failures.push(msg); };

// ── real DSPE catalog (grammar/topology/render/catalog/dsp) ─────
['grammar', 'topology', 'render', 'catalog', 'dsp']
    .forEach((f) => require(path.join(DSP_DIR, f + '.js')));
const GxDspe = globalThis.GxDspe;

// ── real ERC/knowledge/bus engines + real hand-written specs ────
global.MobileSVGEditor = function MobileSVGEditor() {};
global.window = global;
global.document = { getElementById: () => null, createElement: () => ({ style: {} }) };
new Function('window', fs.readFileSync(
    path.join(ROOT, 'assets', 'schema-editor', 'data', 'component-specs.js'), 'utf8'))(global);
const REAL_SPECS = global.window.COMPONENT_SPECS;
new Function('window', fs.readFileSync(path.join(SRC, 'units.js'), 'utf8'))(global);
new Function('MobileSVGEditor', 'window', 'document',
    fs.readFileSync(path.join(SRC, 'ercEngine.js'), 'utf8'))(global.MobileSVGEditor, global, global.document);
new Function('MobileSVGEditor', 'window', 'document',
    fs.readFileSync(path.join(SRC, 'knowledgeEngine.js'), 'utf8'))(global.MobileSVGEditor, global, global.document);
new Function('MobileSVGEditor', 'window', 'document',
    fs.readFileSync(path.join(SRC, 'busEngine.js'), 'utf8'))(global.MobileSVGEditor, global, global.document);

// ── real layout planner (electrical strategy) ────────────────────
const G = {}; G.window = G; G.globalThis = G; G.GxDspe = GxDspe;
['assets/os/scene.js', 'assets/schema-editor/ai/arrange.js', 'assets/schema-editor/ai/layoutPlanner.js']
    .forEach((rel) => new Function('globalThis', 'window', 'self',
        'with (globalThis) {' + fs.readFileSync(path.join(ROOT, rel), 'utf8') + '}').call(G, G, G, G));

// ── one place to turn a small op list into a real ERC run ────────
function buildEditor(ops, values) {
    const kit = { symbols: GxDspe.buildSymbols() };
    const planned = G.GxLayoutPlanner.plan(ops, kit, 'electrical');
    const placed = planned.ops.filter((o) => o.op === 'place_component');

    const compById = {};
    const comps = placed.map((o) => {
        const value = values && values[o.ref];
        const c = {
            id: o.ref, ports: [],
            element: {
                id: 'el_' + o.ref, isConnected: true,
                _a: { 'data-symbol': o.symbol, 'data-refdes': o.ref },
                getAttribute(k) { return this._a[k] != null ? this._a[k] : null; },
                querySelector(sel) { return sel === 'text.sym-value' && value ? { textContent: value } : null; },
                querySelectorAll(sel) {
                    return sel === '.pin-point'
                        ? new Array((REAL_SPECS[o.symbol] && REAL_SPECS[o.symbol].pinCount) || 2).fill({})
                        : [];
                },
            },
        };
        compById[o.ref] = c;
        return c;
    });
    // Net-merging union: a pin that fans out to more than one wire (e.g. a
    // VCC rail feeding both a load and a flyback diode) must land all of
    // those wires on the SAME net, or a rule that checks "does the diode
    // bridge the load's exact two nets" sees two different single-wire
    // nets and never matches — a real false negative in the harness, not
    // the engine. netOfPin tracks the live net object per compId|pinId so
    // a second connect on an already-wired pin extends or merges rather
    // than creating an isolated net.
    let wireN = 0, netN = 0;
    const nets = [];
    const netOfPin = new Map();
    planned.ops.filter((o) => o.op === 'connect').forEach((o) => {
        const wid = 'w' + (++wireN);
        const a = compById[o.from_ref], b = compById[o.to_ref];
        const aPin = String(o.from_pin), bPin = String(o.to_pin);
        a.ports.push({ compId: a.id, wireId: wid, pinId: aPin });
        b.ports.push({ compId: b.id, wireId: wid, pinId: bPin });

        const aKey = `${a.id}|${aPin}`, bKey = `${b.id}|${bPin}`;
        let net = netOfPin.get(aKey) || netOfPin.get(bKey);
        if (!net) {
            net = { id: 'net' + (++netN), wireIds: [], compIds: new Set() };
            nets.push(net);
        }
        const other = netOfPin.get(aKey) === net ? netOfPin.get(bKey) : netOfPin.get(aKey);
        if (other && other !== net) {
            other.wireIds.forEach((w) => net.wireIds.push(w));
            other.compIds.forEach((c) => net.compIds.add(c));
            netOfPin.forEach((v, k) => { if (v === other) netOfPin.set(k, net); });
            nets.splice(nets.indexOf(other), 1);
        }
        net.wireIds.push(wid);
        net.compIds.add(a.id); net.compIds.add(b.id);
        netOfPin.set(aKey, net); netOfPin.set(bKey, net);
    });

    const ed = new global.MobileSVGEditor();
    global.window.COMPONENT_SPECS = REAL_SPECS;
    ed.graph = { nets, edges: new Map(), adjacency: new Map() };
    ed.components = comps; ed.wires = [];
    return ed;
}

// ================================================================
// 1. The catalog additions are real: drawable, specced, ERC-visible.
// ================================================================
['fuse', 'motor', 'pump', 'relay'].forEach((id) => {
    check(!!GxDspe.catalog[id], `catalog has no "${id}" record`);
    check(!!REAL_SPECS[id], `component-specs.js has no "${id}" entry`);
    if (GxDspe.catalog[id] && REAL_SPECS[id]) {
        const genKeys = Object.keys(GxDspe.specFor(id).pins).sort();
        const specKeys = Object.keys(REAL_SPECS[id].pins).sort();
        check(JSON.stringify(genKeys) === JSON.stringify(specKeys),
            `${id}: DSPE-derived pin keys [${genKeys}] != component-specs.js [${specKeys}]`);
    }
});
const fuseSym = GxDspe.buildSymbols().find((s) => s.id === 'fuse');
check(!!fuseSym && fuseSym.svgContent.includes('pin-point'), 'fuse symbol did not render any pins');
const relaySym = GxDspe.buildSymbols().find((s) => s.id === 'relay');
check(!!relaySym && (relaySym.svgContent.match(/pin-point/g) || []).length === 5,
    `relay symbol should render 5 pins, got ${relaySym ? (relaySym.svgContent.match(/pin-point/g) || []).length : 'no symbol'}`);

// ================================================================
// 2. REQUEST 1, real parts: "a remote that lights up when a fuse goes
//    over 300kW" — VCC -> FUSE -> LED -> GND, no current-sensor stand-in.
// ================================================================
function fuseCircuit(fuseValue) {
    return buildEditor([
        { op: 'place_component', ref: 'VCC1', symbol: 'vcc' },
        { op: 'place_component', ref: 'F1', symbol: 'fuse' },
        { op: 'place_component', ref: 'D1', symbol: 'led' },
        { op: 'place_component', ref: 'R1', symbol: 'resistor' },
        { op: 'place_component', ref: 'GND1', symbol: 'gnd' },
        { op: 'connect', from_ref: 'VCC1', from_pin: '0', to_ref: 'F1', to_pin: '0' },
        { op: 'connect', from_ref: 'F1', from_pin: '1', to_ref: 'R1', to_pin: '0' },
        { op: 'connect', from_ref: 'R1', from_pin: '1', to_ref: 'D1', to_pin: '0' },
        { op: 'connect', from_ref: 'D1', from_pin: '1', to_ref: 'GND1', to_pin: '0' },
    ], { F1: fuseValue, R1: '330' });
}

{
    const r = fuseCircuit('300kW').runErcStructured();
    const f = r.findings.find((x) => x.ruleId === 'component-value-mismatch' && x.message.includes('F1'));
    check(!!f, 'a fuse valued "300kW" produced no component-value-mismatch finding');
    check(f && f.severity === 'error', 'fuse "300kW" (a power quantity, not current) should be error, not warning');
    check(f && /power/.test(f.message) && /current/.test(f.message),
        `finding message should name got=power/expected=current, got: ${f && f.message}`);
}
{
    const r = fuseCircuit('1A').runErcStructured();
    const f = r.findings.find((x) => x.ruleId === 'component-value-mismatch' && x.message.includes('F1'));
    check(!f, `a fuse correctly valued "1A" should produce no finding, got: ${f && f.message}`);
}
{
    // The exact typo from the original request: kΩ meant, kW typed.
    const r = fuseCircuit('300kΩ').runErcStructured();
    const f = r.findings.find((x) => x.ruleId === 'component-value-mismatch' && x.message.includes('F1'));
    check(!!f, 'a fuse valued "300kΩ" (resistance on a current-rated part) produced no finding');
    check(f && f.severity === 'error', '"300kΩ" on a fuse should be error');
}

// ================================================================
// 3. REQUEST 2, real parts: motor and pump both catch the inductive-load
//    check now that they are real symbols, not define_ic stand-ins.
// ================================================================
function switchedLoad(loadSymbol, withFlyback) {
    const ops = [
        { op: 'place_component', ref: 'VCC1', symbol: 'vcc' },
        { op: 'place_component', ref: 'M1', symbol: loadSymbol },
        { op: 'place_component', ref: 'Q1', symbol: 'nmos' },
        { op: 'place_component', ref: 'GND1', symbol: 'gnd' },
        { op: 'connect', from_ref: 'VCC1', from_pin: '0', to_ref: 'M1', to_pin: '0' },
        { op: 'connect', from_ref: 'M1', from_pin: '1', to_ref: 'Q1', to_pin: 'drain' },
        { op: 'connect', from_ref: 'Q1', from_pin: 'source', to_ref: 'GND1', to_pin: '0' },
    ];
    if (withFlyback) {
        ops.push(
            { op: 'place_component', ref: 'D1', symbol: 'diode' },
            { op: 'connect', from_ref: 'VCC1', from_pin: '0', to_ref: 'D1', to_pin: '1' },
            { op: 'connect', from_ref: 'D1', from_pin: '0', to_ref: 'M1', to_pin: '1' },
        );
    }
    return buildEditor(ops);
}

['motor', 'pump'].forEach((loadSymbol) => {
    const noFly = switchedLoad(loadSymbol, false).runErcStructured();
    const f1 = noFly.findings.find((x) => x.ruleId === 'inductive-load-no-flyback');
    check(!!f1, `an unprotected switched "${loadSymbol}" produced no inductive-load-no-flyback finding`);

    const withFly = switchedLoad(loadSymbol, true).runErcStructured();
    const f2 = withFly.findings.find((x) => x.ruleId === 'inductive-load-no-flyback');
    check(!f2, `a "${loadSymbol}" WITH a flyback diode across its terminals still flagged: ${f2 && f2.message}`);
});

// ================================================================
// 4. Relay: honestly a candidate, honestly unchecked. v1's flyback rule
//    is scoped to 2-pin loads (documented in knowledgeEngine.js); a
//    5-pin relay must show up in knowledgeCoverage as a load found but
//    NOT as one the rule could actually examine — and must not be
//    silently flagged OR silently cleared.
// ================================================================
{
    const ed = buildEditor([
        { op: 'place_component', ref: 'VCC1', symbol: 'vcc' },
        { op: 'place_component', ref: 'K1', symbol: 'relay' },
        { op: 'place_component', ref: 'Q1', symbol: 'nmos' },
        { op: 'place_component', ref: 'GND1', symbol: 'gnd' },
        { op: 'connect', from_ref: 'VCC1', from_pin: '0', to_ref: 'K1', to_pin: 'coilA' },
        { op: 'connect', from_ref: 'K1', from_pin: 'coilB', to_ref: 'Q1', to_pin: 'drain' },
        { op: 'connect', from_ref: 'Q1', from_pin: 'source', to_ref: 'GND1', to_pin: '0' },
    ]);
    const r = ed.runErcStructured();
    const f = r.findings.find((x) => x.ruleId === 'inductive-load-no-flyback');
    check(!f, `v1 should not flag a 5-pin relay's coil (undecidable which 2 pins), got: ${f && f.message}`);
    check(!!r.knowledgeCoverage, 'runErcStructured did not return knowledgeCoverage at all');
    check(r.knowledgeCoverage && r.knowledgeCoverage.inductiveLoads === 1,
        `expected 1 inductive-load candidate (the relay), got ${r.knowledgeCoverage && r.knowledgeCoverage.inductiveLoads}`);
    check(r.knowledgeCoverage && r.knowledgeCoverage.inductiveLoadsChecked === 0,
        `relay's 5-pin coil should NOT count as checked, got ${r.knowledgeCoverage && r.knowledgeCoverage.inductiveLoadsChecked}`);
}

// ================================================================
// 5. Full pipeline, both original requests, real parts only: refused
//    unfixed, exportable once fixed — this is what an agent actually
//    calls (export_pipeline_graph), not runErcStructured directly.
// ================================================================
function checkedGraph(ed) {
    delete global.window.GxPipelineGraph;
    new Function('window', fs.readFileSync(
        path.join(ROOT, 'assets', 'schema-editor', 'ai', 'pipelineGraph.js'), 'utf8'))(global.window);
    global.window.editor = ed;
    return global.window.GxPipelineGraph.buildChecked({});
}

{
    const broken = checkedGraph(fuseCircuit('300kW'));
    check(broken.ok === false, 'export should refuse a 300kW-valued fuse');
    check(!!broken.error && /design error/.test(broken.error), `refusal reason should name design error(s), got: ${broken.error}`);

    const fixed = checkedGraph(fuseCircuit('2A'));
    check(fixed.ok === true, `export should succeed once the fuse reads a real current value, got: ${fixed.error}`);
}
{
    const broken = checkedGraph(switchedLoad('pump', false));
    check(broken.ok === false, 'export should refuse a switched pump with no flyback diode');

    const fixed = checkedGraph(switchedLoad('pump', true));
    check(fixed.ok === true, `export should succeed once the pump has a flyback diode, got: ${fixed.error}`);
}

// ── report ─────────────────────────────────────────────────────
console.log(`real-parts checks: ${checks - failures.length}/${checks}`);
if (failures.length) {
    console.log(`FAIL — ${failures.length} mismatch(es):`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log('PASS — fuse/motor/pump/relay are real, drawable, ERC-checkable catalog');
console.log('       symbols; the fuse->current keyword fallback and the inductive-load');
console.log('       check both fire on them directly, the relay\'s unchecked coil is');
console.log('       reported honestly (not flagged, not silently cleared), and both');
console.log('       original user requests refuse-then-pass through the real pipeline');
console.log('       using only catalog parts — no define_ic stand-in required.');
