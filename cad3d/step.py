"""STEP import / export.

The USD BRep kernel has no STEP translator, so OpenCASCADE (``cadquery-ocp``)
is used as the STEP reader/writer and the exact geometry crosses between the two
kernels through the USD ``BrepArray`` data (see :mod:`cad3d.brep_usda`):

* export: SMLib Brep -> BrepArray (``usd_brep.usd.export_brep``) -> OCCT faces
  built from the same analytic / NURBS surfaces and NURBS edge curves -> STEP.
* import: STEP -> OCCT shape -> closed faces split so no face has a seam ->
  one BrepArray of loose faces -> ``usd_brep.usd.import_breps`` ->
  ``stitch_into_solid``.

Geometry is transferred exactly (no tessellation, no surface refitting).
"""

from __future__ import annotations

import contextlib
import math
import os
import sys
import tempfile
from typing import Any, Sequence

from . import brep_usda as BU

try:  # OpenCASCADE is an optional dependency
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepBuilderAPI import (
        BRepBuilderAPI_MakeEdge,
        BRepBuilderAPI_MakeFace,
        BRepBuilderAPI_MakeVertex,
        BRepBuilderAPI_MakeWire,
        BRepBuilderAPI_Sewing,
    )
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepTools import BRepTools, BRepTools_WireExplorer
    from OCP.Geom import (
        Geom_BSplineCurve,
        Geom_BSplineSurface,
        Geom_ConicalSurface,
        Geom_CylindricalSurface,
        Geom_Plane,
        Geom_SphericalSurface,
        Geom_ToroidalSurface,
        Geom_TrimmedCurve,
    )
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Sphere, GeomAbs_Torus
    from OCP.GeomConvert import GeomConvert
    from OCP.GProp import GProp_GProps
    from OCP.gp import gp_Ax3, gp_Dir, gp_Pnt
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.ShapeFix import ShapeFix_Edge, ShapeFix_Face, ShapeFix_Shape, ShapeFix_Solid, ShapeFix_Wire
    from OCP.ShapeUpgrade import ShapeUpgrade_ShapeDivideClosed
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
    from OCP.TColgp import TColgp_Array1OfPnt, TColgp_Array2OfPnt
    from OCP.TColStd import TColStd_Array1OfInteger, TColStd_Array1OfReal, TColStd_Array2OfReal
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_FORWARD, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Face, TopoDS_Shell, TopoDS_Solid, TopoDS_Wire

    AVAILABLE = True
except ImportError as _ex:  # pragma: no cover - exercised only without OCP
    IMPORT_ERROR = _ex
    AVAILABLE = False


TOL = 1e-6


class StepError(RuntimeError):
    pass


@contextlib.contextmanager
def _quiet():
    """Silence OpenCASCADE's translation statistics, which are printed to the C-level stdout."""
    try:
        sys.stdout.flush()
        fd = sys.stdout.fileno()
    except (AttributeError, OSError, ValueError):
        yield
        return
    saved = os.dup(fd)
    try:
        with open(os.devnull, "w") as null:
            os.dup2(null.fileno(), fd)
            yield
    finally:
        os.dup2(saved, fd)
        os.close(saved)


def require() -> None:
    if not AVAILABLE:
        raise StepError(
            "STEP support needs OpenCASCADE: install it with  pip install cadquery-ocp  "
            "(or reinstall the app with the 'step' extra)"
        )


# ===========================================================================
# helpers
# ===========================================================================


def _pnt(p) -> "gp_Pnt":
    return gp_Pnt(float(p[0]), float(p[1]), float(p[2]))


def _dir(v) -> "gp_Dir":
    return gp_Dir(float(v[0]), float(v[1]), float(v[2]))


def _ax3(origin, axis, ref) -> "gp_Ax3":
    return gp_Ax3(_pnt(origin), _dir(axis), _dir(ref))


def _knots_mults(knots: Sequence[float], tol: float = 1e-12):
    """Flat knot vector -> (distinct knots, multiplicities)."""
    ks: list[float] = []
    ms: list[int] = []
    for k in knots:
        if ks and abs(k - ks[-1]) <= tol * max(1.0, abs(k)):
            ms[-1] += 1
        else:
            ks.append(float(k))
            ms.append(1)
    return ks, ms


