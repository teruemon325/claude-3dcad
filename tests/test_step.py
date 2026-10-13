import math

import pytest

step = pytest.importorskip("cad3d.step")
if not step.AVAILABLE:  # pragma: no cover
    pytest.skip("OpenCASCADE (cadquery-ocp) is not installed", allow_module_level=True)

import usd_brep as sm  # noqa: E402

from cad3d.document import Document  # noqa: E402


def exact_volume(brep) -> float:
    return step.occ_volume(step.breps_to_occ([brep])[0])


@pytest.mark.parametrize(
    "make, expected",
    [
        (lambda: sm.create_box((0, 0, 0), 10, 20, 30), 6000.0),
        (lambda: sm.create_cylinder((1, 2, 3), 3, 5), math.pi * 9 * 5),
        (lambda: sm.create_cone((0, 0, 0), 5, 0, 8), math.pi * 25 * 8 / 3),
        (lambda: sm.create_sphere((1, 1, 1), 5), 4 / 3 * math.pi * 125),
        (lambda: sm.create_torus((0, 0, 0), 10, 2), 2 * math.pi ** 2 * 10 * 4),
    ],
)
def test_export_is_exact(make, expected):
    assert exact_volume(make()) == pytest.approx(expected, rel=1e-9)


@pytest.mark.parametrize("name", ["hole", "fillet", "sphere", "cone"])
def test_step_round_trip(tmp_path, name):
    if name == "hole":
        b = sm.boolean_difference(sm.create_box((0, 0, 0), 10, 10, 10), sm.create_cylinder((5, 5, -1), 2, 12))
    elif name == "fillet":
        b = sm.create_box((0, 0, 0), 10, 10, 10)
        b = sm.fillet_edges(b, b.edges()[:3], radius=2)
    elif name == "sphere":
        b = sm.create_sphere((0, 0, 0), 5)
    else:
        b = sm.create_cone((0, 0, 0), 5, 2, 8)
    before = exact_volume(b)
    path = str(tmp_path / f"{name}.step")
    step.export_step([b], path)
    assert open(path).read().startswith("ISO-10303-21")
    (back,) = step.import_step(path)
    assert back.is_manifold_solid()
    assert exact_volume(back) == pytest.approx(before, rel=1e-9)


def test_import_foreign_step(tmp_path):
    """A STEP written by OpenCASCADE itself (fillets on every edge, two bodies)."""
    from OCP.BRep import BRep_Builder
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeSphere
    from OCP.gp import gp_Pnt
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS, TopoDS_Compound

    box = BRepPrimAPI_MakeBox(20, 20, 10).Shape()
    fil = BRepFilletAPI_MakeFillet(box)
    e = TopExp_Explorer(box, TopAbs_EDGE)
    while e.More():
        fil.Add(3.0, TopoDS.Edge_s(e.Current()))
        e.Next()
    comp = TopoDS_Compound()
    bb = BRep_Builder()
    bb.MakeCompound(comp)
    bb.Add(comp, fil.Shape())
    bb.Add(comp, BRepPrimAPI_MakeSphere(gp_Pnt(40, 0, 0), 3).Shape())
    expected = step.occ_volume(comp)
    path = str(tmp_path / "foreign.step")
    with step._quiet():
        w = STEPControl_Writer()
        w.Transfer(comp, STEPControl_AsIs)
        w.Write(path)
    breps = step.import_step(path)
    assert len(breps) == 2 and all(b.is_manifold_solid() for b in breps)
    assert sum(exact_volume(b) for b in breps) == pytest.approx(expected, rel=1e-9)


def test_document_step_import_and_server_export(tmp_path):
    import base64

    from fastapi.testclient import TestClient

    from cad3d.server import create_app

    b = sm.create_cylinder((0, 0, 0), 4, 6)
    path = tmp_path / "c.step"
    step.export_step([b], str(path))
    d = Document()
    f = d.add_feature("import_usd", {"filename": "c.step", "data": base64.b64encode(path.read_bytes()).decode()})
    assert d.result().status[f["id"]]["state"] == "ok"
    assert exact_volume(d.body(f["id"]).brep) == pytest.approx(math.pi * 16 * 6, rel=1e-9)

    c = TestClient(create_app(d))
    r = c.get("/api/export/step")
    assert r.status_code == 200 and r.text.startswith("ISO-10303-21")
    up = c.post("/api/import", files={"file": ("again.step", r.content, "application/octet-stream")})
    assert up.status_code == 200 and len(up.json()["bodies"]) == 2
