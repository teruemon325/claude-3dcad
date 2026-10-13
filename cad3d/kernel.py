"""Thin wrapper around the ``usd_brep`` kernel.

Everything that touches the kernel goes through this module so the rest of the
application deals only with plain Python data (tuples, dicts, lists).
"""

from __future__ import annotations

import math
import threading
from typing import Iterable, Sequence

import usd_brep as sm

Vec3 = tuple[float, float, float]

# The kernel uses a process-global context; serialize all access to it.
LOCK = threading.RLock()

PLANES = ("XY", "YZ", "XZ")


class KernelError(RuntimeError):
    """Raised when a modeling operation fails in the kernel."""


def _v(p: Sequence[float]) -> Vec3:
    return (float(p[0]), float(p[1]), float(p[2]))


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def box(origin: Vec3, length: float, width: float, height: float) -> sm.Brep:
    return sm.create_box(_v(origin), float(length), float(width), float(height))


def cylinder(origin: Vec3, radius: float, height: float) -> sm.Brep:
    return sm.create_cylinder(_v(origin), float(radius), float(height))


def sphere(origin: Vec3, radius: float) -> sm.Brep:
    return sm.create_sphere(_v(origin), float(radius))


def cone(origin: Vec3, radius_base: float, radius_top: float, height: float) -> sm.Brep:
    return sm.create_cone(_v(origin), float(radius_base), float(radius_top), float(height))


def torus(origin: Vec3, radius_major: float, radius_minor: float) -> sm.Brep:
    return sm.create_torus(_v(origin), float(radius_major), float(radius_minor))


def pyramid(origin: Vec3, length: float, height: float) -> sm.Brep:
    return sm.create_pyramid(_v(origin), float(length), float(height))


# ---------------------------------------------------------------------------
# Sketch profiles (built in the local XY plane at z=0)
# ---------------------------------------------------------------------------


def profile_curves(profile: dict) -> list:
    """Build closed planar profile curves in the local XY plane."""
    kind = profile.get("type", "rectangle")
    cx, cy = float(profile.get("cx", 0.0)), float(profile.get("cy", 0.0))
    if kind == "rectangle":
        return sm.create_rectangle((cx, cy, 0.0), float(profile["width"]), float(profile["height"]))
    if kind == "circle":
        return [sm.create_circle((cx, cy, 0.0), float(profile["radius"]))]
    if kind == "polygon":
        return sm.create_regular_polygon((cx, cy, 0.0), int(profile["sides"]), float(profile["radius"]))
    if kind == "polyline":
        pts = [(float(x), float(y)) for x, y in profile["points"]]
        return polyline_curves(pts)
    raise KernelError(f"unknown profile type: {kind}")


def polyline_curves(points: Sequence[tuple[float, float]]) -> list:
    """Closed polyline (in local XY) as line segments; duplicate closing point is dropped."""
    pts = list(points)
    if len(pts) >= 2 and math.dist(pts[0], pts[-1]) < 1e-9:
        pts.pop()
    if len(pts) < 3:
        raise KernelError("a polyline profile needs at least 3 distinct points")
    curves = []
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        if math.dist(a, b) < 1e-9:
            raise KernelError("polyline profile has coincident consecutive points")
        curves.append(sm.create_line_segment((a[0], a[1], 0.0), (b[0], b[1], 0.0)))
    return curves


def place_on_plane(brep: sm.Brep, plane: str, offset: float) -> sm.Brep:
    """Map a body built in local XY (normal +Z) onto a world sketch plane.

    XY: local (x, y, z) -> world (x, y, z)
    XZ: local (x, y, z) -> world (x, -z, y)   (sketch normal is world -Y)
    YZ: local (x, y, z) -> world (z, x, y)    (sketch normal is world +X)

    The body is then shifted by ``offset`` along the sketch normal.
    """
    plane = plane.upper()
    if plane == "XY":
        pass
    elif plane == "XZ":
        # rotate +90 deg about X: y -> z, z -> -y
        sm.rotate(brep, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), 90.0)
    elif plane == "YZ":
        # rotate so that local X -> Y, local Y -> Z, local Z -> X
        sm.rotate(brep, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), 90.0)
        sm.rotate(brep, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), 90.0)
    else:
        raise KernelError(f"unknown sketch plane: {plane}")
    if offset:
        sm.translate(brep, tuple(float(offset) * c for c in plane_normal(plane)))
    return brep


