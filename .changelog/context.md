<!-- INJECTION POLICY
tier 1 — always inject:  context.md  task-manager.md  scratch.md
tier 2 — task start:     portfolio.md  decisions.md  errors.md
tier 3 — on demand:      memory.md  decisions-archive.md  session-log.md
size targets:
  context.md       ≤ 500 toks
  task-manager.md  ≤ 300 toks
  portfolio.md     ≤ 1000 toks
  memory.md        ≤ 3000 toks
  decisions.md     ≤ 100 lines → archive oldest 50 when exceeded
pruning rule:
  end of session → append context.md handoff block to session-log.md,
  then reset context.md to blank template
-->

## Session Handoff

last_file: src/js/core/geometryEngine.js
active_task: Interactivity overhaul complete + browser-verified (2026-07-17). Shipping as extension 0.1.5.
branch_state: uncommitted changes (geometryEngine, canvasEngine, drawingTools, ercEngine, history, svgEditor, svgEditorUI.css, index.html + electrical/general/floorplan pages)

## What happened this session (2026-07-17 — Interactivity overhaul, live-verified)

1. **Live electrical graph fixed** (`geometryEngine.js`): placed symbols keep translate/rotate transforms, but `_scoreTaggedEl` measured bboxes with local-space `getBBox()` while wire endpoints are document-space — port discovery never matched (ERC said "0/2 pins connected" on correct circuits; imports worked because they're flattened). Added `_elWorldMatrix()` (consolidated transform walk, stops below `_cameraRotGroup`), world-projected symbol bboxes, and pin-accurate port matching (`.pin-point` world positions, tol 8, records `pinId`; bbox inference kept for pinless imports).

2. **Analysis tracks every edit** (`history.js`): `pushHistory` calls `_scheduleGeoAnalysis()` (debounced 600ms, electrical-only, defers while `_moveActive`/`_drawState`/`_marqueeState`/`_resizeState`/`_rotateState`). Covers draw/move/delete/paste/rotate/group without per-feature wiring. `_createWireHitboxes` remaps `_selection` when it swaps a selected wire's node.

3. **Stamp placement + refdes** (`domainManager.js`, main-repo assets): palette click arms cursor-ghost stamping (capture-phase listeners; R rotates, Esc/right-click ends; grid-snapped origins). Electrical placements get `data-refdes` R1/C2/D3 via `_REFDES_PREFIX` + `_nextRefdes()`; ERC findings and BOM (panel + CSV Refs column) use them. `registerDomainKit` re-renders the palette if its mode is already active (fixes 150ms-mode-apply vs 200ms-kit-registration race).

4. **Wiring UX** (`drawingTools.js`): wire auto-commits when a click lands on a pin; degenerate zero-span wires cancelled; endpoint style picker moved to bottom:118px (was colliding with hint toasts). Hover on a wire hitbox now lights the whole net (`canvasEngine.js` mouseenter/mouseleave.net).

5. **Selection/hit-testing**: closed user shapes (rect/ellipse/circle/polygon `el_*`) get `pointer-events: all` (CSS) so interiors are clickable; open paths keep stroke-only hits. Marquee skips `.wire-hitbox`/`.component-hitbox`/wrapper groups. `rotateSelected(90)`/`flipSelected('h')` on Shift+R/Shift+F; lone domain-symbol pivots on its own origin (consolidated matrix e/f).

6. **First-run + mode pages**: Edit tab open by default; `#canvasFirstRunHint` retired by a MutationObserver in history.js when content appears. electrical/general/floorplan pages (full duplicates of root index.html) were missing ALL ERC work — ported ercBtn + component-specs/ctmAdapter/ercEngine scripts, hint, Edit-default; added path-derived `__GINEXYS_INITIAL_MODE__` (folder name = mode, floorplan→construction). ERC icon fixed (`material-symbols:fact-check-outline`).

**Verified in fresh browser**: stamp → wire → ERC shows true 1/2-pin errors with refdes names; BOM "2× R1 R2 resistor 10kΩ"; hover net glow; Shift+R pivots on origin; interior click selects.

**Known debt**: phantom pin-records inflate net compIds (noise); mode pages remain full duplicates until iframe shells; user-shape resize still scale-transform based.

## Session Handoff

last_file: tools/schema-editor/src/js/canvas/snapGrid.js
active_task: Canvas interaction hardening (marquee, group-select, system node protection)
branch_state: uncommitted changes (10+ files modified)

## What happened this session (Apr 19 2026) — Part 2

**Canvas Interaction Hardening:**

1. **SVGMatrix fix** (`canvasEngine.js`): `_getSelectionScreenCorners()` — replaced `ctm.multiply(m)` with two-step: `DOMPoint.matrixTransform(DOMMatrix)` then `svgPt.matrixTransform(SVGMatrix)`. `getScreenCTM()` returns `SVGMatrix`; its `.multiply()` rejects `DOMMatrix` args.

2. **Ctrl+Drag marquee** (`canvasEngine.js`): `_startMarquee()` on Ctrl+mousedown on background; `_drawMarquee()` renders live dashed rect on overlay canvas; `_commitMarquee()` tests AABB overlap in doc-local space. Uses `$svgDisplay.find('*').not(...)` (mirrors `selectAll()`) to enumerate candidates — no `el.id` filter (domain symbols have no id). Deduplicates via `seen` Set, prefers `.domain-symbol` group over inner shapes.

3. **Multi-selection group preservation** (`canvasEngine.js`): mousedown checks `this._selection.includes(el)` before `selectEl()`. If clicked element is already selected → skip select, call `_startMoveSelected` directly → full group moves together, master bbox stays unified.

4. **System node protection** (`snapGrid.js`, `wiringDiagram.js`, `canvasEngine.js`): `data-se-system="true"` on `_gridDefs`, `_gridLayer`, `_cameraRotGroup` at creation. Excluded from `selectAll()`, `_commitMarquee()` via `.not('[data-se-system]')`; `deleteSelected()` safety filter; mousedown `isIgnored` checks `target.dataset.seSystem === 'true'` (element-only, NOT `closest()` — all user content is inside `_cameraRotGroup`).

**ElectricalKit expanded:** User built out additional symbols in `electricalKit.js` (inventory lives in the file).

## What happened this session (Apr 19 2026)

**5-Bug Architectural Sweep:**

1. **CameraMatrix rotation** (`cameraMatrix.js`, `viewTransform.js`): Added `_rotation`/`setRotation()`/`get rotation()`. `updateTransform()` reads `camera.rotation` not `this.currentRotation`. `setRotation()` writes camera first. `getState()`/`setState()` include rotation.

2. **Wire click-to-commit** (`drawingTools.js`): Replaced drag-to-draw with polygon-style click-to-commit. `_wireClick()` starts/extends, `_wireMove()` live-previews (reads `_smoothTrace` each frame), `_wireCommit()` on dblclick/Enter. `_wireSnapToPort()` snaps to `.pin-point` within 12 SVG units. `_wirePathFromPoints()` shared helper. No change on mouseup.

3. **BBox selection tightness** (`canvasEngine.js`): Added `_getSelectionScreenCorners()` — projects element tight-bbox corners through `element-CTM × _cameraRotGroup.getScreenCTM()` directly to screen space. `_renderOverlay()` now uses this instead of world-AABB. Fixes bloat at camera rotation and element rotation.

4. **Delete stale refs** (`canvasEngine.js`): `deleteSelected()` now clears `this.wires`, `this.components`, `this.connectors` and calls `_scheduleGeoAnalysis?.()` after removal. Matches what `_applyHistoryState` already did for undo.

5. **Text-edit camera lock** (`canvasEngine.js`, `viewTransform.js`, `svgEditor.js`): `_editSymbolText()` sets `_textEditActive = true` + `_hammer.set({ enable: false })`, restores on commit/escape/blur. `startDrag()` and `handleWheel()` both guard. Hammer panstart/pinchmove guard too. `setupGestures()` stores `this._hammer`.

## What happened this session (Apr 18 2026)

**Symbol palette SVG preview fix:**
- `domainManager.js` `_renderSymbolPalette`: wrapped `sym.svgPreview` in `<svg viewBox="0 0 65 52">` — browsers need a proper SVG root to render shape primitives inside a div

**Highlight classification fix (highlights.js):**
- `highlightComponents`: changed from `[data-symbol]` (whole group) → `[data-symbol] > *` filtered to exclude `.pin-point` and `.sym-value`
- `highlightConnectors`: added DOM fallback `[data-symbol] circle.pin-point` alongside `this.connectors` array
- Module = whole `[data-symbol]` group (unchanged/correct)

**Locked-layer system:**
- `svgEditor.js:461`: `_canvasBg` rect gets `data-locked="true"` at new-canvas creation
- `wiringDiagram.js` `_mountParsedSvg`: locks any imported `#_canvasBg` after mount
- `canvasEngine.js` `_bindCanvasEvents`: blocks clicking locked elements (toast)
- `canvasEngine.js` `deleteSelected`: filters out locked elements, warns if any skipped
- `layers.js` `buildLayersTree`: filters `_gridLayer` from tree (grid only via toggle button)
- `layers.js` `_buildFlatLayerTree`: lock icon per item, click toggles `data-locked`, locked items show amber border + italic dimmed name, rename blocked while locked
- `svgEditorUI.css`: `.layer-item-locked`, `.layer-lock-btn`, light-mode overrides

**Undo wire-array bug fix (history.js):**
- Root cause: wire-group wrappers have no `id` → invisible to `_captureFullState` → stale `this.wires/components/connectors` arrays after undo
- Fix: in `_applyHistoryState`, after `_restoreFullState`, clear all three arrays and call `_scheduleGeoAnalysis?.()` to rebuild from restored DOM

## Architecture Contract (stable)

| Space | Definition | Who uses it |
|---|---|---|
| **Document-local** | `_cameraRotGroup`'s local coordinate space. All element `transform=` attrs, `getBBox()` results, `_getSelectionBBoxWorld`, `screenToSVG`. | Drawing, selection, snap |
| **SVG root** | SVG viewport space. Only used internally by `getScreenCTM()` chain. | Nobody directly |
| **Screen** | CSS pixels relative to `#svgContainer` top-left. | Handle overlay canvas, drag events |
| Mapping: doc-local → screen | `_cameraRotGroup.getScreenCTM()` | `_worldToOverlayScreen`, `screenToSVG` |
| Mapping: screen → doc-local | `_cameraRotGroup.getScreenCTM().inverse()` | `screenToSVG` |

## Lock contract

| Element | Locked by default | Can unlock |
|---|---|---|
| `#_canvasBg` | Yes (`data-locked="true"`) | Yes — via lock icon in Layers panel |
| `#_gridLayer` | Hidden from Layers panel entirely | N/A — only Grid ON/OFF toggle |
| Domain symbols | No | N/A |
| Drawn shapes | No | User can lock manually via Layers |

## Active Commits (HEAD per repo)

portfolio:        eaee4da  "Updated schema-editor to use proper rendering engine for SVG"
schema-editor:    0fdcf7b  "updated the README.md" — 7 files modified, not committed

## next_action

  1. Commit all schema-editor changes (10+ files, all today's work)
  2. Wire delete: click bezier hit-test + Delete key (not yet implemented)
  3. Table mode: row count gate (warn > 5k) + chunked render
  4. Connect TAFNE to canvas via PostMessage / IFC bus
  5. PDF processor frontend wiring
