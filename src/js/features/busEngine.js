/* ============================================================
   Schematics Editor — Protocol/bus checks (window.MobileSVGEditor)
   ------------------------------------------------------------
   knowledgeEngine.js's rules are the multimeter: values, and
   "component X requires companion Y". These are the logic analyzer
   rung: buses. I2C with no pull-ups, SPI with two chip-selects
   shorted, a UART pair wired TX to TX, two I2C devices that both
   answer the same address. None of these need a solver — they are
   the same kind of graph query the knowledge pack runs, asked about
   a richer vocabulary: a pin's BUS ROLE (sda/scl/mosi/miso/cs/
   tx/rx) read from the pin's own NAME, and shared-net membership.

   Two honest limits, both by design, both failing as a missed check
   rather than a false accusation:

     - A bus role is carried by the pin NAME, not the electrical
       role — there is no structural shape that says "this pin is an
       SCL line". So like _kIsInductiveLoad, this reads the label.
     - A "pull-up" is detected as "some resistor on the line", not
       "a resistor to VCC". A pull-DOWN would fool it. Checking the
       resistor's far end is another graph hop; v1 skips it.

   Self-contained on purpose: it builds its own pin->net index and
   its own resistor detector rather than borrowing knowledgeEngine's,
   so a host that loads ercEngine.js + busEngine.js (and nothing
   else) still gets every rule — same degrade-don't-assume discipline
   as the rest of the engine files. Framework-free, attaches work to
   MobileSVGEditor.prototype exactly like ercEngine.js does.
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── bus-role classifier: pin NAME -> bus signal ──────────
    // Tight token list on purpose. A name that is merely similar
    // ('sda1', 'CS_A') comes back null — a missed check on that pin,
    // never a role it does not really have. Aliases cover the common
    // spellings real libraries use (SS = CS, DIN/DOUT = MOSI/MISO).
    _bPinRole(name) {
        const n = String(name || '').trim();
        if (/^sda$/i.test(n)) return 'sda';
        if (/^scl$/i.test(n)) return 'scl';
        if (/^(mosi|sdi|din)$/i.test(n)) return 'mosi';
        if (/^(miso|sdo|dout)$/i.test(n)) return 'miso';
        if (/^(sclk|sck|clk)$/i.test(n)) return 'sclk';
        if (/^(cs|ss)([#]|_n|_b)?$/i.test(n)) return 'cs';
        if (/^tx$/i.test(n)) return 'tx';
        if (/^rx$/i.test(n)) return 'rx';
        return null;
    },

    // ── device detectors: is this component on this kind of bus? ──
    // Description first (a define_ic block names what it is), pin
    // names as confirmation. Same discipline as _kIsInductiveLoad:
    // heuristics, declared as one, failure = missed check.

    _bIsI2cDevice(symbolId, spec) {
        const text = `${symbolId} ${spec?.description || ''}`;
        if (/\b(i2c|iic)\b|inter.?integrated.?circuit|two.?wire/i.test(text)) return true;
        const pins = spec?.pins && Object.keys(spec.pins);
        return !!(pins && (pins.some(p => this._bPinRole(p) === 'sda')
            || pins.some(p => this._bPinRole(p) === 'scl')));
    },

    _bIsSpiDevice(symbolId, spec) {
        const text = `${symbolId} ${spec?.description || ''}`;
        if (/\b(spi|qspi|dspi)\b|serial peripheral interface/i.test(text)) return true;
        const pins = spec?.pins && Object.keys(spec.pins);
        return !!(pins && pins.some(p => ['mosi', 'miso', 'sclk', 'cs'].includes(this._bPinRole(p))));
    },

    _bIsUartDevice(symbolId, spec) {
        const text = `${symbolId} ${spec?.description || ''}`;
        // NOTE: "serial" alone is deliberately NOT a UART signal — "serial
        // peripheral interface" is SPI. Only named UART terms, or tx+rx
        // pins, mark a part as UART.
        if (/\b(uart|usart)\b|rs[- ]?232|rs[- ]?485/i.test(text)) return true;
        const pins = spec?.pins && Object.keys(spec.pins);
        return !!(pins && pins.some(p => this._bPinRole(p) === 'tx')
            && pins.some(p => this._bPinRole(p) === 'rx'));
    },

    _bIsResistorLike(symbolId, spec) {
        return /resistor|resistance/i.test(`${symbolId} ${spec?.description || ''}`);
    },

    // ── component/nets accessors ──────────────────────────────
    _bSymbolOf(c) { return c.element?.getAttribute?.('data-symbol'); },
    _bNameOf(c) { return c.element?.getAttribute?.('data-refdes') || c.element?.id || c.id; },
    _bSpecOf(ctx, c) { const sym = this._bSymbolOf(c); return sym && ctx.specs[sym]; },

    // Same contract as knowledgeEngine's index: "compId|pinId" -> net,
    // built once per run, O(components) instead of O(rules x nets x comps).
    _bBuildPinNetIndex(ctx) {
        const idx = new Map();
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

    _bNetHasResistor(ctx, net, excludeCompId) {
        return [...net.compIds].some(cid => {
            if (excludeCompId != null && cid === excludeCompId) return false;
            const c = ctx.components.find(x => x.id === cid);
            if (!c) return false;
            const sym = this._bSymbolOf(c);
            const spec = sym && ctx.specs[sym];
            return spec && this._bIsResistorLike(sym, spec);
        });
    },

    // A net touching a power or ground pin is a hard-wired rail. Used to
    // skip the legit "CS# tied to ground = always enabled" pattern, which
    // is a select that never contends, not a collision.
    _bNetTouchesPower(ctx, net) {
        return [...net.compIds].some(cid => {
            const c = ctx.components.find(x => x.id === cid);
            if (!c) return false;
            const sym = this._bSymbolOf(c);
            const spec = sym && ctx.specs[sym];
            if (!spec?.pins) return false;
            return Object.values(spec.pins).some(p => p.role === 'power' || p.role === 'ground');
        });
    },

    _bValueOf(c) { return c.element?.querySelector?.('text.sym-value')?.textContent?.trim() || ''; },

    // A device's I2C address, where one can be READ deterministically.
    // 0x-hex is accepted outright; a bare decimal only when explicitly
    // labelled "addr"/"address", because a bare number in a value field
    // is usually a component VALUE, and guessing costs a false accuse.
    // 7-bit vs shifted-8-bit spelling (0x50 vs 0xA0) is compared raw in
    // v1 — that miss is a missed check, not a fabricated one.
    _bAddressOf(c, ctx) {
        const spec = this._bSpecOf(ctx, c);
        const hay = `${this._bValueOf(c)} ${spec?.description || ''}`;
        const m = /0[xX]([0-9a-fA-F]+)/.exec(hay);
        if (m) return parseInt(m[1], 16);
        const am = /(?:addr|address)\s*[:=]?\s*(\d{1,3})/i.exec(hay);
        if (am) return parseInt(am[1], 10);
        return null;
    },

    // ── Rule pack ─────────────────────────────────────────────
    // Same contract as _ERC_RULES / _CONNECTION_RULES / _KNOWLEDGE_RULES:
    // { id, severity, check(ctx) → findings }. All four are errors: a
    // bus that cannot function is the same class as a load that destroys
    // itself — a clean netlist by every topology rule, and still wrong.
    _BUS_RULES: [
        {
            // Two I2C devices sharing an open-drain line with no resistor
            // anywhere on it: the line can never be driven high, so the
            // bus cannot clock or transfer data, whatever else is correct.
            id: 'i2c-no-pullups', severity: 'error',
            check(ctx) {
                const idx = this._bBuildPinNetIndex(ctx);
                const out = [];
                const devs = ctx.components.filter(c => this._bIsI2cDevice(this._bSymbolOf(c), this._bSpecOf(ctx, c)));
                if (!devs.length) return out;
                // net -> { sda:Set(devIds), scl:Set(devIds) }, keyed by the
                // net OBJECT (the pin-net index returns objects, and its id
                // may be an internal label).
                const bus = new Map();
                devs.forEach(c => {
                    const spec = this._bSpecOf(ctx, c);
                    Object.keys(spec.pins).forEach(pid => {
                        const role = this._bPinRole(pid);
                        if (role !== 'sda' && role !== 'scl') return;
                        const net = idx.get(`${c.id}|${pid}`);
                        if (!net) return;
                        if (!bus.has(net)) bus.set(net, { sda: new Set(), scl: new Set() });
                        bus.get(net)[role].add(c.id);
                    });
                });
                bus.forEach((lines, net) => {
                    ['sda', 'scl'].forEach(line => {
                        // One node on a line is not a bus yet — a half-drawn
                        // stub is unconnected-pin's job, and flagging it here
                        // would double-report on every incomplete design.
                        if (lines[line].size < 2) return;
                        if (this._bNetHasResistor(ctx, net, null)) return;
                        out.push({
                            message: `I2C ${line.toUpperCase()} line "${net.id}" carries ${lines[line].size} devices and no pull-up resistor — an open-drain line with nothing to pull it high cannot clock or transfer data (e.g. 4.7kΩ to VCC)`,
                            elementIds: [...lines[line]].map(id => ctx.components.find(x => x.id === id)?.element?.id).filter(Boolean),
                        });
                    });
                });
                return out;
            },
        },
        {
            // Two SPI chip-selects shorted on one net: both slaves answer
            // the same select and their MISO drivers contend — a logic
            // fault, not a hygiene warning.
            id: 'spi-cs-collision', severity: 'error',
            check(ctx) {
                const idx = this._bBuildPinNetIndex(ctx);
                const out = [];
                const csOnNet = new Map();   // net -> [{c, pid}]
                ctx.components.forEach(c => {
                    if (!this._bIsSpiDevice(this._bSymbolOf(c), this._bSpecOf(ctx, c))) return;
                    const spec = this._bSpecOf(ctx, c);
                    Object.keys(spec.pins).forEach(pid => {
                        if (this._bPinRole(pid) !== 'cs') return;
                        const net = idx.get(`${c.id}|${pid}`);
                        if (!net) return;
                        if (!csOnNet.has(net)) csOnNet.set(net, []);
                        csOnNet.get(net).push({ c, pid });
                    });
                });
                csOnNet.forEach((entries, net) => {
                    if (entries.length < 2) return;
                    if (this._bNetTouchesPower(ctx, net)) return;
                    const names = entries.map(e => `${this._bNameOf(e.c)}.${e.pid}`).join(', ');
                    out.push({
                        message: `${entries.length} chip-select pins shorted on net "${net.id}" (${names}) — both slaves will answer the same select, and their data outputs contend; give each device its own CS net`,
                        elementIds: entries.map(e => e.c.element?.id).filter(Boolean),
                    });
                });
                return out;
            },
        },
        {
            // Two UART transmitters on one line: nothing is wired to a
            // receiver, so the pair can never exchange a byte. The classic
            // "TX to TX" cross-wire.
            id: 'uart-wired-tx-tx', severity: 'error',
            check(ctx) {
                const idx = this._bBuildPinNetIndex(ctx);
                const out = [];
                const txOnNet = new Map();   // net -> [devices]
                ctx.components.forEach(c => {
                    if (!this._bIsUartDevice(this._bSymbolOf(c), this._bSpecOf(ctx, c))) return;
                    const spec = this._bSpecOf(ctx, c);
                    Object.keys(spec.pins).forEach(pid => {
                        if (this._bPinRole(pid) !== 'tx') return;
                        const net = idx.get(`${c.id}|${pid}`);
                        if (!net) return;
                        if (!txOnNet.has(net)) txOnNet.set(net, []);
                        txOnNet.get(net).push(c);
                    });
                });
                txOnNet.forEach((devs, net) => {
                    if (devs.length < 2) return;
                    out.push({
                        message: `${devs.length} UART TX pins wired together on net "${net.id}" (${devs.map(d => this._bNameOf(d)).join(', ')}) — two transmitters drive one line and neither side has a receiver on it; cross each TX to the other device's RX`,
                        elementIds: devs.map(d => d.element?.id).filter(Boolean),
                    });
                });
                return out;
            },
        },
        {
            // Two I2C devices on the same bus (same SDA line) answering
            // the same address. Only READ addresses collide — one that
            // cannot be determined stays out of the comparison entirely.
            id: 'i2c-address-collision', severity: 'error',
            check(ctx) {
                const idx = this._bBuildPinNetIndex(ctx);
                const out = [];
                const devs = ctx.components.filter(c => this._bIsI2cDevice(this._bSymbolOf(c), this._bSpecOf(ctx, c)));
                if (devs.length < 2) return out;
                // Group by SDA net: the same SDA line is the same bus.
                const byBus = new Map();   // net -> [{c, addr}]
                devs.forEach(c => {
                    const spec = this._bSpecOf(ctx, c);
                    const sdaPin = Object.keys(spec.pins).find(pid => this._bPinRole(pid) === 'sda');
                    const net = sdaPin && idx.get(`${c.id}|${sdaPin}`);
                    if (!net) return;
                    if (!byBus.has(net)) byBus.set(net, []);
                    byBus.get(net).push({ c, addr: this._bAddressOf(c, ctx) });
                });
                byBus.forEach((entries, net) => {
                    if (entries.length < 2) return;
                    const byAddr = new Map();   // addr -> [{c}]
                    entries.forEach(e => {
                        if (e.addr == null) return;
                        if (!byAddr.has(e.addr)) byAddr.set(e.addr, []);
                        byAddr.get(e.addr).push(e);
                    });
                    byAddr.forEach((group, addr) => {
                        if (group.length < 2) return;
                        out.push({
                            message: `I2C devices ${group.map(e => this._bNameOf(e.c)).join(', ')} all answer address 0x${addr.toString(16).toUpperCase()} on bus "${net.id}" — only one device may own an address; change one device's strapping`,
                            elementIds: group.map(e => e.c.element?.id).filter(Boolean),
                        });
                    });
                });
                return out;
            },
        },
    ],

    /**
     * How much of the schematic the bus rules could reason about — same
     * discipline as _ercCoverage / _knowledgeCoverage: a caller must be
     * able to tell "checked a bus, found nothing" apart from "found
     * nothing because there was no bus to check".
     */
    _busCoverage(ctx) {
        let i2cDevices = 0, i2cLinesChecked = 0;
        let spiDevices = 0, csNetsChecked = 0;
        let uartDevices = 0, txNetsChecked = 0;
        let addressesPresent = 0, addressesChecked = 0;
        const idx = this._bBuildPinNetIndex(ctx);

        const i2cDevs = ctx.components.filter(c => this._bIsI2cDevice(this._bSymbolOf(c), this._bSpecOf(ctx, c)));
        i2cDevices = i2cDevs.length;
        const bus = new Map();
        i2cDevs.forEach(c => {
            const spec = this._bSpecOf(ctx, c);
            Object.keys(spec?.pins || {}).forEach(pid => {
                const role = this._bPinRole(pid);
                if (role !== 'sda' && role !== 'scl') return;
                const net = idx.get(`${c.id}|${pid}`);
                if (!net) return;
                if (!bus.has(net)) bus.set(net, { sda: new Set(), scl: new Set() });
                bus.get(net)[role].add(c.id);
            });
        });
        bus.forEach(lines => {
            ['sda', 'scl'].forEach(line => { if (lines[line].size >= 2) i2cLinesChecked++; });
        });

        const spiDevs = ctx.components.filter(c => this._bIsSpiDevice(this._bSymbolOf(c), this._bSpecOf(ctx, c)));
        spiDevices = spiDevs.length;
        const csOnNet = new Map();
        spiDevs.forEach(c => {
            const spec = this._bSpecOf(ctx, c);
            Object.keys(spec?.pins || {}).forEach(pid => {
                if (this._bPinRole(pid) !== 'cs') return;
                const net = idx.get(`${c.id}|${pid}`);
                if (!net) return;
                if (!csOnNet.has(net)) csOnNet.set(net, []);
                csOnNet.get(net).push(c.id);
            });
        });
        csOnNet.forEach(entries => { if (entries.length >= 2) csNetsChecked++; });

        const uartDevs = ctx.components.filter(c => this._bIsUartDevice(this._bSymbolOf(c), this._bSpecOf(ctx, c)));
        uartDevices = uartDevs.length;
        const txOnNet = new Map();
        uartDevs.forEach(c => {
            const spec = this._bSpecOf(ctx, c);
            Object.keys(spec?.pins || {}).forEach(pid => {
                if (this._bPinRole(pid) !== 'tx') return;
                const net = idx.get(`${c.id}|${pid}`);
                if (!net) return;
                if (!txOnNet.has(net)) txOnNet.set(net, []);
                txOnNet.get(net).push(c.id);
            });
        });
        txOnNet.forEach(entries => { if (entries.length >= 2) txNetsChecked++; });

        const byBus = new Map();
        i2cDevs.forEach(c => {
            const spec = this._bSpecOf(ctx, c);
            const sdaPin = Object.keys(spec?.pins || {}).find(pid => this._bPinRole(pid) === 'sda');
            const net = sdaPin && idx.get(`${c.id}|${sdaPin}`);
            if (!net) return;
            if (!byBus.has(net)) byBus.set(net, []);
            byBus.get(net).push(c);
        });
        byBus.forEach(group => {
            const addrs = group.map(c => this._bAddressOf(c, ctx)).filter(a => a != null);
            addressesPresent += addrs.length;
            // Only addresses that were actually COMPARED count as checked —
            // a lone address on a bus has nothing to collide with.
            if (addrs.length >= 2) addressesChecked += addrs.length;
        });

        return {
            i2cDevices, i2cLinesChecked,
            spiDevices, csNetsChecked,
            uartDevices, txNetsChecked,
            addressesPresent, addressesChecked,
        };
    },
});