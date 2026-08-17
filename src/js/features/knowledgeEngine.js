/* ============================================================
   Schematics Editor — Knowledge checks (window.MobileSVGEditor)
   ------------------------------------------------------------
   ercEngine.js's twelve rules are the multimeter: is this pin
   connected, do two outputs collide, is power shorted to ground.
   All graph properties — none of them read a VALUE or know what a
   PART IS. That is a real ceiling: a MOSFET switching a pump with
   no flyback diode is a clean netlist by every one of those rules,
   because nothing about it is topologically wrong. It is wrong
   because a pump is an inductive load, and that is knowledge, not
   graph shape.

   This file is that ceiling raised by exactly two floors:
     1. Values are now NUMBERS (units.js), so a resistor typed
        "300kW" is checkable at all.
     2. A small set of "component X requires companion Y" facts,
        each a graph QUERY plus a WHY — cheap, because they never
        need a solver, only the ability to ask the netlist a
        specific structural question.

   Every detector below is a HEURISTIC over symbol id + description
   text, same discipline as dsp/kicad.js's ground-name heuristic:
   declared as one, and cheap to audit — grep the id/description
   this file matches against, not a hidden model call.
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── detectors: is this component an instance of a pattern? ──
    // Each takes (symbolId, spec) and returns bool. Kept as named,
    // independently testable functions rather than inlined into the rules,
    // so check-knowledge.cjs can assert against them directly.

    _kIsLed(symbolId, spec) {
        const hay = `${symbolId} ${spec?.description || ''}`;
        return /\bled\b|light[- ]emit/i.test(hay);
    },

    // Structural: two passive, analog, POLARIZED pins — the exact shape a
    // diode/zener/schottky spec declares (see component-specs.js) — and not
    // an LED (an LED has the identical pin shape; only its FUNCTION differs,
    // which is why this needs the id check rather than being pin-shape-only).
    _kIsDiodeLike(symbolId, spec) {
        if (this._kIsLed(symbolId, spec)) return false;
        const pins = spec?.pins && Object.values(spec.pins);
        if (!pins || pins.length !== 2) return false;
        return pins.every(p => p.role === 'passive' && p.signalType === 'analog' && p.polarity);
    },

    // Structural: one 'input' + two 'bidir' pins on a 3-pin part — exactly
    // nmos/pmos/npn/pnp's shape (gate/drain/source, base/collector/emitter).
    // A KiCad-imported transistor whose library author used the same
    // electrical-type convention matches this for free; one that didn't
    // (declared its base "passive", say) will not, and that is a real limit
    // of a structural detector, not a bug — it costs a missed check, never a
    // false accusation.
    _kIsSwitchDevice(symbolId, spec) {
        const pins = spec?.pins && Object.values(spec.pins);
        if (!pins || pins.length !== 3) return false;
        const roles = pins.map(p => p.role);
        return roles.filter(r => r === 'input').length === 1
            && roles.filter(r => r === 'bidir').length === 2;
    },

    _kIsResistorLike(symbolId, spec) {
        return /resistor|resistance/i.test(`${symbolId} ${spec?.description || ''}`);
    },

    // No structural marker exists for "this drives a magnetic field" — an
    // inductive load looks like any other 2-terminal block until you read
    // what it IS. `inductor` is the one part in the kit that is inherently
    // one; everything else (a motor, pump, relay, solenoid) currently only
    // exists as an AI-defined enclosure, so this reads the name/description
    // the same way dsp/kicad.js recovers ground from a power symbol's name —
    // a heuristic, and one whose false-negative failure mode (an inductive
    // load this regex misses) is far more likely than its false-positive one.
    _kIsInductiveLoad(symbolId, spec) {
        if (symbolId === 'inductor') return true;
        return /\b(motor|pump|relay|solenoid|coil|fan|actuator|contactor|electromagnet)\b/i
            .test(`${symbolId} ${spec?.description || ''}`);
    },

    // ── net lookup, built once per run ───────────────────────────
    // The four existing _CONNECTION_RULES each re-derive "which pins sit on
    // this net" with their own nested loop. Built once here instead —
    // O(components) rather than O(rules × nets × components).
    _kBuildPinNetIndex(ctx) {
        const idx = new Map();               // "compId|pinId" -> net
        const compById = new Map(ctx.components.map(c => [c.id, c]));
        ctx.nets.forEach(net => {
            net.compIds.forEach(cid => {
                const c = compById.get(cid);
                if (!c) return;
                (c.ports || []).forEach(p => {
                    if (net.wireIds.includes(p.wireId)) idx.set(`${cid}|${p.pinId}`, net);
                });
            });
        });
        return idx;
    },

    _kSymbolOf(c) { return c.element?.getAttribute?.('data-symbol'); },
    _kNameOf(c) { return c.element?.getAttribute?.('data-refdes') || c.element?.id || c.id; },
    _kValueOf(c) { return c.element?.querySelector?.('text.sym-value')?.textContent?.trim() || ''; },

    _kNetHasResistor(ctx, net, excludeCompId) {
        return [...net.compIds].some(cid => {
            if (cid === excludeCompId) return false;
            const c = ctx.components.find(x => x.id === cid);
            if (!c) return false;
            const sym = this._kSymbolOf(c);
            const spec = sym && ctx.specs[sym];
            return spec && this._kIsResistorLike(sym, spec);
        });
    },

    // ── Rule pack ─────────────────────────────────────────────
    // Same contract as _ERC_RULES / _CONNECTION_RULES: { id, severity, check(ctx) }.
    // A finding may set its OWN `severity` to override the rule's default —
    // component-value-mismatch uses this to distinguish a definite wrong-unit
    // (error) from an ambiguous missing-unit (warning) within one rule,
    // rather than forking into two rule ids for what is one detector.
    _KNOWLEDGE_RULES: [
        {
            id: 'inductive-load-no-flyback', severity: 'error',
            check(ctx) {
                const idx = this._kBuildPinNetIndex(ctx);
                const out = [];
                ctx.components.forEach(c => {
                    const sym = this._kSymbolOf(c);
                    const spec = sym && ctx.specs[sym];
                    if (!spec || !this._kIsInductiveLoad(sym, spec)) return;
                    const pinIds = spec.pins && Object.keys(spec.pins);
                    // Scoped to 2-terminal loads. A relay/motor modeled with
                    // more than two pins (coil + NO/NC contacts, say) isn't
                    // checked in v1 — silently skipped, not flagged, because
                    // "which two pins are the coil" isn't derivable here.
                    if (!pinIds || pinIds.length !== 2) return;
                    const netA = idx.get(`${c.id}|${pinIds[0]}`);
                    const netB = idx.get(`${c.id}|${pinIds[1]}`);
                    if (!netA || !netB) return;   // unconnected-pin already covers this

                    const hasFlyback = ctx.components.some(other => {
                        if (other.id === c.id) return false;
                        const osym = this._kSymbolOf(other);
                        const ospec = osym && ctx.specs[osym];
                        if (!ospec || !this._kIsDiodeLike(osym, ospec)) return false;
                        const opins = Object.keys(ospec.pins);
                        if (opins.length !== 2) return false;
                        const n1 = idx.get(`${other.id}|${opins[0]}`);
                        const n2 = idx.get(`${other.id}|${opins[1]}`);
                        if (!n1 || !n2) return false;
                        const set = new Set([n1.id, n2.id]);
                        return set.size === 2 && set.has(netA.id) && set.has(netB.id);
                    });
                    if (!hasFlyback) {
                        out.push({
                            message: `${sym} "${this._kNameOf(c)}": inductive load with no flyback diode across `
                                + `its terminals — the collapsing field will overvoltage whatever switches it`,
                            elementIds: [c.element?.id].filter(Boolean),
                        });
                    }
                });
                return out;
            },
        },
        {
            id: 'led-no-current-limit', severity: 'error',
            check(ctx) {
                const idx = this._kBuildPinNetIndex(ctx);
                const out = [];
                ctx.components.forEach(c => {
                    const sym = this._kSymbolOf(c);
                    const spec = sym && ctx.specs[sym];
                    if (!spec || !this._kIsLed(sym, spec)) return;
                    const pinIds = spec.pins && Object.keys(spec.pins);
                    if (!pinIds || pinIds.length !== 2) return;
                    const netA = idx.get(`${c.id}|${pinIds[0]}`);
                    const netB = idx.get(`${c.id}|${pinIds[1]}`);
                    if (!netA || !netB) return;
                    const limited = this._kNetHasResistor(ctx, netA, c.id)
                        || this._kNetHasResistor(ctx, netB, c.id);
                    if (!limited) {
                        out.push({
                            message: `${sym} "${this._kNameOf(c)}": no series resistor on either terminal — `
                                + `driven directly, the LED draws until it fails`,
                            elementIds: [c.element?.id].filter(Boolean),
                        });
                    }
                });
                return out;
            },
        },
        {
            id: 'floating-switch-control', severity: 'warning',
            check(ctx) {
                const idx = this._kBuildPinNetIndex(ctx);
                const out = [];
                ctx.components.forEach(c => {
                    const sym = this._kSymbolOf(c);
                    const spec = sym && ctx.specs[sym];
                    if (!spec || !this._kIsSwitchDevice(sym, spec)) return;
                    const ctrlPin = Object.keys(spec.pins).find(k => spec.pins[k].role === 'input');
                    if (!ctrlPin) return;
                    const net = idx.get(`${c.id}|${ctrlPin}`);
                    if (!net) return;              // unconnected-pin covers this
                    if (!this._kNetHasResistor(ctx, net, c.id)) {
                        out.push({
                            message: `${sym} "${this._kNameOf(c)}": control pin "${ctrlPin}" has no resistor `
                                + `on its net — verify the driving pin cannot float (e.g. during reset/boot)`,
                            elementIds: [c.element?.id].filter(Boolean),
                        });
                    }
                });
                return out;
            },
        },
        {
            id: 'component-value-mismatch', severity: 'error',
            check(ctx) {
                const out = [];
                if (!window.GxUnits) return out;   // degrade silently if the parser wasn't injected
                ctx.components.forEach(c => {
                    const sym = this._kSymbolOf(c);
                    const spec = sym && ctx.specs[sym];
                    if (!spec) return;
                    const value = this._kValueOf(c);
                    if (!value) return;             // missing-value already covers the empty case
                    const r = window.GxUnits.checkValue(sym, spec.description, value);
                    if (!r || r.ok) return;
                    const ex = window.GxUnits.EXAMPLE[r.expected];
                    const msg = r.missingUnit
                        ? `${sym} "${this._kNameOf(c)}": value "${value}" has no unit — expected a `
                          + `${r.expected} value (e.g. ${ex})`
                        : `${sym} "${this._kNameOf(c)}": value "${value}" is a ${r.got} quantity; `
                          + `${sym} expects ${r.expected} (e.g. ${ex})`;
                    out.push({
                        message: msg,
                        elementIds: [c.element?.id].filter(Boolean),
                        // Override the rule's default 'error' for the ambiguous
                        // case only — see the rule-pack comment above.
                        severity: r.missingUnit ? 'warning' : 'error',
                    });
                });
                return out;
            },
        },
    ],

    /**
     * How much of the schematic the knowledge rules could actually reason
     * about — same discipline as _ercCoverage: a caller must be able to tell
     * "checked N candidates, found 0 problems" apart from "found 0 problems
     * because there were 0 candidates to check".
     */
    _knowledgeCoverage(ctx) {
        let inductiveLoads = 0, inductiveLoadsChecked = 0;
        let leds = 0, ledsChecked = 0, switches = 0;
        let valuesPresent = 0, valuesChecked = 0;
        const idx = this._kBuildPinNetIndex(ctx);
        ctx.components.forEach(c => {
            const sym = this._kSymbolOf(c);
            const spec = sym && ctx.specs[sym];
            if (!spec) return;
            if (this._kIsInductiveLoad(sym, spec)) {
                inductiveLoads++;
                const pinIds = spec.pins && Object.keys(spec.pins);
                if (pinIds && pinIds.length === 2
                    && idx.get(`${c.id}|${pinIds[0]}`) && idx.get(`${c.id}|${pinIds[1]}`)) inductiveLoadsChecked++;
            }
            if (this._kIsLed(sym, spec)) {
                leds++;
                const pinIds = spec.pins && Object.keys(spec.pins);
                if (pinIds && pinIds.length === 2
                    && idx.get(`${c.id}|${pinIds[0]}`) && idx.get(`${c.id}|${pinIds[1]}`)) ledsChecked++;
            }
            if (this._kIsSwitchDevice(sym, spec)) switches++;
            const value = this._kValueOf(c);
            if (value) {
                valuesPresent++;
                if (window.GxUnits && window.GxUnits.checkValue(sym, spec.description, value)) valuesChecked++;
            }
        });
        return {
            inductiveLoads, inductiveLoadsChecked,
            leds, ledsChecked, switches,
            valuesPresent, valuesChecked,
        };
    },
});
