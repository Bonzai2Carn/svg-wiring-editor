/* ============================================================
   Schematics Editor — Path Geometry
   ------------------------------------------------------------
   ONE parser for SVG path data. Everything that needs to know
   where a path actually goes reads it through here.

   Why this exists
   ---------------
   The editor had eleven separate ad-hoc regexes of the form
   /[ML]\s*(num)[,\s](num)/ scattered across the canvas engine and
   drawing tools, and they did not agree with each other:

     · four carried the /i flag, so they MATCHED lowercase relative
       commands and then read the relative offsets as absolute
       coordinates. `m 100,120 l 40,0` parsed as the points
       (100,120) and (40,0) — the second one nowhere near the wire.
     · seven omitted /i, so they silently dropped every relative
       segment and returned a truncated path.
     · none of them saw H, V, C, S, Q, T, A or Z at all, so a path
       with a horizontal-lineto or any curve parsed as a single point.
     · none handled implicit repeated coordinates ("L 10 10 20 20"),
       which is legal and common in optimized output.

   Inkscape and most optimizers emit RELATIVE commands by default,
   so any imported drawing hit all four problems at once. Anything
   derived from those reads — wire cutting, endpoint re-anchoring,
   T-junctions, net tracing — was working from scattered coordinates.

   It also gives a TIGHT bounding box. getBBox() is the union of
   every subpath in the element, so one stray subpath or leftover
   vertex parked far from the visible geometry inflates the box, and
   the selection handles and the properties X/Y then render at that
   phantom boundary instead of on the shape you can see.

   Deterministic, no dependencies.
   Exposes window.GxPathGeo.
   ============================================================ */