def plane_normal(plane: str) -> Vec3:
    return {"XY": (0.0, 0.0, 1.0), "XZ": (0.0, -1.0, 0.0), "YZ": (1.0, 0.0, 0.0)}[plane.upper()]


def extrude(profile: dict, distance: float, plane: str = "XY", offset: float = 0.0, symmetric: bool = False) -> sm.Brep:
    distance = float(distance)
    if abs(distance) < 1e-9:
        raise KernelError("extrude distance must be non-zero")
    curves = profile_curves(profile)
    if symmetric:
        body = sm.linear_sweep(curves, (0.0, 0.0, 1.0), abs(distance))
        sm.translate(body, (0.0, 0.0, -abs(distance) / 2.0))
    else:
        direction = (0.0, 0.0, 1.0 if distance > 0 else -1.0)
        body = sm.linear_sweep(curves, direction, abs(distance))
    return place_on_plane(body, plane, offset)


def revolve(points: Sequence[tuple[float, float]], angle_deg: float) -> sm.Brep:
    """Revolve a closed (r, z) profile about the world Z axis."""
    for r, _ in points:
        if float(r) < -1e-9:
            raise KernelError("revolve profile must stay on the +X side of the axis (r >= 0)")
    pts2 = [(float(r), float(z)) for r, z in points]
    if len(pts2) >= 2 and math.dist(pts2[0], pts2[-1]) < 1e-9:
        pts2.pop()
    if len(pts2) < 3:
        raise KernelError("a revolve profile needs at least 3 distinct points")
    curves = [
        sm.create_line_segment((a[0], 0.0, a[1]), (b[0], 0.0, b[1]))
        for a, b in zip(pts2, pts2[1:] + pts2[:1])
    ]
    return sm.rotational_sweep(curves, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), float(angle_deg))


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


BOOLEAN_OPS = {
    "union": sm.boolean_union,
    "difference": sm.boolean_difference,
    "intersection": sm.boolean_intersection,
}


def boolean(op: str, a: sm.Brep, b: sm.Brep) -> sm.Brep:
    """Pure boolean: copies inputs so callers keep their bodies."""
    fn = BOOLEAN_OPS.get(op)
    if fn is None:
        raise KernelError(f"unknown boolean op: {op}")
    return _check_solid(fn(a.copy(), b.copy()), f"boolean {op}")


def make_ref(brep: sm.Brep, point: Sequence[float]) -> dict:
    """Topological reference: a point on the entity plus the same point normalized to the body's bounding box.

    The normalized coordinates let a reference follow its entity when upstream
    dimensions change (e.g. the top edge of a box whose height was edited).
    """
    (x0, y0, z0), (x1, y1, z1) = brep.bounding_box()
    p = _v(point)
    n = tuple((c - lo) / (hi - lo) if hi - lo > 1e-12 else 0.5 for c, lo, hi in zip(p, (x0, y0, z0), (x1, y1, z1)))
    return {"p": list(p), "n": list(n)}


def _ref_candidates(brep: sm.Brep, ref) -> list[Vec3]:
    if isinstance(ref, dict):
        out = [_v(ref["p"])]
        if ref.get("n") is not None:
            (x0, y0, z0), (x1, y1, z1) = brep.bounding_box()
            out.append(tuple(lo + c * (hi - lo) for c, lo, hi in zip(ref["n"], (x0, y0, z0), (x1, y1, z1))))
        return out
    return [_v(ref)]


def _resolve(entities: list, refs: Iterable, tol: float, dist, brep: sm.Brep, what: str) -> list:
    out = []
    for ref in refs:
        found = None
        for q in _ref_candidates(brep, ref):
            best, best_d = None, math.inf
            for e in entities:
                d = dist(e, q)
                if d < best_d:
                    best, best_d = e, d
            if best is not None and best_d <= tol:
                found = best
                break
        if found is None:
            p = ref["p"] if isinstance(ref, dict) else ref
            raise KernelError(f"referenced {what} near {tuple(round(c, 3) for c in p)} no longer exists")
        if found not in out:
            out.append(found)
    return out


def find_edges(brep: sm.Brep, refs: Iterable, tol: float) -> list:
    """Resolve edge references to kernel edges of ``brep``."""
    return _resolve(brep.edges(), refs, tol, lambda e, q: e.closest_point(q)[2], brep, "edge")


def find_faces(brep: sm.Brep, refs: Iterable, tol: float) -> list:
    """Resolve face references to kernel faces of ``brep``."""
    return _resolve(brep.faces(), refs, tol, lambda f, q: f.closest_point(q)[1], brep, "face")


