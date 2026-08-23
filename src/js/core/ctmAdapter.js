/* ============================================================
   ctmAdapter (vendored port from pdf-processor)
   Walks a PDF.js operator list, resolving the full CTM chain,
   and emits typed primitives: line segments, bezier curves,
   filled rects — in raw PDF space with per-subpath CTM.

   subpathsToSvg() then projects everything to viewport space and
   serializes an SVG whose elements carry data-geo-class tags, so
   the geometry pipeline classifies deterministically.

   Replaces pdf.js SVGGraphics (deprecated, removed in v4) for
   PDF import. Key wins: no text-glyph path soup (showText ops
   never enter the path switch), flat output, numeric endpoints.
   ============================================================ */

window.GxCtmAdapter = (function () {

    function mulMatrix(a, b) {
        return [
            a[0] * b[0] + a[2] * b[1],
            a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3],
            a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4],
            a[1] * b[4] + a[3] * b[5] + a[5],
        ];
    }

    function applyMatrix(m, x, y) {
        return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    function extractSubpaths(opList, viewport, OPS) {
        const { fnArray, argsArray } = opList;
        const vpTransform = viewport.transform;
        const identity = [1, 0, 0, 1, 0, 0];
        const ctmStack = [identity.slice()];
        let ctm = identity.slice();

        let subpathIdCounter = 0;
        let constructPathIdCounter = 0;

        let strokeWidth = 1;
        let fillColor = [0, 0, 0];
        let strokeColor = [0, 0, 0];
        const colorStateStack = [{ fill: fillColor.slice(), stroke: strokeColor.slice() }];

        let currentSubpath = { segs: [], curves: [] };

        const subpaths = [];
        const filledRects = [];

        const openSubpath = (constructPathId) => {
            if (currentSubpath.segs.length > 0 || currentSubpath.curves.length > 0) {
                subpaths.push(currentSubpath);
            }
            currentSubpath = {
                segs: [], curves: [], closed: false, filled: false,
                strokeWidth,
                strokeColor: strokeColor.slice(),
                fillColor: fillColor.slice(),
                constructPathId,
                ctm: ctm.slice(),
                id: subpathIdCounter++,
            };
        };

        openSubpath(null);

        let rawPendingX = 0, rawPendingY = 0;
        let subpathStartX = 0, subpathStartY = 0;
        let pendingRect = null;

        // -- Scanline-artwork detection ---------------------------------------
        // A raster logo placed in a CAD drawing is exported as a long run of
        // filled hairline rectangles, one per scan row. The Arduino sheet does
        // this twice and it accounts for 6280 of its 6307 rectangles: four
        // fifths of the document, none of it circuitry.
        //
        // The signature is a CONTIGUOUS run of filled rects sharing a fill
        // colour and a constant thin dimension. Real drawings put 2-4 filled
        // rects in a row (a pin, a junction dot, a filled arrow); they do not
        // put dozens. Detecting it on the op stream is what makes it reliable:
        // "consecutive" is information that exists here and nowhere downstream,
        // and it is what separates a traced bitmap from a hatch of real shapes.
        const ARTWORK_RUN_MIN = 24;
        const artworkRuns = [];
        let rectRun = null;
        const _runKey = (rect, fc) =>
            fc.join(',') + '|' + Math.round(Math.min(rect.w, rect.h) * 20);
        const _closeRun = () => {
            if (rectRun && rectRun.members.length >= ARTWORK_RUN_MIN) artworkRuns.push(rectRun);
            rectRun = null;
        };
        const _noteFilledRect = (rect, fc, subpath) => {
            // Only hairlines qualify. A run of chunky filled rects is a bar
            // chart or a legend, and losing those to "decoration" would be a
            // worse error than the one this fixes.
            if (Math.min(rect.w, rect.h) > 1.2) { _closeRun(); return; }
            const key = _runKey(rect, fc);
            if (rectRun && rectRun.key === key) rectRun.members.push(subpath);
            else { _closeRun(); rectRun = { key, members: [subpath] }; }
        };

        const bufferSeg = (ax, ay, bx, by) => {
            currentSubpath.segs.push({ ax, ay, bx, by });
        };

        const toViewport = (pdfX, pdfY) => {
            const [cx, cy] = applyMatrix(ctm, pdfX, pdfY);
            return applyMatrix(vpTransform, cx, cy);
        };

        const addRect = (rx, ry, rw, rh, constructPathId = null) => {
            openSubpath(constructPathId);
            bufferSeg(rx, ry, rx + rw, ry);
            bufferSeg(rx + rw, ry, rx + rw, ry + rh);
            bufferSeg(rx + rw, ry + rh, rx, ry + rh);
            bufferSeg(rx, ry + rh, rx, ry);
            const [x1, y1] = toViewport(rx, ry);
            const [x2, y2] = toViewport(rx + rw, ry + rh);
            pendingRect = {
                x: Math.min(x1, x2), y: Math.min(y1, y2),
                w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
                fillColor: fillColor.slice(),
            };
            rawPendingX = rx; rawPendingY = ry;
        };

        const processSubOps = (subOps, subArgs, constructPathId) => {
            let ai = 0;
            for (let j = 0; j < subOps.length; j++) {
                const sf = subOps[j];
                if (sf === OPS.moveTo) {
                    openSubpath(constructPathId);
                    rawPendingX = subArgs[ai]; rawPendingY = subArgs[ai + 1];
                    subpathStartX = rawPendingX; subpathStartY = rawPendingY;
                    ai += 2;
                } else if (sf === OPS.lineTo) {
                    bufferSeg(rawPendingX, rawPendingY, subArgs[ai], subArgs[ai + 1]);
                    rawPendingX = subArgs[ai]; rawPendingY = subArgs[ai + 1];
                    ai += 2;
                } else if (sf === OPS.rectangle) {
                    addRect(subArgs[ai], subArgs[ai + 1], subArgs[ai + 2], subArgs[ai + 3], constructPathId);
                    ai += 4;
                } else if (sf === OPS.curveTo) {
                    currentSubpath.curves.push({
                        p0: [rawPendingX, rawPendingY],
                        p1: [subArgs[ai], subArgs[ai + 1]],
                        p2: [subArgs[ai + 2], subArgs[ai + 3]],
                        p3: [subArgs[ai + 4], subArgs[ai + 5]],
                    });
                    rawPendingX = subArgs[ai + 4]; rawPendingY = subArgs[ai + 5];
                    ai += 6;
                } else if (sf === OPS.curveTo2) {
                    currentSubpath.curves.push({
                        p0: [rawPendingX, rawPendingY],
                        p1: [rawPendingX, rawPendingY],
                        p2: [subArgs[ai], subArgs[ai + 1]],
                        p3: [subArgs[ai + 2], subArgs[ai + 3]],
                    });
                    rawPendingX = subArgs[ai + 2]; rawPendingY = subArgs[ai + 3];
                    ai += 4;
                } else if (sf === OPS.curveTo3) {
                    currentSubpath.curves.push({
                        p0: [rawPendingX, rawPendingY],
                        p1: [subArgs[ai], subArgs[ai + 1]],
                        p2: [subArgs[ai + 2], subArgs[ai + 3]],
                        p3: [subArgs[ai + 2], subArgs[ai + 3]],
                    });
                    rawPendingX = subArgs[ai + 2]; rawPendingY = subArgs[ai + 3];
                    ai += 4;
                } else if (sf === OPS.closePath) {
                    bufferSeg(rawPendingX, rawPendingY, subpathStartX, subpathStartY);
                    rawPendingX = subpathStartX; rawPendingY = subpathStartY;
                    currentSubpath.closed = true;
                }
            }
        };

        for (let i = 0; i < fnArray.length; i++) {
            const fn = fnArray[i];
            const args = argsArray[i];

            switch (fn) {
                case OPS.save:
                    ctmStack.push(ctm.slice());
                    colorStateStack.push({ fill: fillColor.slice(), stroke: strokeColor.slice() });
                    break;
                case OPS.restore:
                    ctm = ctmStack.length > 1 ? ctmStack.pop() : identity.slice();
                    if (colorStateStack.length > 1) {
                        const cs = colorStateStack.pop();
                        fillColor = cs.fill; strokeColor = cs.stroke;
                    }
                    break;
                case OPS.transform:
                    ctm = mulMatrix(ctm, args);
                    break;
                case OPS.setLineWidth:
                    strokeWidth = args[0];
                    break;
                case OPS.setFillGray:
                    fillColor = [args[0], args[0], args[0]];
                    break;
                case OPS.setFillRGBColor:
                    fillColor = [args[0], args[1], args[2]];
                    break;
                case OPS.setFillCMYKColor: {
                    const [c, m, y, k] = args;
                    fillColor = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
                    break;
                }
                case OPS.setFillColor:
                case OPS.setFillColorN:
                    if (args.length === 1) fillColor = [args[0], args[0], args[0]];
                    else if (args.length >= 3) fillColor = [args[0], args[1], args[2]];
                    break;
                case OPS.setStrokeGray:
                    strokeColor = [args[0], args[0], args[0]];
                    break;
                case OPS.setStrokeRGBColor:
                    strokeColor = [args[0], args[1], args[2]];
                    break;
                case OPS.setStrokeCMYKColor: {
                    const [c, m, y, k] = args;
                    strokeColor = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
                    break;
                }
                case OPS.setStrokeColor:
                case OPS.setStrokeColorN:
                    if (args.length === 1) strokeColor = [args[0], args[0], args[0]];
                    else if (args.length >= 3) strokeColor = [args[0], args[1], args[2]];
                    break;
                case OPS.fill:
                case OPS.eoFill:
                case OPS.fillStroke:
                case OPS.eoFillStroke:
                case OPS.closeFillStroke:
                case OPS.closeEOFillStroke:
                    currentSubpath.filled = true;
                    if (pendingRect) {
                        filledRects.push({ ...pendingRect });
                        _noteFilledRect(pendingRect, fillColor, currentSubpath);
                    } else {
                        // A fill that is not a plain rect ends any run: scanline
                        // artwork is rects and nothing else.
                        _closeRun();
                    }
                    pendingRect = null;
                    break;
                case OPS.stroke:
                case OPS.closeStrokePath:
                    pendingRect = null;
                    _closeRun();
                    break;
                case OPS.moveTo:
                    openSubpath(null);
                    rawPendingX = args[0]; rawPendingY = args[1];
                    subpathStartX = rawPendingX; subpathStartY = rawPendingY;
                    break;
                case OPS.lineTo:
                    bufferSeg(rawPendingX, rawPendingY, args[0], args[1]);
                    rawPendingX = args[0]; rawPendingY = args[1];
                    break;
                case OPS.rectangle:
                    addRect(args[0], args[1], args[2], args[3]);
                    break;
                case OPS.constructPath:
                    processSubOps(args[0], args[1], constructPathIdCounter++);
                    break;
                case OPS.closePath:
                    bufferSeg(rawPendingX, rawPendingY, subpathStartX, subpathStartY);
                    rawPendingX = subpathStartX; rawPendingY = subpathStartY;
                    currentSubpath.closed = true;
                    break;
                default:
                    break;
            }
        }

        if (currentSubpath.segs.length > 0 || currentSubpath.curves.length > 0) {
            subpaths.push(currentSubpath);
        }
        _closeRun();

        // Marked, never dropped. The logo still draws exactly as it did; it just
        // stops claiming to be six thousand circuit components.
        let artworkCount = 0;
        artworkRuns.forEach(run => run.members.forEach(sp => { sp.artwork = true; artworkCount++; }));

        return { subpaths, filledRects, artworkCount };
    }

    // ── Serialize extracted primitives to a schema-editor SVG ─────────────
    // Projects raw PDF coords through (viewport ∘ subpath CTM) and emits:
    //   open stroked subpaths → <path> tagged data-geo-class="wire"
    //   closed/filled subpaths & filledRects → tagged "component"
    //   curves → untagged <path> (heuristic classification decides)
    function subpathsToSvg({ subpaths, filledRects }, viewport, textSvg) {
        const vt = viewport.transform;
        const r = (n) => Math.round(n * 100) / 100;
        const world = (ctm, x, y) => {
            const [cx, cy] = applyMatrix(ctm, x, y);
            return applyMatrix(vt, cx, cy);
        };
        // pdf.js op-list color channels are 0–255 ints for RGB ops, 0–1 for gray
        const css = (c) => `rgb(${c.map(v => Math.round(v <= 1 ? v * 255 : v)).join(',')})`;
        // Approximate stroke width scale from the combined matrix determinant
        const widthScale = (ctm) => {
            const m = mulMatrix(vt, ctm);
            return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        };

        const parts = [];
        // Artwork is accumulated as path DATA keyed by paint, not as elements.
        // A traced logo is thousands of subpaths that share one fill and never
        // move relative to each other, so they are one <path> with thousands of
        // subpaths — identical pixels, and the renderer walks one node per frame
        // instead of six thousand. This is the difference between a schematic
        // that pans and one that stutters.
        const artByPaint = new Map();

        subpaths.forEach(sp => {
            if (!sp.segs.length && !sp.curves.length) return;
            const w = Math.max(0.5, r((sp.strokeWidth || 1) * widthScale(sp.ctm)));
            const stroke = css(sp.strokeColor);

            let d = '';
            let last = null;
            sp.segs.forEach(s => {
                const [ax, ay] = world(sp.ctm, s.ax, s.ay);
                const [bx, by] = world(sp.ctm, s.bx, s.by);
                if (!last || Math.hypot(ax - last[0], ay - last[1]) > 0.01) {
                    d += `M ${r(ax)} ${r(ay)} `;
                }
                d += `L ${r(bx)} ${r(by)} `;
                last = [bx, by];
            });
            sp.curves.forEach(c => {
                const [x0, y0] = world(sp.ctm, c.p0[0], c.p0[1]);
                const [x1, y1] = world(sp.ctm, c.p1[0], c.p1[1]);
                const [x2, y2] = world(sp.ctm, c.p2[0], c.p2[1]);
                const [x3, y3] = world(sp.ctm, c.p3[0], c.p3[1]);
                if (!last || Math.hypot(x0 - last[0], y0 - last[1]) > 0.01) {
                    d += `M ${r(x0)} ${r(y0)} `;
                }
                d += `C ${r(x1)} ${r(y1)} ${r(x2)} ${r(y2)} ${r(x3)} ${r(y3)} `;
                last = [x3, y3];
            });
            if (!d) return;

            const closedish = sp.closed || sp.filled;
            // 'ink' is the engine's existing word for decoration: it draws but
            // is excluded from wire/component analysis. A traced logo is exactly
            // that, so it needs no new concept and no new branch downstream.
            const geoClass = sp.artwork ? 'ink'
                : (sp.curves.length ? null : (closedish ? 'component' : 'wire'));
            const fill = sp.filled ? css(sp.fillColor) : 'none';
            const shape = `${d.trim()}${sp.closed ? ' Z' : ''}`;
            if (sp.artwork) {
                const paint = `${fill}|${stroke}|${w}`;
                const prev = artByPaint.get(paint);
                artByPaint.set(paint, prev ? `${prev} ${shape}` : shape);
                return;
            }
            parts.push(
                `<path d="${shape}" fill="${fill}" ` +
                `stroke="${stroke}" stroke-width="${w}"` +
                (geoClass ? ` data-geo-class="${geoClass}"` : '') + '/>'
            );
        });

        filledRects.forEach(fr => {
            if (fr.w < 1 || fr.h < 1) return;
            parts.push(
                `<rect x="${r(fr.x)}" y="${r(fr.y)}" width="${r(fr.w)}" height="${r(fr.h)}" ` +
                `fill="${css(fr.fillColor)}" stroke="none" data-geo-class="component"/>`
            );
        });

        // One group, painted first so it sits behind the drawing. Collapsing it
        // into a handful of rows is also the difference between a layers panel a
        // person can read and six thousand identical entries.
        const artParts = [];
        artByPaint.forEach((d, paint) => {
            const [fill, stroke, w] = paint.split('|');
            artParts.push(`<path d="${d}" fill="${fill}" stroke="${stroke}" ` +
                `stroke-width="${w}" data-geo-class="ink"/>`);
        });
        const artwork = artParts.length
            ? `<g data-gx-artwork="true" data-geo-class="ink" aria-label="Raster artwork" ` +
              `style="pointer-events:none">${artParts.join('')}</g>`
            : '';

        return `<svg xmlns="http://www.w3.org/2000/svg" ` +
            `viewBox="0 0 ${r(viewport.width)} ${r(viewport.height)}" ` +
            `width="${r(viewport.width)}" height="${r(viewport.height)}">` +
            `${artwork}${parts.join('')}${textSvg || ''}</svg>`;
    }

    return { extractSubpaths, subpathsToSvg };
})();
