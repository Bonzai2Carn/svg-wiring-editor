#!/usr/bin/env node
/* ============================================================
   Schematics Editor — knowledge-rule regression harness

   ercEngine.js's twelve original rules are graph properties: is
   this pin connected, do two outputs collide. None of them read a
   VALUE or know what a PART IS, so a MOSFET switching a pump with
   no flyback diode — a real circuit that destroys itself on the
   first switch-off — passes all twelve clean.

   This proves the four new rules catch exactly the cases the old
   pack could not, using the SAME net/port shape geometryEngine.js
   actually produces: a port is { compId, wireId, pinId }, a net is
   { id, wireIds:[], compIds:Set }, and a rule finds a pin's net by
   matching `net.wireIds.includes(port.wireId)` — not by any
   compId/pinId list on the net itself, which the real code never
   populates. Every rule pack this session must be tested against
   that exact contract or the harness proves nothing about what the
   editor actually runs.

   Run: node scripts/check-knowledge.cjs
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'js', 'features');

// Overridable so this harness can be pointed at a pre-fix copy of the engine
// to confirm it actually catches the original ceiling:
//   git show HEAD:src/js/features/ercEngine.js > /tmp/old.js
//   ERC_ENGINE=/tmp/old.js node scripts/check-knowledge.cjs   # must FAIL
const ENGINE = process.env.ERC_ENGINE || path.join(SRC, 'ercEngine.js');
// Knowledge rules are additive on top of whatever engine is loaded; when
// pointed at a pre-fix engine that carries no _KNOWLEDGE_RULES array at all,
// loading this file is what SUPPLIES the checks below with something to fail
// against, rather than crashing on a missing rule pack.
const KNOWLEDGE_ENGINE = process.env.KNOWLEDGE_ENGINE || path.join(SRC, 'knowledgeEngine.js');

// ── minimal host ──────────────────────────────────────────────
global.MobileSVGEditor = function MobileSVGEditor() {};
global.window = global;
global.document = { getElementById: () => null, createElement: () => ({ style: {} }) };
new Function('window', fs.readFileSync(path.join(SRC, 'units.js'), 'utf8'))(global);
new Function('MobileSVGEditor', 'window', 'document', fs.readFileSync(ENGINE, 'utf8'))
    (global.MobileSVGEditor, global, global.document);
new Function('MobileSVGEditor', 'window', 'document', fs.readFileSync(KNOWLEDGE_ENGINE, 'utf8'))
    (global.MobileSVGEditor, global, global.document);

const failures = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) failures.push(msg); };

// ── specs used across the fixtures ──────────────────────────────
const SPECS = {
    resistor: {
        description: 'Limits current flow.', pinCount: 2,
        pins: { 0: { role: 'passive', signalType: 'any' }, 1: { role: 'passive', signalType: 'any' } },
    },
    led: {
        description: 'Emits light when forward-biased.', pinCount: 2,
        pins: { 0: { role: 'passive', signalType: 'analog', polarity: '+' },
                1: { role: 'passive', signalType: 'analog', polarity: '-' } },
    },
    diode: {
        description: 'Allows current in one direction only.', pinCount: 2,
        pins: { 0: { role: 'passive', signalType: 'analog', polarity: '+' },
                1: { role: 'passive', signalType: 'analog', polarity: '-' } },
    },
    nmos: {
        description: 'N-channel MOSFET.', pinCount: 3,
        pins: { gate: { role: 'input', signalType: 'analog' },
                drain: { role: 'bidir', signalType: 'analog' },
                source: { role: 'bidir', signalType: 'analog' } },
    },
    vcc: { description: 'Power rail symbol.', pinCount: 1, pins: { 0: { role: 'power', signalType: 'power' } } },
    gnd: { description: 'Ground reference.', pinCount: 1, pins: { 0: { role: 'ground', signalType: 'power' } } },
    pump: { description: 'AI-defined block "PUMP 12V".', pinCount: 2,
        pins: { 'V+': { role: 'power', signalType: 'power' }, 'V-': { role: 'passive', signalType: 'any' } } },
};

// ── fixture builders ─────────────────────────────────────────
function comp(id, symbol, refdes, value) {
    return {
        id, ports: [],
        element: {
            id: 'el_' + id, isConnected: true,
            _a: { 'data-symbol': symbol, 'data-refdes': refdes },
            getAttribute(k) { return this._a[k] ?? null; },
            querySelector(sel) {
                return sel === 'text.sym-value' && value ? { textContent: value } : null;
            },
            querySelectorAll(sel) {
                return sel === '.pin-point' ? new Array((SPECS[symbol] || {}).pinCount || 0).fill({}) : [];
            },
        },
    };
}

// One net per call: wires every (comp, pinId) pair in `members` onto a
// single shared wire id, exactly the shape a real 2-pin connection produces.
let wireN = 0, netN = 0;
function link(...members) {
    const wid = 'w' + (++wireN);
    members.forEach(([c, pinId]) => c.ports.push({ compId: c.id, wireId: wid, pinId: String(pinId) }));
    return { id: 'net' + (++netN), wireIds: [wid], compIds: new Set(members.map(([c]) => c.id)) };
}

function run(components, nets, specs) {
    global.window.COMPONENT_SPECS = specs || SPECS;
    const ed = new global.MobileSVGEditor();
    ed.graph = { nets, edges: new Map(), adjacency: new Map() };
    ed.components = components;
    ed.wires = [];
    global.window.editor = ed;   // for the pipelineGraph.js integration check below
    return ed.runErcStructured();
}

const has = (r, ruleId) => r.findings.some((f) => f.ruleId === ruleId);
const finding = (r, ruleId) => r.findings.find((f) => f.ruleId === ruleId);

// ── 1. inductive load with NO flyback diode → error ────────────
{
    const vcc = comp('c1', 'vcc', 'VCC1'), pump = comp('c2', 'pump', 'M1'), gnd = comp('c3', 'gnd', 'GND1');
    const nets = [link([vcc, '0'], [pump, 'V+']), link([pump, 'V-'], [gnd, '0'])];
    const r = run([vcc, pump, gnd], nets);
    check(has(r, 'inductive-load-no-flyback'),
        'a pump with no diode across it did not trigger inductive-load-no-flyback — this is the request-2 case');
    const f = finding(r, 'inductive-load-no-flyback');
    check(f && f.severity === 'error', `severity was "${f && f.severity}", expected error`);
    check(f && /M1/.test(f.message), `finding does not name the component: ${f && f.message}`);
}

// ── 2. same load, WITH a diode across its two terminals → clean ─
{
    const vcc = comp('c1', 'vcc', 'VCC1'), pump = comp('c2', 'pump', 'M1'), gnd = comp('c3', 'gnd', 'GND1');
    const d1 = comp('c4', 'diode', 'D1');
    const nets = [
        link([vcc, '0'], [pump, 'V+'], [d1, '1']),   // diode cathode on the supply-side net
        link([pump, 'V-'], [gnd, '0'], [d1, '0']),   // diode anode on the return-side net
    ];
    const r = run([vcc, pump, gnd, d1], nets);
    check(!has(r, 'inductive-load-no-flyback'),
        'a pump WITH a diode bridging its two terminals still flagged missing flyback');
}

// ── 3. a diode elsewhere in the circuit does NOT satisfy the rule ─
//    The rule requires the diode to bridge the LOAD's own two nets, not
//    merely exist somewhere in the schematic — a rectifier on an unrelated
//    rail must not silence a real missing-flyback finding.
{
    const vcc = comp('c1', 'vcc', 'VCC1'), pump = comp('c2', 'pump', 'M1'), gnd = comp('c3', 'gnd', 'GND1');
    const other = comp('c5', 'vcc', 'VCC2'), otherGnd = comp('c6', 'gnd', 'GND2'), d2 = comp('c7', 'diode', 'D2');
    const nets = [
        link([vcc, '0'], [pump, 'V+']), link([pump, 'V-'], [gnd, '0']),
        link([other, '0'], [d2, '1']), link([d2, '0'], [otherGnd, '0']),
    ];
    const r = run([vcc, pump, gnd, other, otherGnd, d2], nets);
    check(has(r, 'inductive-load-no-flyback'),
        'an unrelated diode elsewhere in the circuit silenced a real missing-flyback finding');
}

// ── 4. LED with no series resistor → error ──────────────────────
{
    const vcc = comp('c1', 'vcc', 'VCC1'), led = comp('c2', 'led', 'D1'), gnd = comp('c3', 'gnd', 'GND1');
    const nets = [link([vcc, '0'], [led, '0']), link([led, '1'], [gnd, '0'])];
    const r = run([vcc, led, gnd], nets);
    check(has(r, 'led-no-current-limit'),
        'an LED wired straight from VCC to GND did not trigger led-no-current-limit — the request-1 case');
    const f = finding(r, 'led-no-current-limit');
    check(f && f.severity === 'error', `severity was "${f && f.severity}", expected error`);
}

// ── 5. same LED, with a series resistor → clean ─────────────────
{
    const vcc = comp('c1', 'vcc', 'VCC1'), res = comp('c2', 'resistor', 'R1');
    const led = comp('c3', 'led', 'D1'), gnd = comp('c4', 'gnd', 'GND1');
    const nets = [link([vcc, '0'], [res, '0']), link([res, '1'], [led, '0']), link([led, '1'], [gnd, '0'])];
    const r = run([vcc, res, led, gnd], nets);
    check(!has(r, 'led-no-current-limit'), 'an LED with a real series resistor still flagged missing current limit');
}

// ── 6. MOSFET gate with no pull resistor → warning ──────────────
{
    const vcc = comp('c1', 'vcc', 'VCC1'), q1 = comp('c2', 'nmos', 'Q1'), gnd = comp('c3', 'gnd', 'GND1');
    // Gate net carries only the gate pin — nothing drives it in this fixture,
    // which is the point: no resistor anywhere on that net.
    const nets = [link([q1, 'gate']), link([q1, 'drain'], [vcc, '0']), link([q1, 'source'], [gnd, '0'])];
    const r = run([vcc, q1, gnd], nets);
    check(has(r, 'floating-switch-control'), 'an NMOS gate with no resistor on its net was not flagged');
    const f = finding(r, 'floating-switch-control');
    check(f && f.severity === 'warning', `severity was "${f && f.severity}", expected warning (not an outright error)`);
}

// ── 7. same MOSFET, gate net WITH a resistor → clean ────────────
{
    const vcc = comp('c1', 'vcc', 'VCC1'), q1 = comp('c2', 'nmos', 'Q1'), gnd = comp('c3', 'gnd', 'GND1');
    const rg = comp('c4', 'resistor', 'R1');
    const nets = [
        link([q1, 'gate'], [rg, '0']), link([rg, '1'], [gnd, '0']),
        link([q1, 'drain'], [vcc, '0']), link([q1, 'source'], [gnd, '0']),
    ];
    const r = run([vcc, q1, gnd, rg], nets);
    check(!has(r, 'floating-switch-control'), 'a pulled-down gate still flagged floating-switch-control');
}

// ── 8. component-value-mismatch: definite error vs ambiguous warning ─
{
    const r1 = comp('c1', 'resistor', 'R1', '300kW');     // definite: power on a resistor
    const r2 = comp('c2', 'resistor', 'R2', '4k7');       // fine: bare shorthand
    const c1 = comp('c3', 'capacitor', 'C1', '10');       // ambiguous: bare number, no prefix
    const c2 = comp('c4', 'capacitor', 'C2', '10uF');     // fine
    const specs = Object.assign({}, SPECS, {
        capacitor: { description: 'Stores electric charge.', pinCount: 2,
            pins: { 0: { role: 'passive', signalType: 'any' }, 1: { role: 'passive', signalType: 'any' } } },
    });
    const r = run([r1, r2, c1, c2], [], specs);
    const bad = finding(r, 'component-value-mismatch');
    check(!!bad, 'a resistor valued "300kW" produced no component-value-mismatch finding');
    const mismatches = r.findings.filter((f) => f.ruleId === 'component-value-mismatch');
    check(mismatches.length === 2, `expected 2 value findings (R1 error, C1 warning), got ${mismatches.length}`);
    const r1f = mismatches.find((f) => /R1/.test(f.message));
    const c1f = mismatches.find((f) => /C1/.test(f.message));
    check(r1f && r1f.severity === 'error', `R1 (300kW) severity "${r1f && r1f.severity}", expected error`);
    check(c1f && c1f.severity === 'warning', `C1 (bare "10") severity "${c1f && c1f.severity}", expected warning`);
    check(!mismatches.some((f) => /R2|C2/.test(f.message)), 'a correctly-valued component was flagged');
}

// ── 9. knowledgeCoverage reports what it actually reasoned about ──
{
    const vcc = comp('c1', 'vcc', 'VCC1'), pump = comp('c2', 'pump', 'M1'), gnd = comp('c3', 'gnd', 'GND1');
    const led = comp('c4', 'led', 'D1'), q1 = comp('c5', 'nmos', 'Q1');
    const nets = [
        link([vcc, '0'], [pump, 'V+']), link([pump, 'V-'], [gnd, '0']),
        link([vcc, '0'], [led, '0']), link([led, '1'], [gnd, '0']),
        link([q1, 'gate']), link([q1, 'drain'], [vcc, '0']), link([q1, 'source'], [gnd, '0']),
    ];
    const r = run([vcc, pump, gnd, led, q1], nets);
    const kc = r.knowledgeCoverage;
    check(!!kc, 'runErcStructured returned no knowledgeCoverage object');
    check(kc?.inductiveLoads === 1 && kc?.inductiveLoadsChecked === 1,
        `inductiveLoads ${kc?.inductiveLoads}/${kc?.inductiveLoadsChecked}, expected 1/1`);
    check(kc?.leds === 1 && kc?.ledsChecked === 1, `leds ${kc?.leds}/${kc?.ledsChecked}, expected 1/1`);
    check(kc?.switches === 1, `switches ${kc?.switches}, expected 1`);
}

// ── 10. a >2-pin inductive load is skipped, not falsely accused ──
//     v1's scope is explicit: it cannot say which two of N pins are the
//     coil, so it must stay silent rather than guess.
{
    const specs = Object.assign({}, SPECS, {
        relay3: { description: 'A relay coil plus two contacts.', pinCount: 3,
            pins: { coil1: { role: 'power', signalType: 'power' }, coil2: { role: 'passive', signalType: 'any' },
                    com: { role: 'passive', signalType: 'any' } } },
    });
    const vcc = comp('c1', 'vcc', 'VCC1'), rel = comp('c2', 'relay3', 'K1'), gnd = comp('c3', 'gnd', 'GND1');
    const nets = [link([vcc, '0'], [rel, 'coil1']), link([rel, 'coil2'], [gnd, '0'])];
    const r = run([vcc, rel, gnd], nets, specs);
    check(!has(r, 'inductive-load-no-flyback'), 'a 3-pin relay was checked despite v1 being scoped to 2-pin loads');
}

// ── 11. pipelineGraph.js: a knowledge error gates wireCorrect ────
//     The thing an agent actually reads. Load it into the SAME global.window
//     that already carries `editor` (set inside run()) and COMPONENT_SPECS.
{
    const vcc = comp('c1', 'vcc', 'VCC1'), pump = comp('c2', 'pump', 'M1'), gnd = comp('c3', 'gnd', 'GND1');
    const nets = [link([vcc, '0'], [pump, 'V+']), link([pump, 'V-'], [gnd, '0'])];
    run([vcc, pump, gnd], nets);   // populates global.window.editor + COMPONENT_SPECS

    delete global.window.GxPipelineGraph;
    new Function('window', fs.readFileSync(
        path.resolve(ROOT, '..', '..', 'assets', 'schema-editor', 'ai', 'pipelineGraph.js'), 'utf8'))(global.window);
    const g = global.window.GxPipelineGraph.build();
    check(!!g, 'GxPipelineGraph.build() returned nothing');
    check(g.verdict.knowledgeErrors === 1, `verdict.knowledgeErrors ${g.verdict.knowledgeErrors}, expected 1`);
    check(g.verdict.connectionErrors === 0, `verdict.connectionErrors ${g.verdict.connectionErrors}, expected 0 ` +
        '(this circuit has no short — the point is that a clean netlist can still be knowledge-wrong)');
    check(g.verdict.wireCorrect === false, 'wireCorrect was true on a circuit missing a flyback diode');

    const checked = global.window.GxPipelineGraph.buildChecked({});
    check(checked.ok === false, 'buildChecked() allowed export of a knowledge-error graph without force');
    check(/design error/.test(checked.error), `buildChecked() reason does not name a design error: "${checked.error}"`);
}

console.log(`knowledge checks: ${checks - failures.length}/${checks}`);
if (failures.length) {
    console.log(`FAIL — ${failures.length} check(s):`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log('PASS — a switched inductive load with no flyback diode, an LED with no');
console.log('       series resistor, a floating MOSFET gate, and a value in the');
console.log('       wrong physical unit are all now findings — and none of them were');
console.log('       reachable by the twelve topology-only rules that existed before.');
