import math

import pytest

from cad3d import kernel as K
from cad3d.document import Document
from cad3d.sketch import Sketch, describe, find_regions


def pts(**kw):
    return [{"id": k, "x": v[0], "y": v[1]} for k, v in kw.items()]


def line(i, a, b, construction=False):
    return {"id": i, "type": "line", "p1": a, "p2": b, "construction": construction}


def rect_sketch(w=20, h=10, plane=None, hole_r=None):
    s = {
        "points": pts(o=(0, 0), b=(w, 0), c=(w, h), d=(0, h), m=(w / 2, h / 2)),
        "entities": [line("l1", "o", "b"), line("l2", "b", "c"), line("l3", "c", "d"), line("l4", "d", "o")],
        "constraints": [],
    }
    if plane:
        s["plane"] = plane
    if hole_r:
        s["entities"].append({"id": "h", "type": "circle", "c": "m", "r": hole_r})
    return s


def test_regions_nesting_and_construction_ignored():
    s = rect_sketch(hole_r=2)
    s["entities"].append(line("cl", "o", "c", construction=True))
    regions = find_regions(Sketch.from_params(s))
    assert [r.depth for r in regions] == [0, 1]
    assert regions[0].area == pytest.approx(200 - math.pi * 4, rel=1e-3)
    d = describe(s)
    assert len(d["regions"]) == 2 and len(d["curves"]) == 6 and d["error"] is None


def test_sketch_extrude_hole_and_edit_propagates():
    d = Document()
    sk = d.add_feature("sketch", rect_sketch(hole_r=2))
    ex = d.add_feature("extrude", {"sketch": sk["id"], "distance": 5})
    assert d.result().status[ex["id"]]["state"] == "ok"
    assert d.body(ex["id"]).brep.volume() == pytest.approx((200 - math.pi * 4) * 5, rel=2e-3)
    # pick only the circle region
    d.update_feature(ex["id"], {"profiles": [[10, 5]]})
    assert d.body(ex["id"]).brep.volume() == pytest.approx(math.pi * 4 * 5, rel=2e-3)
    # editing the sketch (a dimension change) updates the downstream extrude
    s2 = rect_sketch(hole_r=3)
    d.update_feature(sk["id"], s2)
    assert d.body(ex["id"]).brep.volume() == pytest.approx(math.pi * 9 * 5, rel=2e-3)


def test_cut_through_all_on_face_sketch():
    d = Document()
    b = d.add_feature("box", {"length": 20, "width": 20, "height": 10})
    plane = K.plane_from_face(d.body(b["id"]).brep, (10, 10, 10))
    s = {"plane": plane, "points": pts(o=(0, 0), m=(10, 10)),
         "entities": [{"id": "c", "type": "circle", "c": "m", "r": 3}], "constraints": []}
    sk = d.add_feature("sketch", s)
    cut = d.add_feature("extrude", {"sketch": sk["id"], "extent": "through", "mode": "cut", "target": b["id"]})
    assert d.result().status[cut["id"]]["state"] == "ok"
    assert d.body(b["id"]).brep.volume() == pytest.approx(4000 - math.pi * 9 * 10, rel=2e-3)
    st = d.state()
    assert st["sketches"][0]["visible"] is False  # consumed sketches are hidden


def test_revolve_about_sketch_line_and_axis_crossing_error():
    d = Document()
    s = {
        "plane": {"origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 0, 1]},
        "points": pts(o=(0, 0), t=(0, 10), a=(4, 0), b=(8, 0), c=(8, 6), e=(4, 6)),
        "entities": [line("ax", "o", "t", construction=True), line("1", "a", "b"), line("2", "b", "c"),
                     line("3", "c", "e"), line("4", "e", "a")],
        "constraints": [],
    }
    sk = d.add_feature("sketch", s)
    rv = d.add_feature("revolve", {"sketch": sk["id"], "axis": "ax", "angle": 360})
    assert d.result().status[rv["id"]]["state"] == "ok"
    assert d.body(rv["id"]).brep.volume() == pytest.approx(math.pi * (64 - 16) * 6, rel=2e-3)
    bad = d.add_feature("revolve", {"sketch": sk["id"], "axis": "X", "angle": 360})
    assert d.result().status[bad["id"]]["state"] == "ok"  # profile is above the X axis
    s2 = dict(s, points=pts(o=(0, 0), t=(0, 10), a=(-4, 0), b=(8, 0), c=(8, 6), e=(-4, 6)))
    d.update_feature(sk["id"], s2)
    assert d.result().status[rv["id"]]["state"] == "error"


def test_preview_does_not_commit():
    d = Document()
    sk = d.add_feature("sketch", rect_sketch())
    n = len(d.features)
    pv = d.preview("extrude", {"sketch": sk["id"], "distance": 3, "extent": "distance", "profiles": [],
                               "mode": "new", "target": None, "flip": True})
    assert pv["status"]["state"] == "ok" and len(pv["bodies"]) == 1
    assert len(d.features) == n and not d.result().bodies
    pts_z = pv["bodies"][0]["mesh"]["positions"][2::3]
    assert min(pts_z) == pytest.approx(-3, abs=1e-3)
    bad = d.preview("extrude", {"sketch": None, "distance": 3})
    assert bad["status"]["state"] == "error"
