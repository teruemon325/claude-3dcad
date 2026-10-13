"""Read and write the USD ``BrepArray`` prim as plain Python data.

``usd_brep`` stores exact BRep geometry (analytic and NURBS surfaces, NURBS edge
curves, radial-edge topology) in a ``BrepArray`` prim. This module converts
between the ``.usda`` text of such a prim and a dict of attribute arrays, without
needing an OpenUSD Python installation. It is the bridge used by the STEP
translator (:mod:`cad3d.step`).

Only the subset written by ``usd_brep.usd.export_brep(s)`` is supported: one
``BrepArray`` prim per BRep under ``/World``, attributes of the form
``uniform <type>[] <name> = [...]``.
"""

from __future__ import annotations

import re
from typing import Any

_ATTR = re.compile(r"^\s*uniform\s+([\w\d]+)\[\]\s+([\w:]+)\s*=\s*\[(.*)\]\s*$")
_PRIM = re.compile(r'^\s*def\s+BrepArray\s+"([^"]+)"')
_TUPLE = re.compile(r"\(([^()]*)\)")
_STR = re.compile(r'"([^"]*)"')

TUPLE_TYPES = {"point3d": 3, "vector3d": 3, "double3": 3, "float3": 3, "double2": 2, "int2": 2}
INT_TYPES = {"uint", "int"}


def _parse_values(typ: str, body: str) -> list:
    body = body.strip()
    if not body:
        return []
    if typ in TUPLE_TYPES:
        conv = int if typ == "int2" else float
        return [tuple(conv(x) for x in m.split(",")) for m in _TUPLE.findall(body)]
    if typ == "token" or typ == "string":
        return _STR.findall(body)
    if typ in INT_TYPES:
        return [int(x) for x in body.split(",")]
    return [float(x) for x in body.split(",")]


def parse(text: str) -> list[dict[str, Any]]:
    """All ``BrepArray`` prims in a usda layer, as {attribute name: list}."""
    prims: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for line in text.splitlines():
        m = _PRIM.match(line)
        if m:
            cur = {"__name__": m.group(1)}
            prims.append(cur)
            continue
        if cur is None:
            continue
        m = _ATTR.match(line)
        if m:
            typ, name, body = m.groups()
            cur[name] = _parse_values(typ, body)
    return prims


# --------------------------------------------------------------------- writing

