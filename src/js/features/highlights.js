/* ============================================================
   SVG Wiring Editor; Highlights Feature
   Component highlights, connection colouring, clear all
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Components (non-pin shape children of domain symbols) ────
    //   A placed symbol group contains: shape children (component),
    //   circle.pin-point children (connector), and .sym-value text (label).
    //   Only shape children that are neither pin-points nor labels are components.
    highlightComponents() {
        this.showLoading(true);
        const before = this.captureHighlightState();

        // GeoEngine-tracked components (shapes, primitives from imported SVGs)
        (this.components || []).forEach(comp => comp.$element?.addClass('component-highlight'));

        // Shape children inside domain-symbol groups (not connectors, not labels)
        this._contentRoot?.querySelectorAll('[data-symbol] > *')
            .forEach(el => {
                if (!el.classList.contains('pin-point') && !el.classList.contains('sym-value'))
                    el.classList.add('component-highlight');
            });

        const after = this.captureHighlightState();
        this.pushHistory('Highlight Components', before, after);
        this.showToast(`Highlighted components`, 'success');
        this.showLoading(false);
    },

    hideComponentBox() {
        const before = this.captureHighlightState();
        (this.components || []).forEach(comp => comp.$element?.removeClass('component-highlight'));
        this._contentRoot?.querySelectorAll('[data-symbol] > *')
            .forEach(el => el.classList.remove('component-highlight'));
        const after = this.captureHighlightState();
        this.pushHistory('Hide Components', before, after);
        this.showToast('Component highlights removed', 'success');
    },

    // ── Modules (the whole domain-symbol group) ───────────────────
    //   The [data-symbol] <g> itself is the module — the assembled symbol.
    highlightModules() {
        const before = this.captureHighlightState();
        this._contentRoot?.querySelectorAll('[data-symbol]')
            .forEach(el => el.classList.add('module-highlight'));
        const after = this.captureHighlightState();
        this.pushHistory('Highlight Modules', before, after);
        this.showToast('Highlighted modules', 'success');
    },

    hideModules() {
        const before = this.captureHighlightState();
        this._contentRoot?.querySelectorAll('[data-symbol]')
            .forEach(el => el.classList.remove('module-highlight'));
        this.$svgDisplay.find('.module-highlight').removeClass('module-highlight');
        const after = this.captureHighlightState();
        this.pushHistory('Hide Modules', before, after);
        this.showToast('Module highlights removed', 'success');
    },

    // ── Connectors (circle.pin-point inside domain symbols) ───────
    //   Falls back to DOM query so it works without GeoEngine analysis.
    highlightConnectors() {
        const before = this.captureHighlightState();
        // GeoEngine-tracked connectors (from imported SVG analysis)
        (this.connectors || []).forEach(con => con.$element?.addClass('wire-endpoint'));
        // DOM fallback: pin-point circles placed via the symbol palette
        this._contentRoot?.querySelectorAll('[data-symbol] circle.pin-point')
            .forEach(el => el.classList.add('wire-endpoint'));
        const after = this.captureHighlightState();
        this.pushHistory('Highlight Connectors', before, after);
        this.showToast(`Highlighted connectors`, 'success');
    },

    hideConnectors() {
        const before = this.captureHighlightState();
        (this.connectors || []).forEach(con => con.$element?.removeClass('wire-endpoint'));
        this._contentRoot?.querySelectorAll('[data-symbol] circle.pin-point')
            .forEach(el => el.classList.remove('wire-endpoint'));
        this.$svgDisplay.find('.wire-endpoint').removeClass('wire-endpoint');
        const after = this.captureHighlightState();
        this.pushHistory('Hide Connectors', before, after);
    },

    // ── Wire endpoint connectors near a single wire's endpoints ──
    //    Called by wireTracing and geometryEngine after tracing a wire.
    highlightWireEndpoints(wire) {
        if (!wire?.endpoints) return;
        const EPS = 8;
        wire.endpoints.forEach(ep => {
            (this.connectors || []).forEach(con => {
                const b  = con.bbox;
                const cx = b.x + b.width  / 2;
                const cy = b.y + b.height / 2;
                if (Math.hypot(ep.x - cx, ep.y - cy) < EPS)
                    con.$element?.addClass('wire-endpoint');
            });
        });
    },

    // ── Wires ────────────────────────────────────────────────────
    showConnections() {
        const before = this.captureHighlightState();
        const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#f0932b', '#6c5ce7'];

        (this.wires || []).forEach((wire, i) => {
            const color = colors[i % colors.length];
            const isSpecialPath = wire.$element?.is('path') &&
                wire.$element.attr('d') &&
                /[lvVhH]/.test(wire.$element.attr('d'));
            wire.$element?.css({ stroke: isSpecialPath ? '#4facfe' : color, 'stroke-width': '5px' });
        });

        const after = this.captureHighlightState();
        this.pushHistory('Show Connections', before, after);
        this.showToast('Showing wire connections', 'success');
    },

    hideConnections() {
        const before = this.captureHighlightState();
        // Restore the wire's original color; blanking stroke makes wires with
        // inline-style-only stroke permanently invisible (no SVG attribute fallback)
        (this.wires || []).forEach(wire =>
            wire.$element?.css({ stroke: wire.color || '', filter: '' }));
        const after = this.captureHighlightState();
        this.pushHistory('Hide Connections', before, after);
        this.showToast('Wire connections hidden', 'success');
    },

    // ── Clear all ────────────────────────────────────────────────
    clearAllHighlights() {
        const before = this.captureHighlightState();

        // Remove all CSS-class-based highlights
        this.$svgDisplay.find(
            '.wire-trace, .component-highlight, .module-highlight, ' +
            '.selected-element, .wire-endpoint, .wire-hover, ' +
            '.canvas-overlay-hover, .wire-net-highlight'
        ).removeClass(
            'wire-trace component-highlight module-highlight ' +
            'selected-element wire-endpoint wire-hover ' +
            'canvas-overlay-hover wire-net-highlight'
        );

        // Restore wire original colors (blanking stroke makes wires with inline-only stroke invisible)
        (this.wires || []).forEach(wire =>
            wire.$element?.css({ stroke: wire.color || '', filter: '' }));

        const after = this.captureHighlightState();
        this.pushHistory('Clear Highlights', before, after);
    },
});
