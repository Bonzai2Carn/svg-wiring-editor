# Features Reference

This document provides a detailed reference for the advanced tools available in the Schematics Editor.

---

## 1. Tools and the canvas

### The tool model
Every drawing tool is a **one-shot action**, not a mode. After a tool commits something it hands the canvas back to **Select**, so your next click manipulates what you just made.

*   **Tool lock (Q)**: pins the active tool so it stays selected after each commit. Use it for repeat drawing. The `Lock tool` button in the Edit toolbar mirrors the shortcut.
*   **Escape**: always cancels an in-progress draw and returns to Select.
*   **Space**: temporarily activates the **Hand** tool for as long as you hold it, then restores the tool you were using. Middle-mouse drag pans from any tool.

### Cursors
The cursor tells you what a drag from the current position will do.

| Over | Cursor | A drag will |
|---|---|---|
| Empty canvas | default | marquee select |
| A draggable object | `move` | move it |
| A resize handle | directional | resize |
| A wire or measurement node | `move` | move that node |
| Hand tool, or Space held | `grab` | pan |

### Canvas background
The **Background** group in the Edit toolbar sets the page colour: a picker plus presets (White, Paper, Blueprint tint, Slate, Ink, Transparent). This is a **document property**, not an editor theme, so it travels with export, save and round-trip, and it undoes. Dark mode remains a separate editor setting.

### The page versus the surface
`#_canvasBg` is the **page**: the printable area and the export viewport. The surface around it is unbounded. You can draw outside the page, it simply will not export. **New Canvas** sets the page size.

---

## 2. Wiring and Connectivity

The Schematics Editor features a sophisticated connectivity engine specifically designed for electrical and logical diagrams.

### Manhattan Routing (`Wire` Tool)
The **Wire** tool (W) uses Manhattan routing, which ensures that connections only use horizontal and vertical lines with 90 or 45-degree bends.

*   **How to use**: Click a starting point, click to add anchor points, and double-click or press Enter to finish. Backspace retracts the last point.
*   **Smooth Bends**: Toggle the **Smooth** button in the toolbar to switch between sharp 90-degree corners and 45-degree chamfered bends.
*   **Alt+click a wire**: branches a new wire from that point.

### Editing an existing wire
Select a single wire and it shows **node handles** instead of a bounding box: a larger circle at each end, a smaller one at every bend. Drag any of them to reshape the wire. Dropping an endpoint on a pin anchors it there; dropping it on empty canvas releases the anchor.

### Cutting a wire
**Double-click a wire** to cut it at that point. A wire is one electrical run from connected pin to connected pin, so cutting produces **two complete runs**, each terminating in a **connector** node. The cut preserves every bend you drew. It never re-routes.

A symbol picker then offers to place a component at the cut. The far half keeps its open connector so you can attach it to the symbol's exit pin deliberately.

> [!NOTE]
> Cutting is only offered on polyline wires. A path containing curves or several subpaths cannot be expressed as a cut without redrawing it, so the editor declines rather than silently flattening your geometry.

### Geometry is never re-routed behind your back
Moving or rotating a symbol **re-anchors** its attached wires: the affected endpoint follows the pin and its neighbouring vertex travels along the same axis, so an orthogonal wire stays orthogonal and every bend you placed survives.

Full re-routing is a command you invoke, never a side effect. Use **Ctrl+Shift+L** (Straighten Wires) when you want the router to redraw a selection.

### Tracing and Highlighting
Use the **Inspect** accordion in the toolbar to analyze connectivity:

*   **Trace Mode (Toggle Switch)**: When ON, selecting a wire or component highlights every connected element in real time.
*   **Highlight Components**: Highlights all symbols to distinguish them from background geometry.
*   **Show Connections**: Renders a temporary netlist overlay showing logical connections between pins.
*   **Hovering a wire** lights up its entire electrically connected net.

---

## 3. Labels: analysis and provenance

**Inspect → Labels** runs the geometry analysis and puts a chip on every analyzed element showing what the analysis decided it is. Click a chip to reclassify.

### Reading a chip
The chip text is a shortcode; hover for the full class name.

| Code | Class |
|---|---|
| `WR` | wire |
| `CMP` | component |
| `MOD` | module |
| `CON` | connector |
| `JNC` | junction |
| `INK` | decoration, excluded from analysis |