(function () {
    'use strict';

    // Command letters and numbers. Numbers may run together with no
    // separator ("10-20"), carry exponents, or start with a bare dot (".5").
    var TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/g;

    var ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

    function tokenize(d) {
        var out = [], m;
        TOKEN.lastIndex = 0;
        while ((m = TOKEN.exec(d)) !== null) {
            out.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));
        }
        return out;
    }

    function sampleCubic(p0, p1, p2, p3, steps, into) {
        for (var i = 1; i <= steps; i++) {
            var t = i / steps, u = 1 - t;
            into.push({
                x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
                y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
            });
        }
    }

    function sampleQuad(p0, p1, p2, steps, into) {
        for (var i = 1; i <= steps; i++) {
            var t = i / steps, u = 1 - t;
            into.push({
                x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
                y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
            });
        }
    }

    // Endpoint parameterisation → centre parameterisation (SVG spec F.6.5),
    // then sample. Without this an imported arc contributes only its endpoints
    // and the bulge is missing from the bbox.
    function sampleArc(p0, rx, ry, phiDeg, largeArc, sweep, p1, steps, into) {
        if (!rx || !ry) { into.push({ x: p1.x, y: p1.y }); return; }
        rx = Math.abs(rx); ry = Math.abs(ry);
        var phi = phiDeg * Math.PI / 180;
        var cosP = Math.cos(phi), sinP = Math.sin(phi);
        var dx2 = (p0.x - p1.x) / 2, dy2 = (p0.y - p1.y) / 2;
        var x1 =  cosP * dx2 + sinP * dy2;
        var y1 = -sinP * dx2 + cosP * dy2;

        var lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
        if (lam > 1) { var s = Math.sqrt(lam); rx *= s; ry *= s; }

        var sign = largeArc === sweep ? -1 : 1;
        var num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
        var den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
        var co = sign * Math.sqrt(Math.max(0, num / (den || 1)));
        var cx1 =  co * rx * y1 / ry;
        var cy1 = -co * ry * x1 / rx;
        var cx = cosP * cx1 - sinP * cy1 + (p0.x + p1.x) / 2;
        var cy = sinP * cx1 + cosP * cy1 + (p0.y + p1.y) / 2;

        var ang = function (ux, uy, vx, vy) {
            var dot = ux * vx + uy * vy;
            var len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy) || 1;
            var a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
            return (ux * vy - uy * vx < 0) ? -a : a;
        };
        var theta = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
        var delta = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
        if (!sweep && delta > 0) delta -= 2 * Math.PI;
        if (sweep && delta < 0) delta += 2 * Math.PI;

        for (var i = 1; i <= steps; i++) {
            var t = theta + delta * (i / steps);
            var ct = Math.cos(t), st = Math.sin(t);
            into.push({
                x: cosP * rx * ct - sinP * ry * st + cx,
                y: sinP * rx * ct + cosP * ry * st + cy,
            });
        }
    }

    /**
     * Parse path data into absolute subpaths.
     *
     * Returns { subpaths: [{ anchors, points, closed }] }
     *   anchors — the on-path vertices only (what a polyline wire is made of)
     *   points  — anchors plus curve samples (what a tight bbox needs)
     *
     * Relative commands are resolved against the running point, so the output
     * is always absolute regardless of how the file was written.
     */
    function parse(d, opts) {
        var steps = (opts && opts.curveSteps) || 12;
        var t = tokenize(String(d || ''));
        var subpaths = [];
        var cur = null;                       // active subpath
        var x = 0, y = 0;                     // current point
        var sx = 0, sy = 0;                   // subpath start (for Z)
        var px = null, py = null;             // previous control point (S/T)
        var prevCmd = '';
        var i = 0, cmd = null;

        function open() {
            cur = { anchors: [], points: [], closed: false };
            subpaths.push(cur);
        }
        function put(nx, ny) {
            if (!cur) open();
            cur.anchors.push({ x: nx, y: ny });
            cur.points.push({ x: nx, y: ny });
        }

        while (i < t.length) {
            if (typeof t[i] === 'string') { cmd = t[i]; i++; }
            else if (cmd === null) { i++; continue; }        // leading junk
            else if (cmd === 'M') cmd = 'L';                  // implicit repeat
            else if (cmd === 'm') cmd = 'l';

            var up = cmd.toUpperCase();
            var rel = cmd !== up;
            var n = ARGC[up];
            if (n === undefined) { i++; continue; }
            if (n > 0 && i + n > t.length) break;             // truncated data

            var a = t.slice(i, i + n);
            i += n;

            if (up === 'M') {
                x = rel ? x + a[0] : a[0];
                y = rel ? y + a[1] : a[1];
                sx = x; sy = y;
                open(); put(x, y);
            } else if (up === 'L') {
                x = rel ? x + a[0] : a[0];
                y = rel ? y + a[1] : a[1];
                put(x, y);
            } else if (up === 'H') {
                x = rel ? x + a[0] : a[0];
                put(x, y);
            } else if (up === 'V') {
                y = rel ? y + a[0] : a[0];
                put(x, y);
            } else if (up === 'C' || up === 'S' || up === 'Q' || up === 'T') {
                var p0 = { x: x, y: y }, c1, c2, end;
                if (up === 'C') {
                    c1  = { x: rel ? x + a[0] : a[0], y: rel ? y + a[1] : a[1] };
                    c2  = { x: rel ? x + a[2] : a[2], y: rel ? y + a[3] : a[3] };
                    end = { x: rel ? x + a[4] : a[4], y: rel ? y + a[5] : a[5] };
                } else if (up === 'S') {
                    var refl = 'CS'.indexOf(prevCmd.toUpperCase()) >= 0 && px !== null;
                    c1  = refl ? { x: 2 * x - px, y: 2 * y - py } : { x: x, y: y };
                    c2  = { x: rel ? x + a[0] : a[0], y: rel ? y + a[1] : a[1] };
                    end = { x: rel ? x + a[2] : a[2], y: rel ? y + a[3] : a[3] };
                } else if (up === 'Q') {
                    c1  = { x: rel ? x + a[0] : a[0], y: rel ? y + a[1] : a[1] };
                    end = { x: rel ? x + a[2] : a[2], y: rel ? y + a[3] : a[3] };
                } else {
                    var reflQ = 'QT'.indexOf(prevCmd.toUpperCase()) >= 0 && px !== null;
                    c1  = reflQ ? { x: 2 * x - px, y: 2 * y - py } : { x: x, y: y };
                    end = { x: rel ? x + a[0] : a[0], y: rel ? y + a[1] : a[1] };
                }
                if (!cur) { open(); cur.anchors.push(p0); cur.points.push(p0); }
                if (up === 'C' || up === 'S') sampleCubic(p0, c1, c2, end, steps, cur.points);
                else                          sampleQuad(p0, c1, end, steps, cur.points);
                cur.anchors.push({ x: end.x, y: end.y });
                px = (up === 'C' || up === 'S') ? c2.x : c1.x;
                py = (up === 'C' || up === 'S') ? c2.y : c1.y;
                x = end.x; y = end.y;
                prevCmd = cmd;
                continue;                                     // px/py already set
            } else if (up === 'A') {
                var ap0 = { x: x, y: y };
                var ae = { x: rel ? x + a[5] : a[5], y: rel ? y + a[6] : a[6] };
                if (!cur) { open(); cur.anchors.push(ap0); cur.points.push(ap0); }
                sampleArc(ap0, a[0], a[1], a[2], !!a[3], !!a[4], ae, steps, cur.points);
                cur.anchors.push(ae);
                x = ae.x; y = ae.y;
            } else if (up === 'Z') {
                if (cur) { cur.closed = true; cur.points.push({ x: sx, y: sy }); }
                x = sx; y = sy;
            }

            px = null; py = null;
            prevCmd = cmd;
        }

        return { subpaths: subpaths.filter(function (s) { return s.points.length; }) };
    }

    /** Flat list of on-path vertices across every subpath, absolute. */
    function vertices(d) {
        var out = [];
        parse(d).subpaths.forEach(function (s) {
            s.anchors.forEach(function (p) { out.push(p); });
        });
        return out;
    }

    /** Number of subpaths. >1 means getBBox() spans disconnected geometry. */
    function subpathCount(d) { return parse(d).subpaths.length; }

    /** Subpaths that render nothing — the orphans that inflate getBBox(). */
    function degenerateSubpaths(d) {
        return parse(d).subpaths.filter(function (s) { return subpathExtent(s) <= 1e-6; }).length;
    }

    /** Extent of one subpath. Zero means it draws no ink. */
    function subpathExtent(s) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        s.points.forEach(function (p) {
            if (!isFinite(p.x) || !isFinite(p.y)) return;
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        });
        if (!isFinite(minX)) return 0;
        return Math.max(maxX - minX, maxY - minY);
    }

    /**
     * Tight bbox from real geometry, curves included.
     *
     * Degenerate subpaths are skipped by default. A lone moveto, a
     * zero-length segment or a leftover vertex renders nothing, but
     * getBBox() still counts it, and one such orphan parked far from the
     * artwork stretches the box across the gap. The selection handles and
     * the properties X/Y then sit on that phantom corner rather than on
     * the shape. Pass {includeDegenerate:true} for the raw union.
     */
    function bbox(d, opts) {
        var skipDegenerate = !(opts && opts.includeDegenerate);
        var EPS = 1e-6;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        var subs = parse(d).subpaths;
        var live = skipDegenerate
            ? subs.filter(function (s) { return subpathExtent(s) > EPS; })
            : subs;
        // Everything was degenerate: fall back to the raw union rather than
        // returning nothing, so a genuinely point-sized element still resolves.
        if (!live.length) live = subs;
        live.forEach(function (s) {
            s.points.forEach(function (p) {
                if (!isFinite(p.x) || !isFinite(p.y)) return;
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            });
        });
        if (!isFinite(minX)) return null;
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    /** Rewrite as an absolute M/L polyline. Curves become their samples. */
    function toAbsolutePolyline(d) {
        var parts = [];
        parse(d).subpaths.forEach(function (s) {
            s.points.forEach(function (p, i) {
                parts.push((i === 0 ? 'M ' : 'L ') + p.x + ' ' + p.y);
            });
        });
        return parts.join(' ');
    }

    /**
     * True when a path's own data is anything the M/L wire machinery cannot
     * round-trip: curves, arcs, or more than one subpath. Callers use this to
     * refuse to rewrite geometry they would damage.
     */
    function isPolylineSafe(d) {
        if (/[CcSsQqTtAa]/.test(String(d || ''))) return false;
        return subpathCount(d) <= 1;
    }

    window.GxPathGeo = {
        parse: parse,
        vertices: vertices,
        bbox: bbox,
        subpathCount: subpathCount,
        degenerateSubpaths: degenerateSubpaths,
        toAbsolutePolyline: toAbsolutePolyline,
        isPolylineSafe: isPolylineSafe,
    };
})();
