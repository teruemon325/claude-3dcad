import base64
import math

import pytest

from cad3d import kernel as K
from cad3d.document import Document


def bodies(doc):
    return doc.result().bodies


def vol(doc, bid):
    return doc.body(bid).brep.volume()


def test_primitive_and_param_edit():
    d = Document()
    f = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    assert vol(d, f["id"]) == pytest.approx(1000, rel=1e-6)
    d.update_feature(f["id"], {"height": 5})
    assert vol(d, f["id"]) == pytest.approx(500, rel=1e-6)


def test_boolean_consumes_tool_and_undo_redo():
    d = Document()
    a = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    c = d.add_feature("cylinder", {"origin": [5, 5, -1], "radius": 2, "height": 12})
    d.add_feature("boolean", {"op": "difference", "target": a["id"], "tool": c["id"]})
    assert list(bodies(d)) == [a["id"]]
    assert vol(d, a["id"]) == pytest.approx(1000 - math.pi * 4 * 10, rel=1e-3)
    d.undo()
    assert len(bodies(d)) == 2
    d.redo()
    assert len(bodies(d)) == 1


def test_extrude_modes_and_planes():
    d = Document()
    base = d.add_feature("extrude", {"profile": {"type": "rectangle", "width": 20, "height": 10}, "distance": 5})
    assert vol(d, base["id"]) == pytest.approx(1000, rel=1e-6)
    d.add_feature("extrude", {"profile": {"type": "circle", "radius": 2}, "distance": 5,
                              "mode": "cut", "target": base["id"]})
    assert vol(d, base["id"]) == pytest.approx(1000 - math.pi * 4 * 5, rel=2e-3)
    for plane, axis in (("XZ", 1), ("YZ", 0)):
        f = d.add_feature("extrude", {"plane": plane, "offset": 100,
                                      "profile": {"type": "rectangle", "width": 2, "height": 2}, "distance": 3})
        lo, hi = d.body(f["id"]).brep.bounding_box()
        sign = -1 if plane == "XZ" else 1
        assert sorted((lo[axis], hi[axis])) == pytest.approx(sorted((sign * 100, sign * 103)), abs=1e-3)


def test_revolve():
    d = Document()
    f = d.add_feature("revolve", {"points": [[5, 0], [10, 0], [10, 5], [5, 5]], "angle": 360})
    assert vol(d, f["id"]) == pytest.approx(math.pi * (100 - 25) * 5, rel=1e-3)


def test_fillet_reference_survives_upstream_edit():
    d = Document()
    b = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    ref = K.pick_edge(d.body(b["id"]).brep, 0)
    fl = d.add_feature("fillet", {"target": b["id"], "edges": [ref], "radius": 1})
    assert d.result().status[fl["id"]]["state"] == "ok"
    v1 = vol(d, b["id"])
    assert v1 < 1000
    # grow the box in a direction that keeps the edge in place
    d.update_feature(b["id"], {"width": 12})
    assert d.result().status[fl["id"]]["state"] == "ok"
    # move the edge: the bounding-box-normalized fallback still finds it
    d.update_feature(b["id"], {"height": 15})
    assert d.result().status[fl["id"]]["state"] == "ok"
    assert vol(d, b["id"]) < 10 * 12 * 15


def test_legacy_point_refs_still_resolve():
    d = Document()
    b = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    fl = d.add_feature("chamfer", {"target": b["id"], "edges": [[10, 5, 10]], "radius": 1})
    assert d.result().status[fl["id"]]["state"] == "ok"


def test_failing_feature_reports_error_and_keeps_going():
    d = Document()
    b = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    bad = d.add_feature("fillet", {"target": b["id"], "edges": [[50, 50, 50]], "radius": 1})
    after = d.add_feature("sphere", {"origin": [30, 0, 0], "radius": 2})
    st = d.result().status
    assert st[bad["id"]]["state"] == "error"
    assert st[after["id"]]["state"] == "ok"
    assert vol(d, b["id"]) == pytest.approx(1000, rel=1e-6)


def test_rollback_and_suppress():
    d = Document()
    b = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    s = d.add_feature("sphere", {"origin": [30, 0, 0], "radius": 2})
    d.set_rollback(1)
    assert list(bodies(d)) == [b["id"]]
    assert d.result().status[s["id"]]["state"] == "rolledback"
    d.set_rollback(None)
    d.update_feature(b["id"], suppressed=True)
    assert list(bodies(d)) == [s["id"]]


def test_shell_mirror_patterns_transform():
    d = Document()
    b = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    _, top = K.pick_face(d.body(b["id"]).brep, (5, 5, 10))
    d.add_feature("shell", {"target": b["id"], "faces": [top], "thickness": 1})
    assert vol(d, b["id"]) == pytest.approx(1000 - 8 * 8 * 9, rel=1e-3)

    c = d.add_feature("cylinder", {"origin": [20, 0, 0], "radius": 1, "height": 2})
    d.add_feature("pattern_circular", {"target": c["id"], "count": 4, "angle": 360})
    assert vol(d, c["id"]) == pytest.approx(4 * math.pi * 2, rel=2e-3)

    s = d.add_feature("sphere", {"origin": [0, 50, 0], "radius": 1})
    d.add_feature("pattern_linear", {"target": s["id"], "direction": [1, 0, 0], "spacing": 5, "count": 3})
    assert vol(d, s["id"]) == pytest.approx(3 * 4 / 3 * math.pi, rel=2e-3)

    m = d.add_feature("box", {"origin": [100, 0, 0], "length": 1, "width": 1, "height": 1})
    d.add_feature("mirror", {"target": m["id"], "plane": "YZ", "offset": 0, "merge": False})
    assert len([x for x in bodies(d)]) == 5

    t = d.add_feature("transform", {"target": m["id"], "translate": [0, 0, 10], "copy": True})
    lo, _ = d.body(t["id"]).brep.bounding_box()
    assert lo[2] == pytest.approx(10, abs=1e-3)


def test_project_roundtrip_and_mesh(tmp_path):
    d = Document()
    b = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    m = d.mesh(b["id"])
    assert len(m["positions"]) % 9 == 0 and len(m["edges"]) == 12
    proj = d.to_project()
    d2 = Document()
    d2.load_project(proj)
    assert vol(d2, b["id"]) == pytest.approx(1000, rel=1e-6)

    # USD round trip through the import feature
    path = tmp_path / "box.usda"
    K.export_usd([d.body(b["id"]).brep], str(path))
    d3 = Document()
    f = d3.add_feature("import_usd", {"filename": "box.usda", "data": base64.b64encode(path.read_bytes()).decode()})
    assert vol(d3, f["id"]) == pytest.approx(1000, rel=1e-6)
    assert K.write_stl([d.body(b["id"]).brep]).startswith("solid")


def test_offset_and_invalid_results_are_errors():
    d = Document()
    b = d.add_feature("box", {"length": 10, "width": 10, "height": 10})
    d.add_feature("offset", {"target": b["id"], "distance": 1})
    assert vol(d, b["id"]) > 1000
    a = d.add_feature("box", {"origin": [100, 0, 0], "length": 1, "width": 1, "height": 1})
    c = d.add_feature("box", {"origin": [200, 0, 0], "length": 1, "width": 1, "height": 1})
    bad = d.add_feature("boolean", {"op": "intersection", "target": a["id"], "tool": c["id"]})
    assert d.result().status[bad["id"]]["state"] == "error"
