/* ============================================================
   Schematics Editor — Engineering unit parsing  (window.GxUnits)
   ------------------------------------------------------------
   Every check in ercEngine.js so far is a GRAPH property: is this
   pin connected, do two outputs collide, is power shorted to
   ground. None of them read a VALUE, because nothing in the system
   ever turned a component's value string into a number. A resistor
   typed "300kW" and one typed "300kΩ" were indistinguishable to
   every rule that existed before this file.

   This is the floor everything above it stands on. It does not
   know what a resistor is. It knows that "4k7" means 4700 and that
   "kW" is a unit of power, not resistance, and it hands that back
   as data for knowledgeEngine.js to judge.

   Framework-free — no MobileSVGEditor, no DOM. Runs in the browser
   or under Node (attaches globalThis.GxUnits either way), same
   discipline as the DSPE modules.
   ============================================================ */
(function () {
    'use strict';
    var G = (typeof globalThis !== 'undefined') ? globalThis : window;

    /* SI prefixes this domain actually uses. 'k'/'K' are both accepted as
       kilo — real schematics are inconsistent about the case and kilo is
       never confusable with anything else in this table. 'm' (milli) and
       'M' (mega) are the pair that IS dangerous — 4.7mF and 4.7MF differ by
       nine orders of magnitude — so those two are kept case-exact. */
    var PREFIX_MULT = {
        p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3,
        '': 1,
        k: 1e3, K: 1e3, M: 1e6,
    };

    /* Trailing unit letters → the physical quantity they name. Matched
       case-insensitively except where noted; 'r'/'R'/'Ω' as a UNIT
       (not a prefix — see the shorthand form below) means ohms. */
    var UNIT_CATEGORY = {
        'Ω': 'resistance', ohm: 'resistance', ohms: 'resistance', r: 'resistance',
        f: 'capacitance',
        h: 'inductance',
        v: 'voltage',
        a: 'current',
        w: 'power',
        hz: 'frequency',
    };

    var CATEGORIES = ['resistance', 'capacitance', 'inductance', 'voltage', 'current', 'power', 'frequency'];

    var EXAMPLE = {
        resistance: '4.7kΩ', capacitance: '10µF', inductance: '100µH',
        voltage: '5V', current: '2A', power: '10W', frequency: '1MHz',
    };

    // "4.7kΩ", "10pF", "5V", "2.2" — a decimal number, an optional SI
    // prefix, an optional unit. Anchored: a trailing part-number or a value
    // with descriptive text after it ("1.5V AA") does not match, and that is
    // deliberate — see parseValue's header.
    var STD = /^\s*([+-]?\d+(?:\.\d+)?)\s*(p|n|u|µ|m|k|K|M)?\s*([A-Za-zΩ°%]*)\s*$/;

    // "4k7", "2R2", "1n5" — the shorthand where the prefix/unit LETTER also
    // stands in for the decimal point, because a schematic silkscreen can't
    // print a dot that survives photocopying. The trailing digit group is
    // optional ("100R" is just 100Ω, no fractional part).
    var SHORT = /^\s*([+-]?\d+)\s*(p|n|u|µ|m|k|K|M|R|r|Ω)\s*(\d+)?\s*([A-Za-zΩ°%]*)\s*$/;

    function categoryOf(unitLetters) {
        if (!unitLetters) return null;
        var key = unitLetters.toLowerCase();
        if (unitLetters === 'Ω') key = 'Ω';        // case-fold everything except the ohm glyph
        return UNIT_CATEGORY[key] || null;
    }

    /**
     * Parse an engineering value string into a magnitude + physical category.
     *
     * Returns null when the string does not look like a single physical
     * quantity — a bare part number ("2N3904"), a value with trailing prose
     * ("1.5V AA"), a percentage, or empty. Returning null is the safe
     * default: this module never claims to understand more than it does,
     * and a caller that cannot parse a value must not report a mismatch it
     * did not actually check.
     *
     * `category` is null when magnitude parsed but no unit letter did
     * ("4.7", "300") — see `checkValue` for how that case is judged
     * (differently per expected category, because a bare number IS the
     * normal way to write a resistor's value and is NOT the normal way to
     * write anything else).
     */
    function parseValue(raw) {
        var s = String(raw == null ? '' : raw).trim();
        if (!s) return null;

        var m = STD.exec(s);
        if (m) {
            var suffix = m[3] || '';
            // '%' or a temperature glyph means this string is a tolerance or
            // a rating, not the value this module has any business judging.
            if (/[%°]/.test(suffix)) return null;
            var prefix = m[2] || '';
            var mag = parseFloat(m[1]) * (PREFIX_MULT[prefix] != null ? PREFIX_MULT[prefix] : 1);
            return {
                raw: s, magnitude: mag, category: categoryOf(suffix), unit: suffix || null,
                prefixed: prefix !== '',
            };
        }

        m = SHORT.exec(s);
        if (m) {
            var letter = m[2];
            var isOhmLetter = (letter === 'R' || letter === 'r' || letter === 'Ω');
            var frac = m[3] || '0';
            var value = parseFloat(m[1] + '.' + frac);
            var mult = isOhmLetter ? 1 : (PREFIX_MULT[letter] != null ? PREFIX_MULT[letter] : 1);
            var trailing = m[4] || '';
            if (/[%°]/.test(trailing)) return null;
            // The shorthand letter itself named ohms; a trailing unit letter
            // (rare — "4k7Ω") wins if both are somehow present.
            var cat = categoryOf(trailing) || (isOhmLetter ? 'resistance' : null);
            return {
                raw: s, magnitude: value * mult, category: cat,
                unit: trailing || (isOhmLetter ? 'Ω' : null),
                prefixed: !isOhmLetter,
            };
        }

        return null;
    }

    /* Which physical quantity a symbol's VALUE field is supposed to hold.
       Explicit for the 28-symbol kit, where the answer is exact and known.
       Anything not listed here (an IC, a switch, a define_ic block with no
       fixed quantity) returns null and the mismatch check does not run —
       inventing an expectation for a part with none would be the same
       mistake this module exists to avoid making about VALUES. */
    var EXPECTED_CATEGORY = {
        resistor: 'resistance',
        capacitor: 'capacitance',
        'cap-pol': 'capacitance',
        inductor: 'inductance',
        battery: 'voltage',
        'ac-source': 'voltage',
        vcc: 'voltage',
    };

    /* Fallback for anything not in the explicit table — a KiCad import, a
       future part with no hand-written spec — inferred from its own
       description the same way the KiCad ground heuristic is inferred
       (dsp/kicad.js GROUND_NAMES): read from real data, not assumed. Tried
       only when the id isn't already in EXPECTED_CATEGORY, and only the
       first match wins, so ordering here is significant. */
    var CATEGORY_KEYWORDS = [
        [/resistor|resistance/i, 'resistance'],
        [/capacitor|capacitance/i, 'capacitance'],
        [/inductor|inductance/i, 'inductance'],
        [/\bfuse\b|circuit breaker/i, 'current'],
        [/battery|\bvcc\b|power rail|ac source|mains|voltage source/i, 'voltage'],
    ];

    function inferExpectedCategory(symbolId, description) {
        if (EXPECTED_CATEGORY[symbolId]) return EXPECTED_CATEGORY[symbolId];
        var hay = String(symbolId || '') + ' ' + String(description || '');
        for (var i = 0; i < CATEGORY_KEYWORDS.length; i++) {
            if (CATEGORY_KEYWORDS[i][0].test(hay)) return CATEGORY_KEYWORDS[i][1];
        }
        return null;
    }

    /**
     * Judge one component's value string against what its symbol class is
     * supposed to hold. Returns null when there is nothing to judge — no
     * expected category, or the value did not parse — never when there IS
     * something to judge and it happens to be fine (that returns `ok:true`,
     * so a caller can tell "checked, clean" apart from "not checked").
     */
    function checkValue(symbolId, description, rawValue) {
        var expected = inferExpectedCategory(symbolId, description);
        if (!expected) return null;
        var parsed = parseValue(rawValue);
        if (!parsed) return null;

        if (parsed.category) {
            return {
                ok: parsed.category === expected,
                expected: expected, got: parsed.category,
                magnitude: parsed.magnitude, missingUnit: false,
            };
        }
        // No unit letter resolved a category. Two shapes reach here and they
        // are not equally suspicious:
        //   "4n7", "100u", "2m2"  — an SI prefix WAS given (`prefixed`). This
        //     is the standard shorthand for capacitance/inductance/etc, the
        //     same convention that makes "4k7" a normal resistor value. The
        //     prefix letter already tells a human which quantity this is;
        //     the missing trailing unit tells them nothing they didn't know.
        //   "10", "5"             — no prefix, no unit. For a resistor this
        //     is still the everyday form. For anything else, a bare integer
        //     is genuinely ambiguous — this is the one case worth a warning.
        var ok = expected === 'resistance' || parsed.prefixed;
        return {
            ok: ok, expected: expected, got: null,
            magnitude: parsed.magnitude, missingUnit: !ok,
        };
    }

    G.GxUnits = {
        CATEGORIES: CATEGORIES,
        EXAMPLE: EXAMPLE,
        PREFIX_MULT: PREFIX_MULT,
        UNIT_CATEGORY: UNIT_CATEGORY,
        EXPECTED_CATEGORY: EXPECTED_CATEGORY,
        parseValue: parseValue,
        categoryOf: categoryOf,
        inferExpectedCategory: inferExpectedCategory,
        checkValue: checkValue,
    };
})();
