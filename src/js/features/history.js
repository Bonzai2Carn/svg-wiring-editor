/* ============================================================
   Schematics Editor — Undo / Redo History
   Upgraded: full SVG mutation history (innerHTML snapshots)
   Backward-compatible: retains captureHighlightState() for legacy callers
   ============================================================ */

Object.assign(MobileSVGEditor.prototype, {

    // ── Full SVG state (Phase 1+) ─────────────────────────────

    /**
     * Called by canvasEngine, drawingTools, clipboard, etc.
     * Stores the full innerHTML of #svgDisplay.
     */
    pushHistory(label, before, after) {
        // Discard redo tail
        this._historyStack = this._historyStack.slice(0, this._historyIndex + 1);

        // Deduplicate: skip if nothing changed
        if (before === after && before !== '') {
            this._syncUndoRedoUI();
            return;
        }

        this._historyStack.push({ label, before, after });
        if (this._historyStack.length > 100) {
            this._historyStack.shift();
        } else {
            this._historyIndex++;
        }
        this._syncUndoRedoUI();

        // Every push marks a completed topology edit (draw, move, delete, paste,
        // rotate…) — refresh the electrical graph so ERC, nets, and pin badges
        // track the live scene instead of the last import.
        this._scheduleGeoAnalysis?.();
    },

    undo() {
        if (this._historyIndex < 0) return;
        const entry = this._historyStack[this._historyIndex];
        this._historyIndex--;
        this._applyHistoryState(entry.before, `Undo: ${entry.label}`);
    },

    redo() {
        if (this._historyIndex >= this._historyStack.length - 1) return;
        this._historyIndex++;
        const entry = this._historyStack[this._historyIndex];
        this._applyHistoryState(entry.after, `Redo: ${entry.label}`);
    },

    /**
     * Apply a history state. Detects whether it's a full HTML string
     * or a legacy highlight snapshot (array of objects).
     */
    _applyHistoryState(state, toastMsg) {
        if (Array.isArray(state)) {
            // Legacy path — highlight-only snapshot
            this.restoreHighlightState(state);
        } else if (typeof state === 'string' && state.length > 0) {
            // Full DOM restore
            this._restoreFullState(state);
            this.deselectAll?.();
            // Wire-group wrappers have no IDs so they aren't snapshotted.
            // Clearing stale arrays and rescheduling analysis keeps the topology
            // in sync with whatever the restored DOM actually contains.
            this.wires      = [];
            this.components = [];
            this.connectors = [];
            this._scheduleGeoAnalysis?.();
        }
        this._syncUndoRedoUI();
        if (toastMsg) this.showToast(toastMsg, 'success');
    },

    _syncUndoRedoUI() {
        const canUndo = this._historyIndex >= 0;
        const canRedo = this._historyIndex < this._historyStack.length - 1;
        $('#undoBtn').prop('disabled', !canUndo).toggleClass('disabled', !canUndo);
        $('#redoBtn').prop('disabled', !canRedo).toggleClass('disabled', !canRedo);
    },

    // ── Legacy highlight-state API (kept for backward compat) ─

    captureHighlightState() {
        const entries = [];
        this.$svgDisplay.find('*').each(function () {
            if (!this.style) return;
            entries.push({
                el:          this,
                cls:         this.getAttribute('class') || '',
                stroke:      this.style.stroke,
                strokeWidth: this.style.strokeWidth,
                filter:      this.style.filter,
                fill:        this.style.fill,
            });
        });
        return entries;
    },

    restoreHighlightState(entries) {
        entries.forEach(({ el, cls, stroke, strokeWidth, filter, fill }) => {
            if (!document.contains(el)) return;
            el.setAttribute('class', cls);
            el.style.stroke      = stroke;
            el.style.strokeWidth = strokeWidth;
            el.style.filter      = filter;
            el.style.fill        = fill;
        });
    },
});

/* First-run canvas hint: retire as soon as any user content reaches the
   canvas by any path (drawing, symbol stamp, file load, OS restore).
   Lives here because every editor page loads history.js; pages without
   the hint div no-op. */
(function () {
    const hint = document.getElementById('canvasFirstRunHint');
    const svgEl = document.getElementById('svgDisplay');
    if (!hint || !svgEl) return;
    const hasContent = () =>
        svgEl.querySelector('[id^="el_"], .domain-symbol, [data-geo-class]');
    if (hasContent()) { hint.remove(); return; }
    const mo = new MutationObserver(() => {
        if (hasContent()) { hint.remove(); mo.disconnect(); }
    });
    mo.observe(svgEl, { childList: true, subtree: true });
})();
