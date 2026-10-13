"""2D sketches: data model helpers, closed-profile (region) detection and kernel geometry.

A sketch is stored as plain JSON (the ``params`` of a ``sketch`` feature)::

    {
      "plane": {"origin": [x, y, z], "x": [ux, uy, uz], "y": [vx, vy, vz]},
      "points": [{"id": "o", "x": 0, "y": 0}, ...],
      "entities": [
        {"id": "l1", "type": "line", "p1": "a", "p2": "b", "construction": false},
        {"id": "c1", "type": "circle", "c": "m", "r": 5},
        {"id": "a1", "type": "arc", "c": "m", "p1": "s", "p2": "e"}   # counter-clockwise s -> e
      ],
      "constraints": [...]
    }

Point coordinates are the *solved* positions written by the sketch editor's
constraint solver, so the backend only needs the geometry, not the solver.
Connected entities share point ids, which makes profile detection a graph problem.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable

Vec2 = tuple[float, float]

ARC_SAMPLES_PER_RAD = 12
TOL = 1e-7


class SketchError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Plane frames
# ---------------------------------------------------------------------------

STANDARD_PLANES = {
    "XY": {"origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 1, 0]},
    "XZ": {"origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 0, 1]},
    "YZ": {"origin": [0, 0, 0], "x": [0, 1, 0], "y": [0, 0, 1]},
}


def _norm(v):
    n = math.sqrt(sum(c * c for c in v))
    if n < 1e-12:
        raise SketchError("degenerate plane axis")
    return tuple(c / n for c in v)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def frame(plane: dict) -> tuple[tuple, tuple, tuple, tuple]:
    """(origin, x_axis, y_axis, normal), orthonormalized."""
    o = tuple(float(c) for c in plane["origin"])
    x = _norm(plane["x"])
    y0 = plane["y"]
    y = _norm(tuple(c - _dot(y0, x) * xc for c, xc in zip(y0, x)))
    return o, x, y, _cross(x, y)


def to_world(plane: dict, p: Vec2, z: float = 0.0) -> tuple[float, float, float]:
    o, x, y, n = frame(plane)
    return tuple(o[i] + p[0] * x[i] + p[1] * y[i] + z * n[i] for i in range(3))


# ---------------------------------------------------------------------------
# Geometry access
# ---------------------------------------------------------------------------


@dataclass
class Sketch:
    plane: dict
    points: dict[str, Vec2]
    entities: list[dict]

    @classmethod
    def from_params(cls, params: dict) -> "Sketch":
        pts = {}
        for p in params.get("points", []):
            pts[str(p["id"])] = (float(p["x"]), float(p["y"]))
        ents = []
        for e in params.get("entities", []):
            refs = [e.get(k) for k in ("p1", "p2", "c") if e.get(k) is not None]
            for r in refs:
                if r not in pts:
                    raise SketchError(f"entity {e.get('id')} references missing point {r}")
            ents.append(e)
        return cls(plane=params.get("plane") or STANDARD_PLANES["XY"], points=pts, entities=ents)

    def p(self, pid: str) -> Vec2:
        return self.points[pid]

    def radius(self, e: dict) -> float:
        if e["type"] == "circle":
            return float(e["r"])
        c, s = self.p(e["c"]), self.p(e["p1"])
        return math.dist(c, s)

    def arc_angles(self, e: dict) -> tuple[float, float]:
        """Start/end angle (radians) of an arc, end > start, counter-clockwise."""
        c, s, t = self.p(e["c"]), self.p(e["p1"]), self.p(e["p2"])
        a0 = math.atan2(s[1] - c[1], s[0] - c[0])
        a1 = math.atan2(t[1] - c[1], t[0] - c[0])
        while a1 <= a0 + 1e-12:
            a1 += 2 * math.pi
        return a0, a1

    def sample(self, e: dict, forward: bool = True) -> list[Vec2]:
        """Polyline through an entity, from its first to its last point (excluding nothing)."""
        t = e["type"]
        if t == "line":
            pts = [self.p(e["p1"]), self.p(e["p2"])]
        elif t == "arc":
            c, r = self.p(e["c"]), self.radius(e)
            a0, a1 = self.arc_angles(e)
            n = max(4, int((a1 - a0) * ARC_SAMPLES_PER_RAD))
            pts = [(c[0] + r * math.cos(a0 + (a1 - a0) * k / n), c[1] + r * math.sin(a0 + (a1 - a0) * k / n))
                   for k in range(n + 1)]
            pts[0], pts[-1] = self.p(e["p1"]), self.p(e["p2"])
        elif t == "circle":
            c, r = self.p(e["c"]), self.radius(e)
            n = 72
            pts = [(c[0] + r * math.cos(2 * math.pi * k / n), c[1] + r * math.sin(2 * math.pi * k / n))
                   for k in range(n)]
        else:
            raise SketchError(f"unknown entity type {t}")
        return pts if forward else pts[::-1]

    def _tangent_out(self, e: dict, at: str) -> Vec2:
        """Direction leaving point ``at`` along entity ``e``."""
        if e["type"] == "line":
            a, b = self.p(at), self.p(e["p2"] if at == e["p1"] else e["p1"])
            return (b[0] - a[0], b[1] - a[1])
        c, q = self.p(e["c"]), self.p(at)
        rx, ry = q[0] - c[0], q[1] - c[1]
        if at == e["p1"]:
            return (-ry, rx)  # counter-clockwise
        return (ry, -rx)


# ---------------------------------------------------------------------------
# Profile detection
# ---------------------------------------------------------------------------


@dataclass
class Loop:
    edges: list[tuple[dict, bool]]  # (entity, forward) ; a circle is a single edge
    poly: list[Vec2]
    area: float  # signed, counter-clockwise positive

    def contains(self, q: Vec2) -> bool:
        return point_in_polygon(q, self.poly)


@dataclass
class Region:
    outer: Loop
    holes: list[Loop] = field(default_factory=list)
    depth: int = 0
    point: Vec2 = (0.0, 0.0)

    @property
    def area(self) -> float:
        return abs(self.outer.area) - sum(abs(h.area) for h in self.holes)

    def contains(self, q: Vec2) -> bool:
        return self.outer.contains(q) and not any(h.contains(q) for h in self.holes)


def signed_area(poly: list[Vec2]) -> float:
    a = 0.0
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        a += p[0] * q[1] - q[0] * p[1]
    return a / 2


def point_in_polygon(q: Vec2, poly: list[Vec2]) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
        if (y1 > q[1]) != (y2 > q[1]):
            x = x1 + (q[1] - y1) * (x2 - x1) / (y2 - y1)
            if x > q[0]:
                inside = not inside
    return inside


def find_loops(sk: Sketch) -> list[Loop]:
    """Bounded faces of the planar graph formed by non-construction curves, plus circles."""
    loops: list[Loop] = []
    edges = [e for e in sk.entities if not e.get("construction") and e["type"] in ("line", "arc")]
    for e in sk.entities:
        if not e.get("construction") and e["type"] == "circle" and sk.radius(e) > TOL:
            poly = sk.sample(e)
            loops.append(Loop(edges=[(e, True)], poly=poly, area=signed_area(poly)))

    # drop zero-length edges and prune dangling edges (degree-1 vertices) repeatedly
    edges = [e for e in edges if e["p1"] != e["p2"] or e["type"] == "arc"]
    while True:
        deg: dict[str, int] = {}
        for e in edges:
            for k in ("p1", "p2"):
                deg[e[k]] = deg.get(e[k], 0) + 1
        keep = [e for e in edges if deg[e["p1"]] > 1 and deg[e["p2"]] > 1]
        if len(keep) == len(edges):
            break
        edges = keep

    # half-edges: (entity, from, to); outgoing lists sorted by angle at each vertex
    out: dict[str, list[tuple[float, dict, str]]] = {}
    for e in edges:
        for frm, to in ((e["p1"], e["p2"]), (e["p2"], e["p1"])):
            d = sk._tangent_out(e, frm)
            out.setdefault(frm, []).append((math.atan2(d[1], d[0]), e, to))
    for lst in out.values():
        lst.sort(key=lambda t: t[0])

    visited: set[tuple[str, str]] = set()
    for e in edges:
        for start in ((e["p1"], e["id"]), (e["p2"], e["id"])):
            if start in visited:
                continue
            cycle: list[tuple[dict, bool]] = []
            frm, eid = start
            guard = 0
            while (frm, eid) not in visited:
                visited.add((frm, eid))
                ent = next(x for x in edges if x["id"] == eid)
                to = ent["p2"] if frm == ent["p1"] else ent["p1"]
                cycle.append((ent, frm == ent["p1"]))
                # at `to`, pick the outgoing edge just clockwise from the reverse of the incoming one
                d_in = sk._tangent_out(ent, to)
                ang_in = math.atan2(d_in[1], d_in[0])
                lst = out[to]
                best = None
                for ang, cand, _ in lst:
                    if cand["id"] == ent["id"] and len(lst) > 1 and _same_dir(ang, ang_in):
                        continue
                    delta = (ang_in - ang) % (2 * math.pi)
                    if delta < 1e-12:
                        delta = 2 * math.pi
                    if best is None or delta < best[0]:
                        best = (delta, cand)
                frm, eid = to, best[1]["id"]
                guard += 1
                if guard > 10000:
                    raise SketchError("profile detection did not terminate")
            poly: list[Vec2] = []
            for ent, fwd in cycle:
                poly.extend(sk.sample(ent, fwd)[:-1])
            if len(poly) >= 3:
                a = signed_area(poly)
                if a > TOL:
                    loops.append(Loop(edges=cycle, poly=poly, area=a))
    return loops


def _same_dir(a: float, b: float) -> bool:
    d = (a - b) % (2 * math.pi)
    return d < 1e-9 or d > 2 * math.pi - 1e-9


def find_regions(sk: Sketch) -> list[Region]:
    loops = find_loops(sk)
    probe = [_probe_point(lp) for lp in loops]
    # parent = smallest loop strictly containing this loop
    parents: list[int | None] = []
    for i, lp in enumerate(loops):
        best = None
        for j, other in enumerate(loops):
            if i == j or abs(other.area) <= abs(lp.area) + TOL:
                continue
            if other.contains(probe[i]) and all(other.contains(q) for q in lp.poly[:: max(1, len(lp.poly) // 8)]):
                if best is None or abs(other.area) < abs(loops[best].area):
                    best = j
        parents.append(best)
    regions = []
    for i, lp in enumerate(loops):
        depth, k = 0, parents[i]
        while k is not None:
            depth, k = depth + 1, parents[k]
        holes = [loops[j] for j in range(len(loops)) if parents[j] == i]
        r = Region(outer=lp, holes=holes, depth=depth)
        r.point = interior_point(r)
        regions.append(r)
    regions.sort(key=lambda r: (r.depth, -r.area))
    return regions


def _probe_point(lp: Loop) -> Vec2:
    return interior_point(Region(outer=lp))


def interior_point(r: Region) -> Vec2:
    """A point strictly inside the region (outside its holes), away from the boundary when possible."""
    ys = [p[1] for p in r.outer.poly]
    y0, y1 = min(ys), max(ys)
    best, best_w = None, -1.0
    for k in range(1, 16):
        y = y0 + (y1 - y0) * k / 16
        xs = []
        for lp in [r.outer] + r.holes:
            n = len(lp.poly)
            for i in range(n):
                (ax, ay), (bx, by) = lp.poly[i], lp.poly[(i + 1) % n]
                if (ay > y) != (by > y):
                    xs.append(ax + (y - ay) * (bx - ax) / (by - ay))
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            w = xs[i + 1] - xs[i]
            if w > best_w:
                best, best_w = ((xs[i] + xs[i + 1]) / 2, y), w
    if best is None:
        best = r.outer.poly[0]
    return best


def default_regions(regions: list[Region]) -> list[Region]:
    """Regions selected when a feature does not name any: the outermost ones."""
    return [r for r in regions if r.depth % 2 == 0] or regions


def select_regions(regions: list[Region], refs: Iterable[Vec2] | None) -> list[Region]:
    refs = list(refs or [])
    if not refs:
        return default_regions(regions)
    chosen: list[Region] = []
    for q in refs:
        q = (float(q[0]), float(q[1]))
        hit = [r for r in regions if r.contains(q)]
        if not hit:
            raise SketchError(f"no closed profile at ({q[0]:.3g}, {q[1]:.3g}); the sketch changed")
        best = min(hit, key=lambda r: abs(r.outer.area))
        if best not in chosen:
            chosen.append(best)
    return chosen


# ---------------------------------------------------------------------------
# Serialization for the UI
# ---------------------------------------------------------------------------


def describe(params: dict) -> dict:
    """Curves and regions of a sketch, in sketch-local 2D coordinates."""
    sk = Sketch.from_params(params)
    curves = []
    for e in sk.entities:
        try:
            pts = sk.sample(e)
        except (KeyError, ValueError):
            continue
        if e["type"] == "circle":
            pts = pts + [pts[0]]
        curves.append({"id": e["id"], "type": e["type"], "construction": bool(e.get("construction")), "points": pts})
    regions = []
    try:
        for r in find_regions(sk):
            regions.append({
                "point": list(r.point),
                "outer": [list(p) for p in r.outer.poly],
                "holes": [[list(p) for p in h.poly] for h in r.holes],
                "depth": r.depth,
                "area": r.area,
            })
        error = None
    except SketchError as ex:
        error = str(ex)
    return {"plane": sk.plane, "curves": curves, "regions": regions, "error": error}