def _arr_real(vals) -> "TColStd_Array1OfReal":
    a = TColStd_Array1OfReal(1, len(vals))
    for i, v in enumerate(vals, 1):
        a.SetValue(i, float(v))
    return a


def _arr_int(vals) -> "TColStd_Array1OfInteger":
    a = TColStd_Array1OfInteger(1, len(vals))
    for i, v in enumerate(vals, 1):
        a.SetValue(i, int(v))
    return a


# ===========================================================================
# BrepArray -> OCCT
# ===========================================================================


class _Packed:
    """Per-type running offsets into the packed geometry arrays of a BrepArray prim."""

    def __init__(self, prim: dict):
        self.p = prim
        # index of each face within the packed array of its surface type
        self.face_slot: list[int] = []
        counts: dict[str, int] = {}
        for t in prim.get("face:surfaceType", []):
            self.face_slot.append(counts.get(t, 0))
            counts[t] = counts.get(t, 0) + 1
        # NURBS surface offsets
        p = prim
        self.sn_cv, self.sn_uk, self.sn_vk = [0], [0], [0]
        for nu, nv, ou, ov in zip(p.get("brep:surface:nurb:uVertexCount", []), p.get("brep:surface:nurb:vVertexCount", []),
                                  p.get("brep:surface:nurb:uOrder", []), p.get("brep:surface:nurb:vOrder", [])):
            self.sn_cv.append(self.sn_cv[-1] + nu * nv)
            self.sn_uk.append(self.sn_uk[-1] + nu + ou)
            self.sn_vk.append(self.sn_vk[-1] + nv + ov)
        # edge curve offsets (per curve type)
        self.edge_slot: list[int] = []
        counts = {}
        for t in p.get("edge:curveType", []):
            self.edge_slot.append(counts.get(t, 0))
            counts[t] = counts.get(t, 0) + 1
        self.cn_cv, self.cn_k = [0], [0]
        for n, o in zip(p.get("brep:edge3dNurb:curve3d:nurb:vertexCount", []), p.get("brep:edge3dNurb:curve3d:nurb:order", [])):
            self.cn_cv.append(self.cn_cv[-1] + n)
            self.cn_k.append(self.cn_k[-1] + n + o)

    def surface(self, f: int):
        p = self.p
        t = BU.SURFACE_APIS[p["face:surfaceType"][f]]
        i = self.face_slot[f]
        g = lambda k: p[f"brep:surface:{t}:{k}"][i]  # noqa: E731
        if t == "plane":
            return Geom_Plane(_ax3(g("origin"), g("axis"), g("refDirection")))
        if t == "cylinder":
            return Geom_CylindricalSurface(_ax3(g("origin"), g("axis"), g("refDirection")), g("radius"))
        if t == "cone":
            ax = _ax3(g("origin"), g("axis"), g("refDirection"))
            a = g("semiAngle")
            if abs(a) < 1e-12:
                return Geom_CylindricalSurface(ax, g("radius"))
            return Geom_ConicalSurface(ax, a, g("radius"))
        if t == "sphere":
            return Geom_SphericalSurface(_ax3(g("center"), g("axis"), g("refDirection")), g("radius"))
        if t == "torus":
            return Geom_ToroidalSurface(_ax3(g("origin"), g("axis"), g("refDirection")), g("majorRadius"), g("minorRadius"))
        # NURBS: control vertices are u-major (index = iu * nv + iv)
        nu = p["brep:surface:nurb:uVertexCount"][i]
        nv = p["brep:surface:nurb:vVertexCount"][i]
        ou = p["brep:surface:nurb:uOrder"][i]
        ov = p["brep:surface:nurb:vOrder"][i]
        cvs = p["brep:surface:nurb:controlVertices"][self.sn_cv[i]:self.sn_cv[i + 1]]
        ws = p.get("brep:surface:nurb:weights", [])[self.sn_cv[i]:self.sn_cv[i + 1]] or [1.0] * (nu * nv)
        uk, um = _knots_mults(p["brep:surface:nurb:uKnots"][self.sn_uk[i]:self.sn_uk[i + 1]])
        vk, vm = _knots_mults(p["brep:surface:nurb:vKnots"][self.sn_vk[i]:self.sn_vk[i + 1]])
        poles = TColgp_Array2OfPnt(1, nu, 1, nv)
        weights = TColStd_Array2OfReal(1, nu, 1, nv)
        for iu in range(nu):
            for iv in range(nv):
                k = iu * nv + iv
                poles.SetValue(iu + 1, iv + 1, _pnt(cvs[k]))
                weights.SetValue(iu + 1, iv + 1, float(ws[k]))
        return Geom_BSplineSurface(poles, weights, _arr_real(uk), _arr_real(vk), _arr_int(um), _arr_int(vm), ou - 1, ov - 1)

    def curve(self, e: int):
        p = self.p
        t = p["edge:curveType"][e]
        if t != "BrepCurve3dNurbAPI":
            raise StepError(f"edge curve type {t} is not supported")
        i = self.edge_slot[e]
        n = p["brep:edge3dNurb:curve3d:nurb:vertexCount"][i]
        o = p["brep:edge3dNurb:curve3d:nurb:order"][i]
        cvs = p["brep:edge3dNurb:curve3d:nurb:controlVertices"][self.cn_cv[i]:self.cn_cv[i + 1]]
        ws = p.get("brep:edge3dNurb:curve3d:nurb:weights", [])[self.cn_cv[i]:self.cn_cv[i + 1]] or [1.0] * n
        ks, ms = _knots_mults(p["brep:edge3dNurb:curve3d:nurb:knots"][self.cn_k[i]:self.cn_k[i + 1]])
        poles = TColgp_Array1OfPnt(1, n)
        for k in range(n):
            poles.SetValue(k + 1, _pnt(cvs[k]))
        return Geom_BSplineCurve(poles, _arr_real(ws), _arr_real(ks), _arr_int(ms), o - 1)


