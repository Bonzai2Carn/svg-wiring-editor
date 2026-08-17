#!/usr/bin/env node
/* ============================================================
   Edge routing styles — GxEdgeRouter

   Route shape used to be a boolean, so "which of the five shapes did
   I get" was never a question anything could ask. The risk with five
   styles behind one function is that two of them quietly become the
   same path — a router that always returns an elbow passes every
   "did it return a path" test ever written. So the assertions here
   are mostly about the styles being DIFFERENT from each other and
   from the default, plus the geometry each one promises.
   ============================================================ */
const path = require('path');
const R = require(path.join(__dirname, '..', 'src', 'js', 'features', 'edgeRouter.js'));

const failures = [];
let checks = 0;
const check = (cond, msg) => { checks++; if (!cond) failures.push(msg); };

const A = { x: 0, y: 0 };
const B = { x: 200, y: 120 };
const MID = [A, { x: 100, y: 0 }, { x: 100, y: 120 }, B];

// ── every declared style produces a distinct path ─────────────
// Measured on a DIAGONAL run. On an already-square path manhattan is a no-op
// and correctly equals direct (asserted separately below), so using MID here
// would have reported a true property as a collision.
{
    const DIAG = [A, { x: 90, y: 40 }, B];
    const seen = new Map();
    R.STYLES.forEach((s) => {
        const d = R.path(DIAG, s);
        check(!!d && d.startsWith('M'), `style "${s}" produced no path`);
        if (seen.has(d)) failures.push(`styles "${seen.get(d)}" and "${s}" produce IDENTICAL paths`);
        seen.set(d, s);
        checks++;
    });
    check(R.STYLES.length === 5, `expected 5 styles, got ${R.STYLES.length}`);
    ['direct', 'orthogonal', 'manhattan', 'curved', 'bezier'].forEach((s) => {
        check(R.STYLES.indexOf(s) >= 0, `style "${s}" is missing from STYLES`);
    });
}

// ── manhattan is idempotent on an already-square path ─────────
// Re-elbowing a route that is already orthogonal must not insert duplicate
// corners: a wire redrawn on every symbol drag would otherwise grow a new
// zero-length leg each time.
{
    check(R.path(MID, 'manhattan') === R.path(MID, 'direct'),
        'manhattan changed an already-square path');
    check(R.path(R.elbowPoints(MID), 'manhattan') === R.path(MID, 'manhattan'),
        'manhattan is not idempotent — corners accumulate on re-route');
}

// ── direct: straight segments, no curve commands ──────────────
{
    const d = R.path(MID, 'direct');
    check(!/[CQA]/.test(d), `direct emitted a curve command: ${d}`);
    check((d.match(/L/g) || []).length === MID.length - 1,
        `direct should have one L per waypoint after the first: ${d}`);
}

// ── manhattan: right angles only, sharp corners ───────────────
{
    const d = R.path([A, B], 'manhattan');
    check(!/[CQA]/.test(d), `manhattan emitted a curve command: ${d}`);
    // every consecutive pair must share an x or a y
    const pts = d.match(/-?[\d.]+ -?[\d.]+/g).map((p) => {
        const [x, y] = p.split(' ').map(Number); return { x, y };
    });
    let square = true;
    for (let i = 1; i < pts.length; i++) {
        if (pts[i].x !== pts[i - 1].x && pts[i].y !== pts[i - 1].y) square = false;
    }
    check(square, `manhattan produced a diagonal leg: ${d}`);
}

// ── orthogonal: the SAME corners as manhattan, rounded ────────
{
    const d = R.path([A, B], 'orthogonal');
    check(/Q/.test(d), `orthogonal produced no rounded corner: ${d}`);
    check(R.path([A, B], 'orthogonal') !== R.path([A, B], 'manhattan'),
        'orthogonal and manhattan are the same path — the corner radius is not applied');
    // cornerRadius 0 collapses orthogonal onto manhattan: same route, sharp
    check(R.path([A, B], 'orthogonal', { cornerRadius: 0 }) === R.path([A, B], 'manhattan'),
        'orthogonal at radius 0 should equal manhattan (same route, different corners)');
    // A radius must never exceed half a leg, or the arc bows back on itself
    const tiny = R.path([{ x: 0, y: 0 }, { x: 6, y: 6 }], 'orthogonal', { cornerRadius: 40 });
    const nums = tiny.match(/-?[\d.]+/g).map(Number);
    check(Math.max(...nums) <= 6.01,
        `an oversized corner radius escaped the 6px leg: ${tiny}`);
}

// ── curved: passes through every waypoint ─────────────────────
{
    const d = R.path(MID, 'curved');
    check(/C/.test(d), `curved emitted no cubic: ${d}`);
    // each cubic ends on the next waypoint
    MID.slice(1).forEach((p) => {
        check(d.includes(`${p.x} ${p.y}`), `curved does not pass through (${p.x},${p.y})`);
    });
}

// ── bezier: one cubic, endpoints only ─────────────────────────
{
    const d = R.path(MID, 'bezier');
    check((d.match(/C/g) || []).length === 1, `bezier should emit exactly one cubic: ${d}`);
    check(d.startsWith('M 0 0') && d.endsWith('200 120'), `bezier does not span the endpoints: ${d}`);
    // the intermediate waypoints are deliberately ignored — same path with or
    // without them, which is the property that makes it a *connector* style
    check(R.path([A, B], 'bezier') === d, 'bezier changed when given interior waypoints');
}

// ── degenerate input degrades, never throws ───────────────────
{
    R.STYLES.forEach((s) => {
        let threw = false;
        try {
            R.path([], s); R.path([A], s); R.path([A, A], s);
            R.path([A, { x: NaN, y: 3 }, B], s);
        } catch (e) { threw = true; }
        check(!threw, `style "${s}" threw on degenerate input`);
    });
    check(R.path([], 'direct') === '', 'an empty point list should produce an empty path');
    // An unknown style must still draw. A blank `d` is an invisible wire,
    // which reads as data loss rather than as an unsupported option.
    check(R.path([A, B], 'no-such-style') === R.path([A, B], R.DEFAULT_STYLE),
        'an unknown style did not fall back to the default');
}

// ── every style has a picker label ────────────────────────────
R.STYLES.forEach((s) => {
    check(!!R.LABELS[s], `style "${s}" has no label for the picker`);
});

if (failures.length) {
    console.log(`\nedge router checks: ${checks}`);
    console.log(`FAIL — ${failures.length}:`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log(`\nedge router checks: ${checks}/${checks}`);
console.log('PASS — five route styles that are genuinely five paths: direct is');
console.log('       straight, manhattan is square, orthogonal is the same route');
console.log('       with rounded corners (and collapses onto manhattan at radius');
console.log('       0), curved passes through every waypoint, bezier spans the');
console.log('       endpoints in one cubic; degenerate input degrades and an');
console.log('       unknown style still draws.');
