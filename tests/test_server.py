from fastapi.testclient import TestClient

from cad3d.server import create_app


def test_api_flow():
    c = TestClient(create_app())
    r = c.post("/api/features", json={"type": "box", "params": {"length": 10, "width": 10, "height": 10}})
    assert r.status_code == 200
    bid = r.json()["added"]
    m = c.get(f"/api/bodies/{bid}/mesh").json()
    assert m["positions"] and len(m["positions"]) == len(m["normals"])
    ref = c.post("/api/pick/edge", json={"body": bid, "edge": 0}).json()["ref"]
    r = c.post("/api/features", json={"type": "fillet", "params": {"target": bid, "edges": [ref], "radius": 1}})
    fid = r.json()["added"]
    assert r.json()["status"][fid]["state"] == "ok"
    props = c.get(f"/api/bodies/{bid}/properties").json()
    assert props["volume"] < 1000
    face = c.post("/api/pick/face", json={"body": bid, "point": [5, 5, 10]}).json()
    assert len(face["ref"]["p"]) == 3 and len(face["ref"]["n"]) == 3
    assert c.get("/api/export/stl").text.startswith("solid")
    assert "BrepArray" in c.get("/api/export/usda").text
    proj = c.get("/api/project").json()
    assert c.post("/api/new").json()["features"] == []
    assert len(c.post("/api/project", json=proj).json()["features"]) == 2
    assert c.post("/api/features", json={"type": "nope"}).status_code == 400
    assert c.get("/").status_code == 200