def _brep_prim_to_occ(prim: dict):
    """Build an OCCT solid (or shell) from one BrepArray prim containing one Brep."""
    pk = _Packed(prim)
    p = prim
    nfaces = len(p.get("face:surfaceType", []))
    nedges = len(p.get("edge:curveType", []))
    verts = [BRepBuilderAPI_MakeVertex(_pnt(v)).Vertex() for v in p.get("brep:vertexPoint:point:position", [])]
    ranges = p.get("edge:range", [])
    edges: list[Any] = []
    for e in range(nedges):
        t0, t1 = ranges[2 * e], ranges[2 * e + 1]
        if abs(t1 - t0) < 1e-12:
            edges.append(None)  # degenerate (pole) edge
            continue
        vs, ve = p["edge:vertexIndices"][e]
        mk = BRepBuilderAPI_MakeEdge(pk.curve(e), verts[vs], verts[ve], t0, t1)
        if not mk.IsDone():
            mk = BRepBuilderAPI_MakeEdge(pk.curve(e), t0, t1)
        edges.append(mk.Edge())

    # face orientation: outward when the faceuse in the first (infinite, void) region shell is "same"
    face_outward = [True] * nfaces
    shell_counts = p.get("shell:faceuseCount", [])
    first_shell = shell_counts[0] if shell_counts else 0
    for k in range(first_shell):
        f = p["faceuse:faceIndex"][k]
        face_outward[f] = p["faceuse:orientationType"][k] == "same"

    loop_counts = p.get("loop:edgeuseCount", [])
    eu_edge = p.get("edgeuse:edgeIndex", [])
    eu_or = p.get("edgeuse:orientationType", [])
    b = BRep_Builder()
    li = 0
    eu = 0
    faces = []
    for f in range(nfaces):
        surf = pk.surface(f)
        face = TopoDS_Face()
        b.MakeFace(face, surf, TOL)
        loops = []
        for _ in range(p["face:loopCount"][f]):
            n = loop_counts[li]
            li += 1
            loops.append([(eu_edge[eu + k], eu_or[eu + k]) for k in range(n)])
            eu += n
        uses: dict[int, int] = {}
        for loop in loops:
            for e, _o in loop:
                uses[e] = uses.get(e, 0) + 1
        wires = []
        for loop in loops:
            w = TopoDS_Wire()
            b.MakeWire(w)
            for e, o in loop:
                if edges[e] is None:
                    continue  # pole: ShapeFix adds an OCCT degenerated edge
                b.Add(w, edges[e] if o == "same" else edges[e].Reversed())
            b.Add(face, w)
            wires.append(w)
        # pcurves: seam edges (used twice by the face) get the pair of iso-curves
        sfe = ShapeFix_Edge()
        for e, k in uses.items():
            if edges[e] is not None:
                sfe.FixAddPCurve(edges[e], face, k == 2, TOL)
        for w in wires:
            sfw = ShapeFix_Wire(w, face, TOL)
            sfw.FixShifted()
            sfw.FixDegenerated()
            sfw.FixConnected()
            sfw.FixLacking()
            sfw.FixClosed()
        face = _rebuilt_face(face)
        if not face_outward[f]:
            face = TopoDS.Face_s(face.Reversed())
        faces.append(face)

    shell = TopoDS_Shell()
    b.MakeShell(shell)
    for fc in faces:
        b.Add(shell, fc)
    # sewing merges the seams and any edges ShapeFix rebuilt
    sew = BRepBuilderAPI_Sewing(1e-5)
    sew.Add(shell)
    sew.Perform()
    sewn = sew.SewedShape()
    exp = TopExp_Explorer(sewn, TopAbs_SHELL)
    if exp.More():
        shell = TopoDS.Shell_s(exp.Current())
    else:  # a single closed face (sphere, torus) comes back from sewing as a bare face
        shell = TopoDS_Shell()
        b.MakeShell(shell)
        fexp = TopExp_Explorer(sewn, TopAbs_FACE)
        while fexp.More():
            b.Add(shell, fexp.Current())
            fexp.Next()
    if len(p.get("region:type", [])) > 1:
        solid = TopoDS_Solid()
        b.MakeSolid(solid)
        b.Add(solid, shell)
        fs = ShapeFix_Solid(solid)
        fs.Perform()
        result = fs.Solid()
    else:
        result = shell
    fixer = ShapeFix_Shape(result)
    fixer.Perform()
    return fixer.Shape()


