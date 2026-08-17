#!/usr/bin/env node
/* ============================================================
   Schematics Editor — bus/protocol rule regression harness

   knowledgeEngine.js's rules read values and part identities.
   These four read a RICHER topology: bus lines. I2C with no
   pull-ups, SPI with two chip-selects shorted, UART TX wired to
   TX, two I2C devices answering one address — none of these are
   graph faults (no short, no contention on a power rail), so the
   twelve original rules and the connection pack all pass them,
   and a pump-style knowledge pack is the wrong drawer for them.

   This harness loads ONLY ercEngine.js + busEngine.js — no
   knowledgeEngine, no units — on purpose: busEngine.js is a
   sibling that must stand alone, the same way check-erc-
   coverage.cjs proves ercEngine.js stands alone. The same
   net/port shape geometryEngine.js actually produces:
   a port is { compId, wireId, pinId }, a net is { id, wireIds:[],
   compIds:Set }, and a pin's net is found by
   `net.wireIds.includes(port.wireId)` — never a compId/pinId
   list on the net itself.

   Run: node scripts/check-bus.cjs
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'js', 'features');

// Overridable so this harness can be pointed at a pre-fix engine to prove
// it catches the wiring itself:
//   git show HEAD:src/js/features/ercEngine.js > /tmp/old.js
//   ERC_ENGINE=/tmp/old.js node scripts/check-bus.cjs   # must FAIL
const ENGINE = process.env.ERC_ENGINE || path.join(SRC, 'ercEngine.js');
const BUS_ENGINE = process.env.BUS_ENGINE || path.join(SRC, 'busEngine.js');

// ── minimal host ──────────────────────────────────────────────
global.MobileSVGEditor = function MobileSVGEditor() {};
global.window = global;
global.document = { getElementById: () => null, createElement: () => ({ style: {} }) };
new Function('MobileSVGEditor', 'window', 'document', fs.readFileSync(ENGINE, 'utf8'))
    (global.MobileSVGEditor, global, global.document);
new Function('MobileSVGEditor', 'window', 'document', fs.readFileSync(BUS_ENGINE, 'utf8'))
    (global.MobileSVGEditor, global, global.document);

const failures = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) failures.push(msg); };

// ── specs used across the fixtures ──────────────────────────────
const SPECS = {
    resistor: {
        description: 'Limits current flow; the thing a pull-up is.', pinCount: 2,
        pins: { 0: { role: 'passive', signalType: 'any' }, 1: { role: 'passive', signalType: 'any' } },
    },
    vcc: { description: 'Power rail symbol.', pinCount: 1, pins: { 0: { role: 'power', signalType: 'power' } } },
    gnd: { description: 'Ground reference.', pinCount: 1, pins: { 0: { role: 'ground', signalType: 'power' } } },
    'i2c-sensor': { description: 'I2C temperature sensor, 7-bit address.', pinCount: 2,
        pins: { sda: { role: 'bidir', signalType: 'analog' }, scl: { role: 'input', signalType: 'digital' } } },
    'i2c-eeprom': { description: 'I2C EEPROM memory.', pinCount: 2,
        pins: { sda: { role: 'bidir', signalType: 'analog' }, scl: { role: 'input', signalType: 'digital' } } },
    'spi-flash': { description: 'SPI NOR flash memory.', pinCount: 4,
        pins: { cs: { role: 'input', signalType: 'digital' }, sclk: { role: 'input', signalType: 'digital' },
                mosi: { role: 'input', signalType: 'digital' }, miso: { role: 'output', signalType: 'digital' } } },
    'spi-adc': { description: 'SPI analog-to-digital converter.', pinCount: 4,
        pins: { cs: { role: 'input', signalType: 'digital' }, sclk: { role: 'input', signalType: 'digital' },
                mosi: { role: 'input', signalType: 'digital' }, miso: { role: 'output', signalType: 'digital' } } },
    'uart-gps': { description: 'GPS module, UART host interface.', pinCount: 2,
        pins: { tx: { role: 'output', signalType: 'digital' }, rx: { role: 'input', signalType: 'digital' } } },
    'uart-lora': { description: 'LoRa radio, UART host interface.', pinCount: 2,
        pins: { tx: { role: 'output', signalType: 'digital' }, rx: { role: 'input', signalType: 'digital' } } },
};

// ── fixture builders (identical contract to check-knowledge.cjs) ─
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
    global.window.editor = ed;
    return ed.runErcStructured();
}

const has = (r, ruleId) => r.findings.some((f) => f.ruleId === ruleId);
const finding = (r, ruleId) => r.findings.find((f) => f.ruleId === ruleId);
const count = (r, ruleId) => r.findings.filter((f) => f.ruleId === ruleId).length;

// ── 1. two I2C devices, no pull-ups on either line → 2 errors ──
{
    const s1 = comp('c1', 'i2c-sensor', 'U1'), e1 = comp('c2', 'i2c-eeprom', 'U2');
    const nets = [link([s1, 'sda'], [e1, 'sda']), link([s1, 'scl'], [e1, 'scl'])];
    const r = run([s1, e1], nets);
    check(count(r, 'i2c-no-pullups') === 2,
        `a two-device I2C bus with no pull-ups produced ${count(r, 'i2c-no-pullups')} finding(s), expected 2 (SDA + SCL)`);
    const f = finding(r, 'i2c-no-pullups');
    check(f && f.severity === 'error', `i2c-no-pullups severity "${f && f.severity}", expected error`);
}

// ── 2. same bus, one pull-up per line → clean ──────────────────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1'), e1 = comp('c2', 'i2c-eeprom', 'U2');
    const rp = comp('c3', 'resistor', 'R1'), rq = comp('c4', 'resistor', 'R2');
    const vcc = comp('c5', 'vcc', 'VCC1');
    const nets = [
        link([s1, 'sda'], [e1, 'sda'], [rp, '0']), link([rp, '1'], [vcc, '0']),
        link([s1, 'scl'], [e1, 'scl'], [rq, '0']), link([rq, '1'], [vcc, '0']),
    ];
    const r = run([s1, e1, rp, rq, vcc], nets);
    check(count(r, 'i2c-no-pullups') === 0, 'a pulled-up I2C bus still flagged i2c-no-pullups');
}

// ── 3. pull-up on SDA only → SCL still flagged ─────────────────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1'), e1 = comp('c2', 'i2c-eeprom', 'U2');
    const rp = comp('c3', 'resistor', 'R1'), vcc = comp('c4', 'vcc', 'VCC1');
    const nets = [
        link([s1, 'sda'], [e1, 'sda'], [rp, '0']), link([rp, '1'], [vcc, '0']),
        link([s1, 'scl'], [e1, 'scl']),
    ];
    const r = run([s1, e1, rp, vcc], nets);
    check(count(r, 'i2c-no-pullups') === 1, `expected exactly the SCL line flagged, got ${count(r, 'i2c-no-pullups')}`);
    const f = finding(r, 'i2c-no-pullups');
    check(f && /SCL/i.test(f.message), `message does not name SCL: "${f && f.message}"`);
}

// ── 4. one I2C device alone is a stub, not a bus → clean ───────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1');
    const nets = [link([s1, 'sda']), link([s1, 'scl'])];
    const r = run([s1], nets);
    check(count(r, 'i2c-no-pullups') === 0,
        'a single unpaired I2C device was flagged for no pull-up — a stub is unconnected-pin\'s finding, not this rule\'s');
}

// ── 5. three devices on one line → ONE finding per line ────────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1'), e1 = comp('c2', 'i2c-eeprom', 'U2');
    const s2 = comp('c3', 'i2c-sensor', 'U3');
    const nets = [link([s1, 'sda'], [e1, 'sda'], [s2, 'sda']), link([s1, 'scl'], [e1, 'scl'], [s2, 'scl'])];
    const r = run([s1, e1, s2], nets);
    check(count(r, 'i2c-no-pullups') === 2,
        `3-device bus flagged ${count(r, 'i2c-no-pullups')} findings — one per LINE, not one per device`);
    const f = finding(r, 'i2c-no-pullups');
    check(f && /3 devices/.test(f.message), `message does not say how many devices the line carries: "${f && f.message}"`);
}

// ── 6. two SPI devices sharing a CS net → error ────────────────
{
    const f1 = comp('c1', 'spi-flash', 'U1'), a1 = comp('c2', 'spi-adc', 'U2');
    const nets = [
        link([f1, 'cs'], [a1, 'cs']),                 // the collision
        link([f1, 'sclk'], [a1, 'sclk']), link([f1, 'mosi'], [a1, 'mosi']), link([f1, 'miso'], [a1, 'miso']),
    ];
    const r = run([f1, a1], nets);
    check(has(r, 'spi-cs-collision'), 'two SPI devices sharing a chip-select net were not flagged');
    const f = finding(r, 'spi-cs-collision');
    check(f && f.severity === 'error', `spi-cs-collision severity "${f && f.severity}", expected error`);
    check(f && /U1\.cs, U2\.cs/.test(f.message), `message does not name both selects: "${f && f.message}"`);
}

// ── 7. same two devices, SEPARATE CS nets → clean ──────────────
{
    const f1 = comp('c1', 'spi-flash', 'U1'), a1 = comp('c2', 'spi-adc', 'U2');
    const nets = [
        link([f1, 'cs']), link([a1, 'cs']),
        link([f1, 'sclk'], [a1, 'sclk']), link([f1, 'mosi'], [a1, 'mosi']), link([f1, 'miso'], [a1, 'miso']),
    ];
    const r = run([f1, a1], nets);
    check(count(r, 'spi-cs-collision') === 0, 'SPI devices on independent CS nets were flagged as colliding');
}

// ── 8. CS tied to ground is the "always enabled" pattern → clean ─
{
    const f1 = comp('c1', 'spi-flash', 'U1'), a1 = comp('c2', 'spi-adc', 'U2');
    const gnd = comp('c3', 'gnd', 'GND1');
    const nets = [
        link([f1, 'cs'], [a1, 'cs'], [gnd, '0']),     // both selects hard-wired low
        link([f1, 'sclk'], [a1, 'sclk']),
    ];
    const r = run([f1, a1, gnd], nets);
    check(count(r, 'spi-cs-collision') === 0,
        'chip-selects tied to ground (always-enabled devices) were reported as a collision');
}

// ── 9. three devices on one CS net → ONE finding, not three ────
{
    const f1 = comp('c1', 'spi-flash', 'U1'), a1 = comp('c2', 'spi-adc', 'U2');
    const f2 = comp('c3', 'spi-flash', 'U3');
    const nets = [link([f1, 'cs'], [a1, 'cs'], [f2, 'cs'])];
    const r = run([f1, a1, f2], nets);
    check(count(r, 'spi-cs-collision') === 1, `3 shorted selects produced ${count(r, 'spi-cs-collision')} findings, expected 1`);
}

// ── 10. UART wired TX→TX → error ─────────────────────────────
{
    const g = comp('c1', 'uart-gps', 'U1'), l = comp('c2', 'uart-lora', 'U2');
    const nets = [
        link([g, 'tx'], [l, 'tx']),    // the cross-wire
        link([g, 'rx'], [l, 'rx']),
    ];
    const r = run([g, l], nets);
    check(has(r, 'uart-wired-tx-tx'), 'two UART TX pins on one net were not flagged');
    const f = finding(r, 'uart-wired-tx-tx');
    check(f && f.severity === 'error', `uart-wired-tx-tx severity "${f && f.severity}", expected error`);
    check(f && /U1, U2/.test(f.message), `message does not name both devices: "${f && f.message}"`);
}

// ── 11. properly crossed TX→RX → clean ────────────────────────
{
    const g = comp('c1', 'uart-gps', 'U1'), l = comp('c2', 'uart-lora', 'U2');
    const nets = [link([g, 'tx'], [l, 'rx']), link([g, 'rx'], [l, 'tx'])];
    const r = run([g, l], nets);
    check(count(r, 'uart-wired-tx-tx') === 0, 'a correctly crossed TX→RX pair was flagged');
}

// ── 12. three TX pins on one net → ONE finding ────────────────
{
    const g = comp('c1', 'uart-gps', 'U1'), l = comp('c2', 'uart-lora', 'U2');
    const g2 = comp('c3', 'uart-gps', 'U3');
    const nets = [link([g, 'tx'], [l, 'tx'], [g2, 'tx'])];
    const r = run([g, l, g2], nets);
    check(count(r, 'uart-wired-tx-tx') === 1, `3 TX pins on one net produced ${count(r, 'uart-wired-tx-tx')} findings, expected 1`);
}

// ── 13. same I2C address on the same bus → error ──────────────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1', '0x48'), e1 = comp('c2', 'i2c-eeprom', 'U2', '0x48');
    const nets = [link([s1, 'sda'], [e1, 'sda']), link([s1, 'scl'], [e1, 'scl'])];
    const r = run([s1, e1], nets);
    check(has(r, 'i2c-address-collision'), 'two devices answering 0x48 on one bus were not flagged');
    const f = finding(r, 'i2c-address-collision');
    check(f && f.severity === 'error', `i2c-address-collision severity "${f && f.severity}", expected error`);
    check(f && /0x48/.test(f.message), `message does not name the address: "${f && f.message}"`);
}

// ── 14. same address, DIFFERENT buses → clean ─────────────────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1', '0x48'), e1 = comp('c2', 'i2c-eeprom', 'U2', '0x48');
    const nets = [link([s1, 'sda']), link([s1, 'scl']), link([e1, 'sda']), link([e1, 'scl'])];
    const r = run([s1, e1], nets);
    check(count(r, 'i2c-address-collision') === 0, 'identical addresses on separate buses were flagged as colliding');
}

// ── 15. different addresses on one bus → clean ────────────────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1', '0x48'), e1 = comp('c2', 'i2c-eeprom', 'U2', '0x50');
    const nets = [link([s1, 'sda'], [e1, 'sda']), link([s1, 'scl'], [e1, 'scl'])];
    const r = run([s1, e1], nets);
    check(count(r, 'i2c-address-collision') === 0, 'devices at 0x48 and 0x50 were flagged as colliding');
}

// ── 16. an unreadable address is skipped, never guessed ────────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1', '5V'), e1 = comp('c2', 'i2c-eeprom', 'U2');
    const nets = [link([s1, 'sda'], [e1, 'sda']), link([s1, 'scl'], [e1, 'scl'])];
    const r = run([s1, e1], nets);
    check(count(r, 'i2c-address-collision') === 0,
        'two devices whose addresses cannot be read were reported as colliding');
}

// ── 17. busCoverage says what was actually reasoned about ─────
{
    const s1 = comp('c1', 'i2c-sensor', 'U1', '0x48'), e1 = comp('c2', 'i2c-eeprom', 'U2', '0x50');
    const rp = comp('c3', 'resistor', 'R1'), rq = comp('c4', 'resistor', 'R2'), vcc = comp('c5', 'vcc', 'VCC1');
    const f1 = comp('c6', 'spi-flash', 'U3'), a1 = comp('c7', 'spi-adc', 'U4');
    const g = comp('c8', 'uart-gps', 'U5'), l = comp('c9', 'uart-lora', 'U6');
    const nets = [
        link([s1, 'sda'], [e1, 'sda'], [rp, '0']), link([rp, '1'], [vcc, '0']),
        link([s1, 'scl'], [e1, 'scl'], [rq, '0']), link([rq, '1'], [vcc, '0']),
        link([f1, 'cs']), link([a1, 'cs']),                        // separate selects: examined, clean
        link([g, 'tx'], [l, 'rx']), link([g, 'rx'], [l, 'tx']),    // crossed: clean
    ];
    const r = run([s1, e1, rp, rq, vcc, f1, a1, g, l], nets);
    const bc = r.busCoverage;
    check(!!bc, 'runErcStructured returned no busCoverage object');
    check(bc?.i2cDevices === 2, `i2cDevices ${bc?.i2cDevices}, expected 2`);
    check(bc?.i2cLinesChecked === 2, `i2cLinesChecked ${bc?.i2cLinesChecked}, expected 2 (both lines are buses and were examined)`);
    check(bc?.spiDevices === 2, `spiDevices ${bc?.spiDevices}, expected 2`);
    check(bc?.csNetsChecked === 0, `csNetsChecked ${bc?.csNetsChecked}, expected 0 (separate selects, nothing to collide)`);
    check(bc?.uartDevices === 2, `uartDevices ${bc?.uartDevices}, expected 2`);
    check(bc?.txNetsChecked === 0, `txNetsChecked ${bc?.txNetsChecked}, expected 0 (crossed pair)`);
    check(bc?.addressesPresent === 2 && bc?.addressesChecked === 2,
        `addresses ${bc?.addressesPresent}/${bc?.addressesChecked}, expected 2/2`);
    check(count(r, 'i2c-no-pullups') === 0 && count(r, 'spi-cs-collision') === 0
        && count(r, 'uart-wired-tx-tx') === 0 && count(r, 'i2c-address-collision') === 0,
        'a fully-correct multi-bus schematic produced a bus finding');
}

// ── 18. zero-candidate circuit reports zeros, not silence ─────
{
    const vcc = comp('c1', 'vcc', 'VCC1'), res = comp('c2', 'resistor', 'R1');
    const led = comp('c3', 'resistor', 'R2'), gnd = comp('c4', 'gnd', 'GND1');
    const nets = [link([vcc, '0'], [res, '0']), link([res, '1'], [led, '0']), link([led, '1'], [gnd, '0'])];
    const r = run([vcc, res, led, gnd], nets);
    const bc = r.busCoverage;
    check((bc?.i2cDevices ?? 0) === 0 && (bc?.spiDevices ?? 0) === 0 && (bc?.uartDevices ?? 0) === 0 && (bc?.addressesPresent ?? 0) === 0,
        'a circuit with no protocol devices reports a non-zero candidate count in busCoverage');
    check(r.findings.every((f) => !['i2c-no-pullups', 'spi-cs-collision', 'uart-wired-tx-tx', 'i2c-address-collision'].includes(f.ruleId)),
        'bus rules fired on a circuit with no protocol devices');
}

// ── 19. pipelineGraph.js: a bus error gates wireCorrect ───────
//     The thing an agent reads when deciding whether to hand a design off.
{
    const s1 = comp('c1', 'i2c-sensor', 'U1', '0x48'), e1 = comp('c2', 'i2c-eeprom', 'U2', '0x48');
    const nets = [link([s1, 'sda'], [e1, 'sda']), link([s1, 'scl'], [e1, 'scl'])];
    run([s1, e1], nets);   // populates global.window.editor + COMPONENT_SPECS

    delete global.window.GxPipelineGraph;
    new Function('window', fs.readFileSync(
        path.resolve(ROOT, '..', '..', 'assets', 'schema-editor', 'ai', 'pipelineGraph.js'), 'utf8'))(global.window);
    const g = global.window.GxPipelineGraph.build();
    check(!!g, 'GxPipelineGraph.build() returned nothing');
    // No pull-ups (2) + an address collision (1) — clean topology otherwise.
    check(g.verdict.busErrors === 3, `verdict.busErrors ${g.verdict.busErrors}, expected 3`);
    check(g.verdict.connectionErrors === 0, `verdict.connectionErrors ${g.verdict.connectionErrors}, expected 0 ` +
        '(a bus that cannot function is NOT a topology fault — that is the point of gating it separately)');
    check(g.verdict.wireCorrect === false, 'wireCorrect was true on a bus that cannot communicate');

    const checked = global.window.GxPipelineGraph.buildChecked({});
    check(checked.ok === false, 'buildChecked() allowed export of a bus-error graph without force');
    check(/bus\/protocol/.test(checked.error), `buildChecked() reason does not name the bus class: "${checked.error}"`);
}

console.log(`bus checks: ${checks - failures.length}/${checks}`);
if (failures.length) {
    console.log(`FAIL — ${failures.length} check(s):`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log('PASS — I2C lines without pull-ups, SPI chip-selects shorted, UART TX');
console.log('       wired to TX, and a shared I2C address are all findings now — and');
console.log('       none of them are topology faults any existing rule could see.');