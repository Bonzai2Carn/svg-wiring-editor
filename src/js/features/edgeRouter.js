/* ============================================================
   GINEXYS — Edge routing styles  (window.GxEdgeRouter)

   One place that turns a waypoint list into an SVG path `d`, in five
   styles. Before this, wire shape was a BOOLEAN — `_smoothTrace`,
   "Manhattan (false) vs 45° bends (true)" — so the editor could draw
   exactly two of the five shapes a diagram tool is expected to draw,
   and a relational ERD (which wants rounded orthogonal or a bezier)
   could not be drawn in its own idiom at all.

     direct      straight segments through every waypoint
     orthogonal  right-angle elbows with ROUNDED corners
     manhattan   right-angle elbows with SHARP corners
     curved      a smooth Catmull-Rom spline through the waypoints
     bezier      one cubic from end to end, control points on the
                 dominant axis — the draw.io / node-editor look

   `orthogonal` and `manhattan` differ only in corner radius, and that
   is the honest distinction: both are the same route, and a diagram
   house style is usually a statement about the corners, not the path.

   Boxwood (GxArrange) is the OBSTACLE router — it decides *where* a
   wire goes around bodies. This decides what the resulting points
   LOOK like. They compose: route first, style second. This file has
   no dependency on boxwood, because it must keep working in a forked
   standalone copy where the private AI layer was never injected.

   Framework-free and Node-loadable so check-edge-router.cjs can
   assert path shapes without a DOM.
   ============================================================ */

(function () {
    const G = (typeof globalThis !== 'undefined') ? globalThis : window;

    const STYLES = ['direct', 'orthogonal', 'manhattan', 'curved', 'bezier'];
    const DEFAULT_STYLE = 'manhattan';
    const LABELS = {
        direct: '╱ direct',
        orthogonal: '⌐ orthogonal',
        manhattan: '⌙ manhattan',
        curved: '∿ curved',
        bezier: '⌇ cubic bezier',
    };

    const N = (v) => Math.round(v * 100) / 100;

    function _pt(p) { return `${N(p.x)} ${N(p.y)}`; }

    /** Straight polyline through every waypoint. */
    function direct(pts) {
        return `M ${_pt(pts[0])}` + pts.slice(1).map((p) => ` L ${_pt(p)}`).join('');
    }

    /** Expand each leg into a horizontal-first elbow. Returns the corner list
        (not a path) so the two orthogonal styles can share one geometry and
        differ only in how the corners are drawn. */
    function _elbowPoints(pts) {
        const out = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
            const prev = pts[i - 1], curr = pts[i];
            if (prev.x !== curr.x && prev.y !== curr.y) out.push({ x: prev.x, y: curr.y });
            out.push(curr);
        }
        // Collapse duplicates — a purely horizontal or vertical leg produces a
        // corner identical to its neighbour, and a zero-length arc is invalid.
        return out.filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
    }

    function manhattan(pts) {
        return direct(_elbowPoints(pts));
    }

    /** Same corners, rounded. The radius is clamped to half the shorter of the
        two legs meeting at each corner, so a 6px jog cannot grow an 8px arc
        and bow the line back on itself. */
    function orthogonal(pts, opts) {
        const r0 = (opts && opts.cornerRadius != null) ? opts.cornerRadius : 8;
        const c = _elbowPoints(pts);
        if (c.length < 3 || r0 <= 0) return direct(c);

        let d = `M ${_pt(c[0])}`;
        for (let i = 1; i < c.length - 1; i++) {
            const a = c[i - 1], b = c[i], e = c[i + 1];
            const inLen = Math.hypot(b.x - a.x, b.y - a.y);
            const outLen = Math.hypot(e.x - b.x, e.y - b.y);
            const r = Math.min(r0, inLen / 2, outLen / 2);
            if (r < 0.5) { d += ` L ${_pt(b)}`; continue; }
            const t1 = { x: b.x - Math.sign(b.x - a.x) * r, y: b.y - Math.sign(b.y - a.y) * r };
            const t2 = { x: b.x + Math.sign(e.x - b.x) * r, y: b.y + Math.sign(e.y - b.y) * r };
            d += ` L ${_pt(t1)} Q ${_pt(b)} ${_pt(t2)}`;
        }
        return d + ` L ${_pt(c[c.length - 1])}`;
    }

    /** Catmull-Rom through the waypoints, converted to cubics. Passes THROUGH
        every point (a plain bezier does not), which is what makes it usable as
        a freehand-trace smoother rather than only an A-to-B connector. */
    function curved(pts, opts) {
        if (pts.length < 3) return direct(pts);
        const t = (opts && opts.tension != null) ? opts.tension : 0.5;
        let d = `M ${_pt(pts[0])}`;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] || pts[i];
            const p1 = pts[i], p2 = pts[i + 1];
            const p3 = pts[i + 2] || p2;
            const c1 = { x: p1.x + (p2.x - p0.x) * t / 3, y: p1.y + (p2.y - p0.y) * t / 3 };
            const c2 = { x: p2.x - (p3.x - p1.x) * t / 3, y: p2.y - (p3.y - p1.y) * t / 3 };
            d += ` C ${_pt(c1)} ${_pt(c2)} ${_pt(p2)}`;
        }
        return d;
    }

    /** One cubic from first to last, control points pushed along the dominant
        axis. Intermediate waypoints are deliberately IGNORED: a single smooth
        sweep is the whole point of the style, and threading it through every
        waypoint would just be `curved` with worse handles. */
    function bezier(pts, opts) {
        const a = pts[0], b = pts[pts.length - 1];
        const horiz = (opts && opts.axis)
            ? opts.axis === 'x'
            : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
        const span = horiz ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
        const k = Math.max(40, span * 0.4);
        const c1 = horiz ? { x: a.x + Math.sign(b.x - a.x || 1) * k, y: a.y }
            : { x: a.x, y: a.y + Math.sign(b.y - a.y || 1) * k };
        const c2 = horiz ? { x: b.x - Math.sign(b.x - a.x || 1) * k, y: b.y }
            : { x: b.x, y: b.y - Math.sign(b.y - a.y || 1) * k };
        return `M ${_pt(a)} C ${_pt(c1)} ${_pt(c2)} ${_pt(b)}`;
    }

    const FNS = { direct, orthogonal, manhattan, curved, bezier };

    /**
     * points -> SVG path `d`.
     * An unknown style falls back to the default rather than returning ''.
     * A caller that hands us a style we do not have should still get a
     * drawable wire — a blank `d` is an invisible wire, which reads as data
     * loss rather than as an unsupported option.
     */
    function path(pts, style, opts) {
        const p = (pts || []).filter((q) => q && isFinite(q.x) && isFinite(q.y));
        if (p.length < 2) return p.length ? `M ${_pt(p[0])}` : '';
        const fn = FNS[style] || FNS[DEFAULT_STYLE];
        return fn(p, opts || {});
    }

    G.GxEdgeRouter = { STYLES, DEFAULT_STYLE, LABELS, path, elbowPoints: _elbowPoints };
    if (typeof module !== 'undefined' && module.exports) module.exports = G.GxEdgeRouter;
})();