def _rebuilt_face(face):
    """Re-collect wires after ShapeFix_Wire edited them, fix orientation of inner/outer wires."""
    fix = ShapeFix_Face(face)
    fix.SetPrecision(TOL)
    fix.Perform()
    return fix.Face()


def _chains_to_wires(chain, edges) -> list:
    """Wires from an ordered list of (edge index, orientation); splits where a dropped seam broke the loop."""
    wires = []
    mw = BRepBuilderAPI_MakeWire()
    for e, o in chain:
        ed = edges[e]
        ed = ed if o == "same" else TopoDS.Edge_s(ed.Reversed())
        mw.Add(ed)
        if not mw.IsDone():
            # the chain is disconnected here (a seam was removed): start a new wire
            mw = BRepBuilderAPI_MakeWire()
            mw.Add(ed)
        if mw.IsDone() and mw.Wire().Closed():
            wires.append(mw.Wire())
            mw = BRepBuilderAPI_MakeWire()
    if mw.IsDone():
        try:
            w = mw.Wire()
            if not w.IsNull():
                wires.append(w)
        except Exception:  # noqa: BLE001 - empty builder
            pass
    return wires


def breps_to_occ(breps) -> list:
    import usd_brep as sm

    shapes = []
    for b in breps:
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "b.usda")
            sm.usd.export_brep(b, path)
            with open(path) as fh:
                prims = BU.parse(fh.read())
        for prim in prims:
            shapes.append(_brep_prim_to_occ(prim))
    return shapes


def export_step(breps, path: str, name: str = "claude-3dcad") -> None:
    require()
    shapes = breps_to_occ(breps)
    Interface_Static.SetCVal_s("write.step.schema", "AP214")
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    Interface_Static.SetCVal_s("write.step.product.name", name)
    with _quiet():
        w = STEPControl_Writer()
        for s in shapes:
            if w.Transfer(s, STEPControl_AsIs) != IFSelect_RetDone:
                raise StepError("OpenCASCADE could not translate a body to STEP")
        if w.Write(path) != IFSelect_RetDone:
            raise StepError("writing the STEP file failed")


def occ_volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props, 1e-9)
    return props.Mass()


# ===========================================================================
# OCCT -> BrepArray (loose faces) -> SMLib
# ===========================================================================

_TWO_PI = 2 * math.pi


def _v3(p) -> tuple[float, float, float]:
    return (p.X(), p.Y(), p.Z())


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