def _check_solid(brep: sm.Brep, what: str) -> sm.Brep:
    """Reject results the kernel returns without raising but that are not usable solids."""
    if brep is None or brep.face_count() == 0:
        raise KernelError(f"{what} produced an empty result")
    if brep.is_manifold_solid() and brep.volume() <= 1e-12:
        raise KernelError(f"{what} produced a solid with no volume")
    if not brep.is_manifold_solid() and brep.volume() <= 1e-12:
        raise KernelError(f"{what} produced an invalid (non-solid) result")
    return brep


def fillet(brep: sm.Brep, edge_refs: Sequence, radius: float, chamfer: bool = False) -> sm.Brep:
    if not edge_refs:
        raise KernelError("select at least one edge")
    body = brep.copy()
    edges = find_edges(body, edge_refs, ref_tolerance(body))
    body = sm.fillet_edges(body, edges, radius=float(radius), xsect_type=0 if chamfer else 1)
    return _check_solid(body, "chamfer" if chamfer else "fillet")


def shell(brep: sm.Brep, face_refs: Sequence, thickness: float) -> sm.Brep:
    faces = find_faces(brep, face_refs, ref_tolerance(brep)) if face_refs else []
    return _check_solid(sm.shell_brep(brep, -abs(float(thickness)), faces_to_shell=faces), "shell")


def offset(brep: sm.Brep, distance: float) -> sm.Brep:
    if abs(float(distance)) < 1e-12:
        raise KernelError("offset distance must be non-zero")
    return _check_solid(sm.offset_brep(brep, float(distance)), "offset")


def transform(brep: sm.Brep, translate: Vec3, rotate_axis: Vec3, rotate_deg: float, pivot: Vec3, scale: float) -> sm.Brep:
    body = brep.copy()
    if scale and abs(float(scale) - 1.0) > 1e-12:
        sm.scale_about_point(body, _v(pivot), (float(scale),) * 3)
    if rotate_deg and any(abs(c) > 1e-12 for c in rotate_axis):
        sm.rotate(body, _v(pivot), _v(rotate_axis), float(rotate_deg))
    if any(abs(c) > 0 for c in translate):
        sm.translate(body, _v(translate))
    return body


def mirror_copy(brep: sm.Brep, plane: str, offset: float) -> sm.Brep:
    plane = plane.upper()
    axis = {"YZ": 0, "XZ": 1, "XY": 2}[plane]
    s = [1.0, 1.0, 1.0]
    s[axis] = -1.0
    pivot = [0.0, 0.0, 0.0]
    pivot[axis] = float(offset)
    body = brep.copy()
    sm.scale_about_point(body, tuple(pivot), tuple(s))
    return body


def linear_pattern(brep: sm.Brep, direction: Vec3, spacing: float, count: int) -> sm.Brep:
    n = math.sqrt(sum(c * c for c in direction))
    if n < 1e-12:
        raise KernelError("pattern direction must be non-zero")
    if int(count) < 1:
        raise KernelError("pattern count must be >= 1")
    d = tuple(c / n * float(spacing) for c in direction)
    result = brep.copy()
    for i in range(1, int(count)):
        inst = sm.translate(brep.copy(), tuple(c * i for c in d))
        result = sm.boolean_union(result, inst)
    return result


def circular_pattern(brep: sm.Brep, axis: Vec3, center: Vec3, count: int, angle_deg: float) -> sm.Brep:
    count = int(count)
    if count < 1:
        raise KernelError("pattern count must be >= 1")
    full = abs(abs(float(angle_deg)) - 360.0) < 1e-9
    step = float(angle_deg) / (count if full else max(count - 1, 1))
    result = brep.copy()
    for i in range(1, count):
        inst = sm.rotate(brep.copy(), _v(center), _v(axis), step * i)
        result = sm.boolean_union(result, inst)
    return result


# ---------------------------------------------------------------------------
# Queries / output
# ---------------------------------------------------------------------------


def ref_tolerance(brep: sm.Brep) -> float:
    (x0, y0, z0), (x1, y1, z1) = brep.bounding_box()
    diag = math.dist((x0, y0, z0), (x1, y1, z1))
    return max(1e-3, diag * 2e-3)