ATTR_TYPES: dict[str, str] = {
    "brep:intersectTol3d": "double",
    "brep:extent": "double3",
    "brep:regionCount": "uint",
    "region:shellCount": "uint",
    "region:type": "token",
    "shell:faceuseCount": "uint",
    "shell:wireEdgeCount": "uint",
    "shell:pointType": "token",
    "faceuse:faceIndex": "uint",
    "faceuse:orientationType": "token",
    "face:loopCount": "uint",
    "face:surfaceType": "token",
    "face:trimType": "token",
    "face:range": "double2",
    "loop:edgeuseCount": "uint",
    "loop:vertexIndex": "uint",
    "edgeuse:edgeIndex": "uint",
    "edgeuse:orientationType": "token",
    "edgeuse:nextRadialEUIndex": "uint",
    "edgeuse:thisRadialEntryType": "token",
    "edge:curveType": "token",
    "edge:range": "double",
    "edge:vertexIndices": "int2",
    "wireEdge:curveType": "token",
    "wireEdge:range": "double",
    "wireEdge:vertexIndices": "int2",
    "vertex:pointType": "token",
    "brep:vertexPoint:point:position": "point3d",
    "brep:edge3dNurb:curve3d:nurb:controlVertices": "point3d",
    "brep:edge3dNurb:curve3d:nurb:vertexCount": "uint",
    "brep:edge3dNurb:curve3d:nurb:order": "uint",
    "brep:edge3dNurb:curve3d:nurb:knots": "double",
    "brep:edge3dNurb:curve3d:nurb:weights": "double",
    "brep:surface:plane:origin": "point3d",
    "brep:surface:plane:axis": "vector3d",
    "brep:surface:plane:refDirection": "vector3d",
    "brep:surface:cylinder:origin": "point3d",
    "brep:surface:cylinder:axis": "vector3d",
    "brep:surface:cylinder:refDirection": "vector3d",
    "brep:surface:cylinder:radius": "double",
    "brep:surface:cone:origin": "point3d",
    "brep:surface:cone:axis": "vector3d",
    "brep:surface:cone:refDirection": "vector3d",
    "brep:surface:cone:radius": "double",
    "brep:surface:cone:semiAngle": "double",
    "brep:surface:sphere:center": "point3d",
    "brep:surface:sphere:axis": "vector3d",
    "brep:surface:sphere:refDirection": "vector3d",
    "brep:surface:sphere:radius": "double",
    "brep:surface:torus:origin": "point3d",
    "brep:surface:torus:axis": "vector3d",
    "brep:surface:torus:refDirection": "vector3d",
    "brep:surface:torus:majorRadius": "double",
    "brep:surface:torus:minorRadius": "double",
    "brep:surface:nurb:controlVertices": "point3d",
    "brep:surface:nurb:uVertexCount": "uint",
    "brep:surface:nurb:vVertexCount": "uint",
    "brep:surface:nurb:uOrder": "uint",
    "brep:surface:nurb:vOrder": "uint",
    "brep:surface:nurb:uKnots": "double",
    "brep:surface:nurb:vKnots": "double",
    "brep:surface:nurb:weights": "double",
}

SURFACE_APIS = {
    "BrepSurfacePlaneAPI": "plane",
    "BrepSurfaceCylinderAPI": "cylinder",
    "BrepSurfaceConeAPI": "cone",
    "BrepSurfaceSphereAPI": "sphere",
    "BrepSurfaceTorusAPI": "torus",
    "BrepSurfaceNurbAPI": "nurb",
}


def _fmt(v: Any, typ: str) -> str:
    if typ == "token":
        return f'"{v}"'
    if isinstance(v, tuple):
        return "(" + ", ".join(_num(x) for x in v) + ")"
    if typ in INT_TYPES:
        return str(int(v))
    return _num(v)


def _num(x: float) -> str:
    if isinstance(x, int):
        return str(x)
    r = repr(float(x))
    return r[:-2] if r.endswith(".0") else r


def write(prims: list[dict[str, Any]]) -> str:
    """usda text for one or more BrepArray prims (dicts as returned by :func:`parse`)."""
    out = ["#usda 1.0", "", 'def Xform "World"', "{"]
    for i, prim in enumerate(prims):
        name = prim.get("__name__", f"Brep{i}")
        apis = ['"BrepPointAPI:vertexPoint"']
        if prim.get("brep:edge3dNurb:curve3d:nurb:order"):
            apis.append('"BrepCurve3dNurbAPI:edge3dNurb"')
        used = []
        for t in prim.get("face:surfaceType", []):
            if t not in used:
                used.append(t)
        apis += [f'"{t}"' for t in used]
        out.append(f'    def BrepArray "{name}" (')
        out.append(f"        prepend apiSchemas = [{', '.join(apis)}]")
        out.append("    )")
        out.append("    {")
        for key in sorted(k for k in prim if not k.startswith("__")):
            typ = ATTR_TYPES.get(key)
            if typ is None:
                continue
            vals = ", ".join(_fmt(v, typ) for v in prim[key])
            out.append(f"        uniform {typ}[] {key} = [{vals}]")
        ext = prim.get("brep:extent")
        if ext:
            out.append(f"        uniform float3[] extent = [{_fmt(tuple(ext[0]), 'float3')}, {_fmt(tuple(ext[1]), 'float3')}]")
        out.append("    }")
    out.append("}")
    return "\n".join(out) + "\n"