class _FaceWriter:
    """Accumulates loose faces into the packed arrays of one BrepArray prim."""

    def __init__(self):
        self.prim: dict[str, Any] = {k: [] for k in BU.ATTR_TYPES}
        self.nfaces = 0
        self.lo = [math.inf] * 3
        self.hi = [-math.inf] * 3

    # -- vertices / edges ------------------------------------------------------
    def vertex(self, p) -> int:
        self.prim["brep:vertexPoint:point:position"].append(tuple(p))
        self.prim["vertex:pointType"].append("BrepPointAPI")
        for i in range(3):
            self.lo[i] = min(self.lo[i], p[i])
            self.hi[i] = max(self.hi[i], p[i])
        return len(self.prim["vertex:pointType"]) - 1

    def edge(self, bs, v0: int, v1: int) -> int:
        """Append a NURBS edge curve (Geom_BSplineCurve) and return the edge index."""
        P = self.prim
        n = bs.NbPoles()
        P["brep:edge3dNurb:curve3d:nurb:vertexCount"].append(n)
        P["brep:edge3dNurb:curve3d:nurb:order"].append(bs.Degree() + 1)
        for i in range(1, n + 1):
            P["brep:edge3dNurb:curve3d:nurb:controlVertices"].append(_v3(bs.Pole(i)))
            P["brep:edge3dNurb:curve3d:nurb:weights"].append(bs.Weight(i))
        for i in range(1, bs.NbKnots() + 1):
            P["brep:edge3dNurb:curve3d:nurb:knots"].extend([bs.Knot(i)] * bs.Multiplicity(i))
        P["edge:curveType"].append("BrepCurve3dNurbAPI")
        P["edge:range"].extend([bs.FirstParameter(), bs.LastParameter()])
        P["edge:vertexIndices"].append((v0, v1))
        return len(P["edge:curveType"]) - 1

    # -- faces -------------------------------------------------------------------
    def face(self, surf_kind: str, surf_data: dict, uv_range, loops: list[list[int]]) -> None:
        P = self.prim
        f = self.nfaces
        self.nfaces += 1
        api = {v: k for k, v in BU.SURFACE_APIS.items()}[surf_kind]
        P["face:surfaceType"].append(api)
        P["face:trimType"].append("general")
        P["face:range"].extend([uv_range[0], uv_range[1]])
        P["face:loopCount"].append(len(loops))
        for k, v in surf_data.items():
            if isinstance(v, list):
                P[f"brep:surface:{surf_kind}:{k}"].extend(v)
            else:
                P[f"brep:surface:{surf_kind}:{k}"].append(v)
        P["faceuse:faceIndex"].extend([f, f])
        P["faceuse:orientationType"].extend(["same", "opposite"])
        for loop in loops:
            P["loop:edgeuseCount"].append(len(loop))
            P["loop:vertexIndex"].append(9999999)
            for e in loop:
                i = len(P["edgeuse:edgeIndex"])
                P["edgeuse:edgeIndex"].append(e)
                P["edgeuse:orientationType"].append("same")
                P["edgeuse:nextRadialEUIndex"].append(i)  # a loose face: the edge has one use
                P["edgeuse:thisRadialEntryType"].append("topEntry")

    def finish(self) -> dict:
        P = self.prim
        P["brep:regionCount"] = [1]
        P["region:shellCount"] = [1]
        P["region:type"] = ["voidRegion"]
        P["shell:faceuseCount"] = [2 * self.nfaces]
        P["shell:wireEdgeCount"] = [0]
        P["shell:pointType"] = ["none"]
        diag = math.dist(self.lo, self.hi) if self.nfaces else 1.0
        P["brep:intersectTol3d"] = [max(1e-6, diag * 1e-7)]
        P["brep:extent"] = [tuple(self.lo), tuple(self.hi)]
        P["__name__"] = "Brep0"
        return {k: v for k, v in P.items() if v != [] or k.startswith("__")}


def _bspline_of_edge(edge, reverse: bool):
    from OCP.BRepLib import BRepLib

    if BRep_Tool.Curve_s(edge, 0.0, 0.0) is None:
        BRepLib.BuildCurves3d_s(edge)
    c, t0, t1 = BRep_Tool.Curve_s(edge, 0.0, 0.0), *BRep_Tool.Range_s(edge)
    bs = GeomConvert.CurveToBSplineCurve_s(Geom_TrimmedCurve(c, t0, t1))
    if bs.IsPeriodic():
        bs.SetNotPeriodic()
    if reverse:
        bs.Reverse()
    return bs


