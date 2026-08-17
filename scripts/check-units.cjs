#!/usr/bin/env node
/* ============================================================
   Schematics Editor — unit-parsing regression harness

   units.js is the floor knowledgeEngine.js's value checks stand on:
   before it, no component value anywhere in the system was ever
   read as a NUMBER. A resistor typed "300kW" and one typed
   "300kΩ" were indistinguishable strings.

   Framework-free — GxUnits has no DOM dependency, so this harness
   doesn't need the MobileSVGEditor stub check-knowledge.cjs uses.

   Run: node scripts/check-units.cjs
   ============================================================ */
'use strict';
const path = require('path');
require(path.resolve(__dirname, '..', 'src', 'js', 'features', 'units.js'));
const U = global.GxUnits;

const failures = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) failures.push(msg); };
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-9 : tol);

// ── 1. standard form: number + prefix + unit ──────────────────
{
    const p = U.parseValue('4.7kΩ');
    check(p && near(p.magnitude, 4700) && p.category === 'resistance',
        `"4.7kΩ" parsed as ${JSON.stringify(p)}`);
    const c = U.parseValue('10pF');
    check(c && near(c.magnitude, 1e-11) && c.category === 'capacitance',
        `"10pF" parsed as ${JSON.stringify(c)}`);
    const w = U.parseValue('300kW');
    check(w && near(w.magnitude, 300000) && w.category === 'power',
        `"300kW" parsed as ${JSON.stringify(w)} — the fuse/current-sensor case`);
    const v = U.parseValue('-3.3V');
    check(v && near(v.magnitude, -3.3) && v.category === 'voltage',
        `"-3.3V" parsed as ${JSON.stringify(v)}`);
}

// ── 2. shorthand: letter stands in for the decimal point ──────
{
    const r = U.parseValue('4k7');
    check(r && near(r.magnitude, 4700), `"4k7" magnitude ${r && r.magnitude}, expected 4700`);
    const o1 = U.parseValue('2R2');
    check(o1 && near(o1.magnitude, 2.2) && o1.category === 'resistance',
        `"2R2" parsed as ${JSON.stringify(o1)}`);
    const o2 = U.parseValue('100R');
    check(o2 && near(o2.magnitude, 100) && o2.category === 'resistance',
        `"100R" parsed as ${JSON.stringify(o2)}`);
    const n = U.parseValue('1n5');
    check(n && near(n.magnitude, 1.5e-9), `"1n5" magnitude ${n && n.magnitude}, expected 1.5e-9`);
}

// ── 3. m vs M — the dangerous pair kept case-exact ─────────────
{
    const milli = U.parseValue('4.7mF');
    const mega = U.parseValue('4.7MF');
    check(milli && near(milli.magnitude, 0.0047), `"4.7mF" magnitude ${milli && milli.magnitude}`);
    check(mega && near(mega.magnitude, 4700000), `"4.7MF" magnitude ${mega && mega.magnitude}`);
    check(milli.magnitude !== mega.magnitude, '"4.7mF" and "4.7MF" collapsed to the same magnitude');
}

// ── 4. refuses to invent an answer ─────────────────────────────
{
    check(U.parseValue('2N3904') === null, 'a part number ("2N3904") was parsed as a quantity');
    check(U.parseValue('1.5V AA') === null, 'trailing prose ("1.5V AA") was parsed as a clean value');
    check(U.parseValue('5%') === null, 'a tolerance ("5%") was parsed as a physical quantity');
    check(U.parseValue('') === null, 'an empty string parsed to something');
    check(U.parseValue('   ') === null, 'whitespace parsed to something');
}

// ── 5. checkValue: the resistor bare-number convention ─────────
{
    const ok1 = U.checkValue('resistor', 'Limits current flow', '4.7k');
    check(ok1 && ok1.ok === true && !ok1.missingUnit,
        `bare "4.7k" on a resistor flagged: ${JSON.stringify(ok1)}`);
    const ok2 = U.checkValue('resistor', 'Limits current flow', '100');
    check(ok2 && ok2.ok === true, `bare "100" on a resistor flagged: ${JSON.stringify(ok2)}`);
}

// ── 6. checkValue: the definite mismatch (the fuse/kW case) ────
{
    const bad = U.checkValue('resistor', 'Limits current flow', '300kW');
    check(bad && bad.ok === false && bad.got === 'power' && bad.expected === 'resistance' && !bad.missingUnit,
        `"300kW" on a resistor: ${JSON.stringify(bad)}`);
}

// ── 7. checkValue: prefixed shorthand accepted for non-resistors ──
//    "4n7" IS the standard way to write 4.7nF — the same convention that
//    makes "4k7" a normal resistor value — so it must NOT warn just because
//    it lacks a trailing "F". Only a truly bare number should.
{
    const shorthand = U.checkValue('capacitor', 'Stores electric charge', '4n7');
    check(shorthand && shorthand.ok === true,
        `"4n7" on a capacitor flagged as ambiguous: ${JSON.stringify(shorthand)}`);
    const bare = U.checkValue('capacitor', 'Stores electric charge', '10');
    check(bare && bare.ok === false && bare.missingUnit === true,
        `bare "10" on a capacitor was NOT flagged: ${JSON.stringify(bare)}`);
    const clean = U.checkValue('capacitor', 'Stores electric charge', '10uF');
    check(clean && clean.ok === true, `"10uF" on a capacitor flagged: ${JSON.stringify(clean)}`);
}

// ── 8. checkValue: nothing to check → null, not a false "ok" ───
{
    check(U.checkValue('ic-generic', 'Generic IC placeholder', '4.7k') === null,
        'a part with no expected category still returned a verdict');
    check(U.checkValue('resistor', 'Limits current flow', '2N3904') === null,
        'an unparseable value on a checkable part still returned a verdict');
    check(U.checkValue('resistor', 'Limits current flow', '') === null,
        'an empty value returned a verdict instead of null');
}

// ── 9. keyword fallback (KiCad imports, future parts) ───────────
{
    // dsp/kicad.js's R.kicad_sym imports as id 'r', description 'Resistor' —
    // not in EXPECTED_CATEGORY by id, must resolve through the keyword table.
    const r = U.checkValue('r', 'Resistor', '4k7');
    check(r && r.ok === true, `KiCad-imported "r" + "4k7": ${JSON.stringify(r)}`);
    const fuse = U.checkValue('fuse-5x20', 'A fuse; opens the circuit above its rated current.', '300kW');
    check(fuse && fuse.ok === false && fuse.expected === 'current',
        `a fuse-keyword part + "300kW": ${JSON.stringify(fuse)} — the exact case this session started from`);
}

console.log(`units checks: ${checks - failures.length}/${checks}`);
if (failures.length) {
    console.log(`FAIL — ${failures.length} check(s):`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log('PASS — values parse to real magnitudes and categories, the resistor');
console.log('       bare-number and capacitor/inductor prefix-shorthand conventions');
console.log('       are honoured, and an unparseable or uncheckable value returns');
console.log('       null rather than a fabricated verdict.');