def mesh(brep: sm.Brep, quality: str = "normal") -> dict:
    """Tessellate a body to flat arrays for WebGL plus per-edge polylines."""
    (x0, y0, z0), (x1, y1, z1) = brep.bounding_box()
    diag = max(math.dist((x0, y0, z0), (x1, y1, z1)), 1e-6)
    chord, angle = {"coarse": (diag * 4e-3, 30.0), "fine": (diag * 3e-4, 8.0)}.get(quality, (diag * 1e-3, 15.0))
    poly = sm.tessellate(brep, chord_height_tolerance=chord, curve_angle_tolerance_deg=angle,
                         surface_angle_tolerance_deg=angle)
    # Corner normals keep creases between faces sharp; expand to a non-indexed triangle soup.
    arrays = poly.to_mesh_arrays(face_varying_normals=True)
    points, corner_normals, stream = arrays["points"], arrays["normals"], arrays["faces"]
    positions: list[float] = []
    normals: list[float] = []
    i = corner = 0
    while i < len(stream):
        n = stream[i]
        poly_idx = stream[i + 1 : i + 1 + n]
        for k in range(1, n - 1):  # fan-triangulate (faces are triangles in practice)
            for c in (0, k, k + 1):
                positions.extend(points[poly_idx[c]])
                normals.extend(corner_normals[corner + c])
        i += n + 1
        corner += n

    pts, counts, _ = sm.tessellate_boundaries(brep, angle_tolerance_deg=angle, allow_partial=True)
    edges = []
    off = 0
    for c in counts:
        edges.append([coord for p in pts[off : off + c] for coord in p])
        off += c
    return {"positions": positions, "normals": normals, "edges": edges}


def properties(brep: sm.Brep) -> dict:
    info = brep.info()
    out = {
        "faces": info["faces"],
        "edges": info["edges"],
        "vertices": info["vertices"],
        "manifold": bool(info["manifold"]),
        "volume": info["volume"],
        "bounds": info["bounds"],
        "area": None,
        "centroid": None,
    }
    try:
        out["area"] = brep.area()
    except RuntimeError:
        pass
    if out["manifold"]:
        try:
            mp = brep.mass_properties()
            out["centroid"] = mp.get("center_of_mass") or mp.get("centroid")
        except RuntimeError:
            pass
    return out


def pick_edge(brep: sm.Brep, index: int) -> dict:
    """Reference (at the parametric midpoint) for the edge at ``index`` of ``brep.edges()``."""
    e = brep.edges()[index]
    t0, t1 = e.parameter_range()
    return make_ref(brep, e.point_at(0.5 * (t0 + t1)))


def pick_face(brep: sm.Brep, point: Vec3) -> tuple[int, dict]:
    """Closest face to a picked point and a reference to it."""
    faces = brep.faces()
    best, best_d = -1, math.inf
    for i, f in enumerate(faces):
        _, d = f.closest_point(_v(point))
        if d < best_d:
            best, best_d = i, d
    if best < 0:
        raise KernelError("no face found")
    return best, make_ref(brep, faces[best].closest_point(_v(point))[0])


def export_usd(breps: Sequence[sm.Brep], path: str) -> None:
    sm.usd.export_breps(list(breps), path)


def export_usd_mesh(breps: Sequence[sm.Brep], path: str) -> None:
    meshes = [sm.tessellate(b, chord_height_tolerance=0.0) for b in breps]
    sm.usd.export_meshes(meshes, path)


def import_usd(path: str) -> list:
    return list(sm.usd.import_breps(path))


def write_stl(breps: Sequence[sm.Brep], name: str = "claude-3dcad") -> str:
    """ASCII STL of the given bodies."""
    lines = [f"solid {name}"]
    for b in breps:
        m = mesh(b, "fine")
        p = m["positions"]
        for t in range(0, len(p), 9):
            a, b2, c = p[t : t + 3], p[t + 3 : t + 6], p[t + 6 : t + 9]
            u = [b2[i] - a[i] for i in range(3)]
            v = [c[i] - a[i] for i in range(3)]
            n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
            ln = math.sqrt(sum(x * x for x in n)) or 1.0
            lines.append(f"  facet normal {n[0]/ln:.6e} {n[1]/ln:.6e} {n[2]/ln:.6e}")
            lines.append("    outer loop")
            for vtx in (a, b2, c):
                lines.append(f"      vertex {vtx[0]:.6e} {vtx[1]:.6e} {vtx[2]:.6e}")
            lines.append("    endloop")
            lines.append("  endfacet")
    lines.append(f"endsolid {name}")
    return "\n".join(lines) + "\n"