def _face_surface(face):
    """(kind, data, param function) for an OCCT face's surface, in BrepArray conventions.

    The param function maps a 3D point to the BrepArray (u, v) of the surface."""
    ad = BRepAdaptor_Surface(face, True)
    t = ad.GetType()

    def frame(ax3):
        o = _v3(ax3.Location())
        z = _v3(ax3.Direction())
        x = _v3(ax3.XDirection())
        y = _cross(z, x)
        return o, x, y, z

    if t == GeomAbs_Plane:
        o, x, y, z = frame(ad.Plane().Position())
        data = {"origin": o, "axis": z, "refDirection": x}
        return "plane", data, lambda p: (_dot(_sub(p, o), x), _dot(_sub(p, o), y))
    if t in (GeomAbs_Cylinder, GeomAbs_Cone):
        if t == GeomAbs_Cylinder:
            g = ad.Cylinder()
            r0, ang = g.Radius(), 0.0
        else:
            g = ad.Cone()
            r0, ang = g.RefRadius(), g.SemiAngle()
        o, x, y, z = frame(g.Position())
        data = {"origin": o, "axis": z, "refDirection": x, "radius": r0, "semiAngle": ang}

        def uv(p):
            w = _sub(p, o)
            return (math.atan2(_dot(w, y), _dot(w, x)), _dot(w, z))
        return "cone", data, uv
    if t == GeomAbs_Sphere:
        g = ad.Sphere()
        o, x, y, z = frame(g.Position())
        R = g.Radius()

        def uv(p):
            w = _sub(p, o)
            return (math.atan2(_dot(w, y), _dot(w, x)), math.asin(max(-1.0, min(1.0, _dot(w, z) / R))))
        return "sphere", {"center": o, "axis": z, "refDirection": x, "radius": R}, uv
    if t == GeomAbs_Torus:
        g = ad.Torus()
        o, x, y, z = frame(g.Position())
        R, r = g.MajorRadius(), g.MinorRadius()

        def uv(p):
            w = _sub(p, o)
            wx, wy, wz = _dot(w, x), _dot(w, y), _dot(w, z)
            return (math.atan2(wy, wx), math.atan2(wz, math.hypot(wx, wy) - R))
        return "torus", {"origin": o, "axis": z, "refDirection": x, "majorRadius": R, "minorRadius": r}, uv
    return None


def _nurbs_face_data(face):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert

    nf = TopoDS.Face_s(BRepBuilderAPI_NurbsConvert(face, True).Shape())
    s = BRep_Tool.Surface_s(nf)
    bs = GeomConvert.SurfaceToBSplineSurface_s(s)
    if bs.IsUPeriodic():
        bs.SetUNotPeriodic()
    if bs.IsVPeriodic():
        bs.SetVNotPeriodic()
    nu, nv = bs.NbUPoles(), bs.NbVPoles()
    cvs, ws = [], []
    for iu in range(1, nu + 1):
        for iv in range(1, nv + 1):
            cvs.append(_v3(bs.Pole(iu, iv)))
            ws.append(bs.Weight(iu, iv))
    uk, vk = [], []
    for i in range(1, bs.NbUKnots() + 1):
        uk.extend([bs.UKnot(i)] * bs.UMultiplicity(i))
    for i in range(1, bs.NbVKnots() + 1):
        vk.extend([bs.VKnot(i)] * bs.VMultiplicity(i))
    u0, u1, v0, v1 = bs.Bounds()
    data = {"controlVertices": cvs, "uVertexCount": nu, "vVertexCount": nv, "uOrder": bs.UDegree() + 1,
            "vOrder": bs.VDegree() + 1, "uKnots": uk, "vKnots": vk, "weights": ws}
    return nf, data, ((u0, v0), (u1, v1))


def _unwrap(vals: list[float]) -> list[float]:
    out = [vals[0]]
    for a in vals[1:]:
        while a - out[-1] > math.pi:
            a -= _TWO_PI
        while a - out[-1] < -math.pi:
            a += _TWO_PI
        out.append(a)
    return out


def _unwrap_from(vals: list[float]) -> list[float]:
    """Unwrap angles so each is within pi of the first (the face centre)."""
    ref = vals[0]
    out = []
    for a in vals:
        while a - ref > math.pi:
            a -= _TWO_PI
        while a - ref < -math.pi:
            a += _TWO_PI
        out.append(a)
    return out