The chip's **colour is the provenance**, meaning who decided this class:

| Appearance | Source | Meaning |
|---|---|---|
| Blue | deterministic | The recognizer read an explicit label. Ground truth. |
| Amber, dashed, `?` | inferred | The recognizer guessed from raw geometry. Worth confirming. |
| Green, `✓` | you | You corrected it. |
| Violet, `✦` | AI | The AI driver placed or relabelled it. |

Hovering a chip previews its element. Clicking selects it, flies the camera to it if it is off-screen, and opens the reclassify menu.

### Corrections are recorded
Changing a class records what the recognizer had said alongside what you chose. The legend bar shows the split across the drawing and offers those corrections as a JSON export. A human correction **outranks** any later analysis re-run, so your decision survives every subsequent edit.

### One analysis, every surface
Labels, the Layers **Analysis** view, **ERC**, the **BOM/netlist** and the **Tags & Artifacts** panel all read the same index. Reclassifying updates all of them, and re-runs ERC if its panel is open.

An element classified as a component but carrying no symbol is reported by ERC as `classified-but-unnamed`. The spec-driven rules (pin count, polarity, signal type) cannot run without a symbol, and would otherwise skip that element in silence.

---

## 4. Arrangement and Layers

### Layer Management
Open the **Side Panel** and select the **Layers** tab.

*   **Tree View**: all elements as a hierarchical list.
*   **Analysis View**: elements grouped into semantic buckets (wires, connectors, modules, components, junctions) with a class dropdown on each row.
*   **Visibility (👁)** and **Locking (🔒)** per element or group.
*   **Ordering**: elements at the top render in front.

Clicking any row selects the element **and flies the camera to it**. The same is true of an ERC finding and a Labels chip.

### Grouping logic
*   **Group (Ctrl+G)** and **Ungroup (Ctrl+Shift+G)**, with nested groups supported.

### Selection and resizing
*   Drag empty canvas to marquee. Elements that would be captured light up in cyan **while you drag**, so you can see the result before committing.
*   **Symbols and multi-selections always scale uniformly.** A resistor squashed to 40% height is a wrong resistor, not a smaller one, and a non-uniform group resize deforms each member individually. Hold **Shift** to force uniform scale on anything else.
*   **Shift+R** rotates 90°, **Shift+F** flips.

---

## 5. Precision and Measurement

Measure is a drawing tool, and its settings are separate from it.

### Scale settings (set once)
The **Scale** group in the Edit toolbar holds the measurement unit and a **Calibrate** button. The 📏 button in the bottom toolbar opens the same dialog.

*   **Units**: Pixels, Metric (mm, cm, m), Imperial (in, ft).
*   **Calibration**: state how many pixels equal one unit, for example `100px = 25mm`. The readout beside the dropdown always shows the active scale.
*   Switching to **px** measures in raw canvas units and remembers your calibration for when you switch back.

### Measuring
Activate **Measure** in the Edit toolbar. It behaves exactly like the Wire tool:

*   **Click** to add points. A measurement can be a multi-segment route, not only a straight hop.
*   **Double-click or Enter** finishes, **Backspace** removes the last point, **Escape** cancels.
*   **Click a wire** to measure its full routed length and segment count in one action.
*   Distance, angle and Δx/Δy update **live** as you move, before you commit.

A multi-point measurement gives a length per segment, the turn angle at each interior vertex, and a `Σ` total.

### Measurements are part of the document
A finished measurement is a real annotation: it persists, serializes, exports and undoes. It is tagged as decoration so it can never enter the netlist as a wire.

*   **Select** a measurement to get node handles, exactly like a wire.
*   **Drag a node** to reshape it; every distance and angle recomputes.
*   **Double-click** a measurement to add a node.
*   Endpoints do not snap to pins, because a measurement is not electrically connected to anything.

---

## 6. View

*   **Zoom**, **Fit** and **Rotate** are always available, including while something is selected.
*   **Space+drag** or middle-mouse pans. The wheel zooms at the cursor.
*   **Reset View** returns to a flat orientation at 100%.

> [!NOTE]
> The earlier 3D pitch and yaw transforms have been removed. They were applied as CSS transforms, which invalidated `getScreenCTM()` and put every selection handle in the wrong place. Zoom, pan and rotation are now pure SVG, so handle positions are always correct. Exported SVG is unaffected.
