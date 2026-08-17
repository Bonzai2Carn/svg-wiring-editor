#!/usr/bin/env node
/* ============================================================
   Schema Editor — ERC coverage regression harness

   Guards the property that ERC must never report success over
   material it did not examine.

   Before this existed, `runErcStructured()` returned only a count
   of findings. A schematic whose components carried no pin roles
   produced zero connection findings, which was indistinguishable
   in the output from a schematic that had been fully checked and
   was clean. `export_pipeline_graph` then stamped wireCorrect:true
   on it.

   Every assertion below FAILS against that pre-fix behaviour:
   `coverage` was absent from the result and the `unverifiable-pins`
   rule did not exist. A fix to a silent gate without a test that
   catches the original is how the original comes back.

   Run: node scripts/check-erc-coverage.cjs
   ============================================================ */
const fs = require('fs');
const path = require('path');

// Overridable so the harness can be pointed at a pre-fix copy of the engine to
// confirm it actually catches the original defect:
//   git show HEAD:tools/schema-editor/src/js/features/ercEngine.js > /tmp/old.js
//   ERC_ENGINE=/tmp/old.js node scripts/check-erc-coverage.cjs   # must FAIL
const ENGINE = process.env.ERC_ENGINE
    || path.resolve(__dirname, '..', 'src', 'js', 'features', 'ercEngine.js');

// ── minimal host: the engine is a prototype mixin, not a module ──
global.MobileSVGEditor = function MobileSVGEditor() {};
global.window = global;
global.document = { getElementById: () => null, createElement: () => ({ style: {} }) };
new Function('MobileSVGEditor', 'window', 'document', fs.readFileSync(ENGINE, 'utf8'))(
    global.MobileSVGEditor, global.window, global.document);

const editor = new global.MobileSVGEditor();

/**
 * A stub component in the shape the rules read: an element that answers
 * getAttribute for data-symbol / data-refdes and reports its drawn pins.
 */
function comp(id, symbol, refdes, pinIds) {
    const el = {
        id: `el_${id}`,
        isConnected: true,
        _attrs: { 'data-symbol': symbol, 'data-refdes': refdes },
        getAttribute(k) { return this._attrs[k] ?? null; },
        querySelector() { return null; },
        querySelectorAll(sel) { return sel === '.pin-point' ? new Array(pinIds.length).fill({}) : []; },
    };
    return { id, element: el, ports: pinIds.map((p) => ({ pinId: p })), bbox: {} };
}

function run(components, specs) {
    global.window.COMPONENT_SPECS = specs;
    editor.graph = { nets: [], edges: new Map(), adjacency: new Map() };
    editor.components = components;
    editor.wires = [];
    return editor.runErcStructured();
}

const ROLED = {
    resistor: {
        description: 'r', pinCount: 2, pinNames: ['A', 'B'],
        pins: { 0: { role: 'passive', signalType: 'any' }, 1: { role: 'passive', signalType: 'any' } },
    },
};
// What define_ic used to install: nothing. What it installs now for a bare
// pin list: a spec whose roles are explicitly unspecified.
const BARE = Object.assign({}, ROLED, {
    'arduino-uno': {
        description: 'AI-defined block.', pinCount: 3, pinNames: ['D13', 'GND', '5V'],
        pins: {
            D13: { role: 'unspecified', signalType: 'any' },
            GND: { role: 'unspecified', signalType: 'any' },
            '5V': { role: 'unspecified', signalType: 'any' },
        },
    },
});

const failures = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) failures.push(msg); };

// ── 1. A fully roled schematic reports full coverage ──────────
{
    const r = run([comp('c1', 'resistor', 'R1', ['0', '1'])], ROLED);
    check(!!r.coverage, 'runErcStructured returned no coverage object');
    check(r.coverage?.totalPins === 2, `totalPins ${r.coverage?.totalPins}, expected 2`);
    check(r.coverage?.unverifiablePins === 0,
        `roled schematic reported ${r.coverage?.unverifiablePins} unverifiable pin(s)`);
    check(r.coverage?.ratio === 1, `coverage ratio ${r.coverage?.ratio}, expected 1`);
    check(!r.findings.some((f) => f.ruleId === 'unverifiable-pins'),
        'unverifiable-pins fired on a fully roled schematic');
}

// ── 2. Unspecified roles are counted, not absorbed ────────────
//    This is the exact case an AI-drawn Arduino produced.
{
    const r = run([
        comp('c1', 'resistor', 'R1', ['0', '1']),
        comp('c2', 'arduino-uno', 'U1', ['D13', 'GND', '5V']),
    ], BARE);
    check(r.coverage?.totalPins === 5, `totalPins ${r.coverage?.totalPins}, expected 5`);
    check(r.coverage?.unverifiablePins === 3,
        `expected 3 unverifiable pins, got ${r.coverage?.unverifiablePins}`);
    check(r.coverage?.verifiedPins === 2, `verifiedPins ${r.coverage?.verifiedPins}, expected 2`);
    check(Math.abs(r.coverage?.ratio - 0.4) < 1e-9, `ratio ${r.coverage?.ratio}, expected 0.4`);
    const f = r.findings.find((x) => x.ruleId === 'unverifiable-pins');
    check(!!f, 'unverifiable-pins did not fire on a board with unroled pins');
    check(f && /U1/.test(f.message), 'the finding does not name the offending component');
    check(f && f.severity === 'warning',
        `unverifiable-pins severity ${f && f.severity}, expected warning (the drawing is not wrong, it is unchecked)`);
}

// ── 3. A component with NO spec at all is the worst case ──────
//    Pre-fix this contributed nothing to any count and vanished.
{
    const r = run([comp('c1', 'mystery-block', 'U9', ['a', 'b', 'c', 'd'])], ROLED);
    check(r.coverage?.componentsWithoutSpec === 1,
        `componentsWithoutSpec ${r.coverage?.componentsWithoutSpec}, expected 1`);
    check(r.coverage?.unverifiablePins === 4,
        `an unspecced component contributed ${r.coverage?.unverifiablePins} unverifiable pins, expected 4`);
    check(r.coverage?.ratio === 0, `ratio ${r.coverage?.ratio}, expected 0`);
    const f = r.findings.find((x) => x.ruleId === 'unverifiable-pins');
    check(!!f && /no pin roles declared/.test(f.message),
        'an unspecced component did not produce the no-roles finding');
}

// ── 4. net-label is scenery, not a component to grade ─────────
{
    const r = run([comp('c1', 'net-label', 'NET', ['0'])], ROLED);
    check(r.coverage?.totalPins === 0,
        `net-label counted toward coverage (totalPins ${r.coverage?.totalPins})`);
}

// ── 5. The empty case must not divide by zero ─────────────────
{
    const r = run([comp('c1', 'net-label', 'NET', ['0'])], ROLED);
    check(r.coverage?.ratio === 1, `empty coverage ratio ${r.coverage?.ratio}, expected 1`);
}

console.log(`erc coverage checks: ${checks - failures.length}/${checks}`);
if (failures.length) {
    console.log(`FAIL — ${failures.length} check(s):`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log('PASS — ERC reports how much of the schematic it examined, unroled');
console.log('       pins are counted rather than absorbed into "passive", and a');
console.log('       component with no spec at all is surfaced instead of skipped.');