def _rotate_ref(data: dict, angle: float) -> dict:
    z = data["axis"]
    x = data["refDirection"]
    y = _cross(z, x)
    c, sn = math.cos(angle), math.sin(angle)
    return dict(data, refDirection=tuple(c * x[i] + sn * y[i] for i in range(3)))


def _cone_canonical(data: dict, rng):
    """Flip the cone axis when the face lies on its negative side (BrepArray cones run along +v)."""
    (u0, v0), (u1, v1) = rng
    if v1 > 1e-12 or abs(data["semiAngle"]) < 1e-12 and v0 >= -1e-12:
        return data, rng
    z = tuple(-c for c in data["axis"])
    data = dict(data, axis=z, semiAngle=-data["semiAngle"])
    # the flipped frame mirrors u: u' = -u, then rotate so the range starts at 0 again
    data = _rotate_ref(data, -u1)
    return data, ((0.0, -v1), (u1 - u0, -v0))


def _cone_away_from_apex(data: dict, rng):
    """BrepArray cones need a positive radius at their origin: move the origin to the face's widest end."""
    ang = data["semiAngle"]
    if abs(ang) < 1e-12:
        return data, rng
    (u0, v0), (u1, v1) = rng
    r_at = lambda v: data["radius"] + v * math.tan(ang)  # noqa: E731
    h = v0 if r_at(v0) >= r_at(v1) else v1
    # never extend past the apex (negative radius)
    apex = -data["radius"] / math.tan(ang)
    eps = 1e-9 * max(1.0, abs(v1 - v0))
    # the kernel rejects a cone whose domain reaches the apex exactly: stop just short of it
    if r_at(v0) < eps * abs(math.tan(ang)) * 10:
        v0 = apex + math.copysign(eps, v1 - apex)
    if r_at(v1) < eps * abs(math.tan(ang)) * 10:
        v1 = apex + math.copysign(eps, v0 - apex)
    o, z = data["origin"], data["axis"]
    data = dict(data, origin=tuple(o[i] + z[i] * h for i in range(3)), radius=r_at(h))
    return data, ((u0, v0 - h), (u1, v1 - h))


def _add_occ_face(fw: _FaceWriter, face) -> None:
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.TopAbs import TopAbs_WIRE

    reversed_face = face.Orientation() == TopAbs_REVERSED
    analytic = _face_surface(face)
    if analytic is None:
        nf, data, rng = _nurbs_face_data(face)
        if nf.Orientation() != face.Orientation():
            nf = TopoDS.Face_s(nf.Oriented(face.Orientation()))
        face = nf
        kind = "nurb"
    else:
        kind, data, uvfun = analytic

    outer = BRepTools.OuterWire_s(face)
    wires = [outer]
    wexp = TopExp_Explorer(face, TopAbs_WIRE)
    while wexp.More():
        w = TopoDS.Wire_s(wexp.Current())
        if not w.IsSame(outer):
            wires.append(w)
        wexp.Next()

    samples: list[tuple[float, float, float]] = []
    loops: list[list[int]] = []
    for w in wires:
        seq = []  # (edge, reversed-in-traversal)
        it = BRepTools_WireExplorer(w, face)
        while it.More():
            e = it.Current()
            if not BRep_Tool.Degenerated_s(e):
                seq.append((e, it.Orientation() == TopAbs_REVERSED))
            it.Next()
        if not seq:
            continue
        # BrepArray loops run counter-clockwise about the surface normal; OCCT wires do so about the
        # face normal, which is flipped on a reversed face
        if reversed_face:
            seq = [(e, not r) for e, r in reversed(seq)]
        curves = [_bspline_of_edge(e, r) for e, r in seq]
        # loop vertices: end of each curve is the start of the next
        vids = [fw.vertex(_v3(c.StartPoint())) for c in curves]
        loop = []
        for k, c in enumerate(curves):
            loop.append(fw.edge(c, vids[k], vids[(k + 1) % len(curves)]))
            ca = BRepAdaptor_Curve(seq[k][0])
            for j in range(9):
                t = ca.FirstParameter() + (ca.LastParameter() - ca.FirstParameter()) * j / 8
                samples.append(_v3(ca.Value(t)))
        loops.append(loop)
    if not loops:
        return

    if kind != "nurb":
        # sample the face's OCCT parameter rectangle too: boundary curves alone cannot tell which
        # half of a split sphere/cylinder a face covers
        ad = BRepAdaptor_Surface(face, True)
        u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
        grid = []
        for i in range(7):
            for j in range(7):
                grid.append(_v3(ad.Value(u0 + (u1 - u0) * i / 6, v0 + (v1 - v0) * j / 6)))
        pts = [grid[24]] + grid + samples  # start unwrapping from the face centre
        uvs = [uvfun(p) for p in pts]
        vs = [q[1] for q in uvs]
        if kind in ("cone", "sphere"):
            # the angle is undefined on the axis (cone apex, sphere poles): ignore those points for u
            o = data.get("origin", data.get("center"))
            z = data["axis"]
            scale = max(math.dist(p, o) for p in pts) or 1.0

            def radial(p):
                w = _sub(p, o)
                return math.sqrt(max(0.0, _dot(w, w) - _dot(w, z) ** 2))
            keep = [i for i, p in enumerate(pts) if radial(p) > 1e-6 * scale]
            if keep and keep[0] != 0:
                keep.insert(0, keep[0])
            us = [uvs[i][0] for i in keep] or [0.0]
        else:
            us = [q[0] for q in uvs]
        if kind in ("cone", "sphere", "torus"):
            us = _unwrap_from(us)
            shift = math.floor(min(us) / _TWO_PI) * _TWO_PI
            us = [u - shift for u in us]
        if kind == "torus":
            vs = _unwrap_from(vs)
            shift = math.floor(min(vs) / _TWO_PI) * _TWO_PI
            vs = [v - shift for v in vs]
        umin, umax, vmin, vmax = min(us), max(us), min(vs), max(vs)
        if kind == "plane":  # an unbounded plane: leave a small margin around the trim
            pad = 1e-6 * max(1.0, umax - umin, vmax - vmin)
            umin, umax, vmin, vmax = umin - pad, umax + pad, vmin - pad, vmax + pad
        else:  # keep within the natural (periodic / polar) domain
            if umax - umin > _TWO_PI - 1e-6:
                umin, umax = 0.0, _TWO_PI
            elif umin > 1e-9:
                # rotate the reference direction so the face's angular range starts at 0
                data = _rotate_ref(data, umin)
                umin, umax = 0.0, umax - umin
            if kind == "sphere":
                vmin, vmax = max(-math.pi / 2, vmin), min(math.pi / 2, vmax)
            if kind == "torus":
                vmin, vmax = max(0.0, vmin), min(_TWO_PI, vmax)
        rng = ((umin, vmin), (umax, vmax))
        if kind == "cone":
            data, rng = _cone_canonical(data, rng)
            data, rng = _cone_away_from_apex(data, rng)
    fw.face(kind, data, rng, loops)


def occ_to_breps(shape) -> list:
    """Convert an OCCT shape into SMLib Breps (one per solid, or one for loose faces)."""
    import usd_brep as sm

    div = ShapeUpgrade_ShapeDivideClosed(shape)
    div.SetNbSplitPoints(1)
    div.Perform()
    shape = div.Result()

    groups = []
    sexp = TopExp_Explorer(shape, TopAbs_SOLID)
    while sexp.More():
        groups.append(sexp.Current())
        sexp.Next()
    if not groups:
        groups = [shape]

    out = []
    for g in groups:
        fw = _FaceWriter()
        fexp = TopExp_Explorer(g, TopAbs_FACE)
        while fexp.More():
            _add_occ_face(fw, TopoDS.Face_s(fexp.Current()))
            fexp.Next()
        if not fw.nfaces:
            continue
        prim = fw.finish()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "import.usda")
            with open(path, "w") as fh:
                fh.write(BU.write([prim]))
            breps = sm.usd.import_breps(path, heal=True)
        for b in breps:
            tol = max(1e-5, prim["brep:intersectTol3d"][0] * 100)
            try:
                sm.stitch_advanced(b, tol)
            except RuntimeError:
                sm.stitch_brep(b)
            out.append(b)
    return out


def import_step(path: str) -> list:
    require()
    with _quiet():
        r = STEPControl_Reader()
        if r.ReadFile(path) != IFSelect_RetDone:
            raise StepError("could not read the STEP file")
        r.TransferRoots()
        shape = r.OneShape()
    if shape is None or shape.IsNull():
        raise StepError("the STEP file contains no shapes")
    breps = occ_to_breps(shape)
    if not breps:
        raise StepError("the STEP file contains no faces")
    return breps
