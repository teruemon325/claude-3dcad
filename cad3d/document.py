"""Parametric feature-history document.

A document is an ordered list of *features*. Regenerating the document replays
the features in order against a set of named bodies. Every feature is plain JSON
so documents can be saved, loaded, undone and redone trivially.

Topological references (edges for fillets, faces for shells) are stored as a
point lying on the referenced entity plus that point normalized to the body's
bounding box, and are re-resolved on every regeneration by finding the closest
entity. That keeps references valid when upstream parameters move or resize the
referenced entity, as long as it still exists.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import tempfile
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

from . import kernel as K

PALETTE = ["#8fb4d9", "#d9a58f", "#9fd98f", "#d98fc8", "#d9d18f", "#8fd9cf", "#b39fd9", "#c0c0c0"]

PRIMITIVES = ("box", "cylinder", "sphere", "cone", "torus", "pyramid")
SKETCH_FEATURES = ("extrude", "revolve")
MODIFY_FEATURES = ("fillet", "chamfer", "shell", "offset", "transform", "mirror", "pattern_linear", "pattern_circular")
FEATURE_TYPES = PRIMITIVES + SKETCH_FEATURES + MODIFY_FEATURES + ("boolean", "delete_body", "import_usd")

TYPE_LABELS = {
    "box": "Box",
    "cylinder": "Cylinder",
    "sphere": "Sphere",
    "cone": "Cone",
    "torus": "Torus",
    "pyramid": "Pyramid",
    "extrude": "Extrude",
    "revolve": "Revolve",
    "fillet": "Fillet",
    "chamfer": "Chamfer",
    "shell": "Shell",
    "offset": "Offset",
    "transform": "Move",
    "mirror": "Mirror",
    "pattern_linear": "LinearPattern",
    "pattern_circular": "CircularPattern",
    "boolean": "Combine",
    "delete_body": "DeleteBody",
    "import_usd": "Import",
}

DEFAULT_PARAMS: dict[str, dict[str, Any]] = {
    "box": {"origin": [0, 0, 0], "length": 20, "width": 20, "height": 20},
    "cylinder": {"origin": [0, 0, 0], "radius": 10, "height": 20},
    "sphere": {"origin": [0, 0, 0], "radius": 10},
    "cone": {"origin": [0, 0, 0], "radius_base": 10, "radius_top": 0, "height": 20},
    "torus": {"origin": [0, 0, 0], "radius_major": 15, "radius_minor": 4},
    "pyramid": {"origin": [0, 0, 0], "length": 20, "height": 20},
    "extrude": {
        "plane": "XY",
        "offset": 0,
        "profile": {"type": "rectangle", "cx": 0, "cy": 0, "width": 20, "height": 10},
        "distance": 10,
        "symmetric": False,
        "mode": "new",
        "target": None,
    },
    "revolve": {
        "points": [[5, 0], [10, 0], [10, 5], [5, 10]],
        "angle": 360,
        "mode": "new",
        "target": None,
    },
    "fillet": {"target": None, "edges": [], "radius": 2},
    "chamfer": {"target": None, "edges": [], "radius": 2},
    "shell": {"target": None, "faces": [], "thickness": 1},
    "offset": {"target": None, "distance": 1},
    "transform": {
        "target": None,
        "translate": [0, 0, 0],
        "rotate_axis": [0, 0, 1],
        "rotate_deg": 0,
        "pivot": [0, 0, 0],
        "scale": 1,
        "copy": False,
    },
    "mirror": {"target": None, "plane": "YZ", "offset": 0, "merge": True},
    "pattern_linear": {"target": None, "direction": [1, 0, 0], "spacing": 30, "count": 3},
    "pattern_circular": {"target": None, "axis": [0, 0, 1], "center": [0, 0, 0], "count": 6, "angle": 360},
    "boolean": {"op": "union", "target": None, "tool": None, "keep_tool": False},
    "delete_body": {"target": None},
    "import_usd": {"filename": "", "data": ""},
}


class FeatureError(RuntimeError):
    pass


@dataclass
class Body:
    id: str
    name: str
    brep: Any
    sig: str
    source: str  # id of the feature that created it

    def touched(self, feature: dict) -> str:
        """Advance the body's history signature after ``feature`` modifies it."""
        h = hashlib.sha1()
        h.update(self.sig.encode())
        h.update(_feature_sig(feature).encode())
        return h.hexdigest()


def _feature_sig(feature: dict) -> str:
    return json.dumps({"type": feature["type"], "params": feature["params"]}, sort_keys=True)


@dataclass
class RegenResult:
    bodies: "OrderedDict[str, Body]"
    status: dict[str, dict] = field(default_factory=dict)


class BrepCache:
    """LRU cache of kernel results keyed by history signature (results are treated as immutable)."""

    def __init__(self, size: int = 256):
        self.size = size
        self._d: OrderedDict[str, Any] = OrderedDict()

    def get(self, key: str):
        v = self._d.get(key)
        if v is not None:
            self._d.move_to_end(key)
        return v

    def put(self, key: str, value: Any) -> None:
        self._d[key] = value
        self._d.move_to_end(key)
        while len(self._d) > self.size:
            self._d.popitem(last=False)


class Document:
    def __init__(self) -> None:
        self.name = "Untitled"
        self.features: list[dict] = []
        self.rollback: int | None = None  # number of active features; None = all
        self.body_meta: dict[str, dict] = {}
        self._undo: list[str] = []
        self._redo: list[str] = []
        self._cache = BrepCache()
        self._mesh_cache: OrderedDict[str, dict] = OrderedDict()
        self._result: RegenResult | None = None

    # ------------------------------------------------------------------ state

    def snapshot(self) -> str:
        return json.dumps(
            {"name": self.name, "features": self.features, "rollback": self.rollback, "body_meta": self.body_meta}
        )

    def restore(self, snap: str) -> None:
        d = json.loads(snap)
        self.name = d.get("name", "Untitled")
        self.features = d.get("features", [])
        self.rollback = d.get("rollback")
        self.body_meta = d.get("body_meta", {})
        self._result = None

    def _checkpoint(self) -> None:
        self._undo.append(self.snapshot())
        if len(self._undo) > 200:
            self._undo.pop(0)
        self._redo.clear()

    def undo(self) -> bool:
        if not self._undo:
            return False
        self._redo.append(self.snapshot())
        self.restore(self._undo.pop())
        return True

    def redo(self) -> bool:
        if not self._redo:
            return False
        self._undo.append(self.snapshot())
        self.restore(self._redo.pop())
        return True

    def to_project(self) -> dict:
        return {"format": "claude-3dcad", "version": 1, **json.loads(self.snapshot())}

    def load_project(self, data: dict) -> None:
        if data.get("format") != "claude-3dcad":
            raise FeatureError("not a claude-3dcad project file")
        for f in data.get("features", []):
            if f.get("type") not in FEATURE_TYPES:
                raise FeatureError(f"unknown feature type in project: {f.get('type')}")
        self._checkpoint()
        self.restore(json.dumps(data))

    def new(self) -> None:
        self._checkpoint()
        self.restore(json.dumps({"name": "Untitled", "features": [], "rollback": None, "body_meta": {}}))

    # --------------------------------------------------------------- features

    def _index(self, fid: str) -> int:
        for i, f in enumerate(self.features):
            if f["id"] == fid:
                return i
        raise FeatureError(f"no feature {fid}")

    def _unique_name(self, ftype: str) -> str:
        base = TYPE_LABELS.get(ftype, ftype)
        used = {f["name"] for f in self.features}
        n = 1
        while f"{base}{n}" in used:
            n += 1
        return f"{base}{n}"

    def add_feature(self, ftype: str, params: dict | None = None, name: str | None = None) -> dict:
        if ftype not in FEATURE_TYPES:
            raise FeatureError(f"unknown feature type: {ftype}")
        p = copy.deepcopy(DEFAULT_PARAMS[ftype])
        if params:
            p.update(params)
        feature = {
            "id": uuid.uuid4().hex[:8],
            "type": ftype,
            "name": name or self._unique_name(ftype),
            "suppressed": False,
            "params": p,
        }
        self._checkpoint()
        pos = self.active_count()
        self.features.insert(pos, feature)
        if self.rollback is not None:
            self.rollback += 1
        self._result = None
        return feature

    def update_feature(self, fid: str, params: dict | None = None, name: str | None = None,
                       suppressed: bool | None = None) -> dict:
        f = self.features[self._index(fid)]
        self._checkpoint()
        if params:
            f["params"].update(params)
        if name:
            f["name"] = name
        if suppressed is not None:
            f["suppressed"] = bool(suppressed)
        self._result = None
        return f

    def delete_feature(self, fid: str) -> None:
        i = self._index(fid)
        self._checkpoint()
        self.features.pop(i)
        if self.rollback is not None and i < self.rollback:
            self.rollback -= 1
        self._result = None

    def move_feature(self, fid: str, index: int) -> None:
        i = self._index(fid)
        self._checkpoint()
        f = self.features.pop(i)
        index = max(0, min(int(index), len(self.features)))
        self.features.insert(index, f)
        self._result = None

    def active_count(self) -> int:
        return len(self.features) if self.rollback is None else max(0, min(self.rollback, len(self.features)))

    def set_rollback(self, index: int | None) -> None:
        if index is not None and index >= len(self.features):
            index = None
        if index is not None:
            index = max(0, int(index))
        self.rollback = index
        self._result = None

    def set_body_meta(self, body_id: str, **meta) -> None:
        m = self.body_meta.setdefault(body_id, {})
        m.update({k: v for k, v in meta.items() if v is not None})

    # ------------------------------------------------------------- regenerate

    def result(self) -> RegenResult:
        if self._result is None:
            with K.LOCK:
                self._result = self._regenerate()
        return self._result

    def _regenerate(self) -> RegenResult:
        res = RegenResult(bodies=OrderedDict())
        for i, f in enumerate(self.features):
            if i >= self.active_count():
                res.status[f["id"]] = {"state": "rolledback"}
                continue
            if f.get("suppressed"):
                res.status[f["id"]] = {"state": "suppressed"}
                continue
            try:
                self._apply(f, res.bodies)
                res.status[f["id"]] = {"state": "ok"}
            except (FeatureError, K.KernelError, RuntimeError, KeyError, ValueError, TypeError, IndexError) as ex:
                res.status[f["id"]] = {"state": "error", "message": _clean_error(ex)}
        return res

    def _cached(self, key: str, build: Callable[[], Any]):
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        value = build()
        if value is None:
            raise FeatureError("operation produced no geometry")
        self._cache.put(key, value)
        return value

    def _target(self, bodies: dict, p: dict, key: str = "target") -> Body:
        bid = p.get(key)
        if not bid:
            raise FeatureError(f"no {key} body selected")
        if bid not in bodies:
            raise FeatureError(f"{key} body '{bid}' does not exist at this point in the history")
        return bodies[bid]

    def _new_body(self, bodies: dict, f: dict, brep, sig: str, suffix: str = "") -> Body:
        bid = f["id"] + suffix
        b = Body(id=bid, name=f["name"] + suffix, brep=brep, sig=sig, source=f["id"])
        bodies[bid] = b
        return b

    def _combine(self, bodies: dict, f: dict, brep, sig: str) -> None:
        """Handle the new/join/cut/intersect mode of sketch-based features."""
        p = f["params"]
        mode = p.get("mode", "new")
        if mode == "new":
            self._new_body(bodies, f, brep, sig)
            return
        op = {"join": "union", "cut": "difference", "intersect": "intersection"}.get(mode)
        if op is None:
            raise FeatureError(f"unknown mode: {mode}")
        tgt = self._target(bodies, p)
        new_sig = tgt.touched(f)
        tgt.brep = self._cached(new_sig, lambda: K.boolean(op, tgt.brep, brep))
        tgt.sig = new_sig

    def _apply(self, f: dict, bodies: "OrderedDict[str, Body]") -> None:
        t, p = f["type"], f["params"]
        sig = hashlib.sha1(_feature_sig(f).encode()).hexdigest()

        if t in PRIMITIVES:
            builder = getattr(K, t)
            args = {k: v for k, v in p.items() if k != "origin"}
            brep = self._cached(sig, lambda: builder(tuple(p["origin"]), **args))
            self._new_body(bodies, f, brep, sig)
        elif t == "extrude":
            brep = self._cached(sig + ":tool", lambda: K.extrude(
                p["profile"], p["distance"], p.get("plane", "XY"), p.get("offset", 0), p.get("symmetric", False)))
            self._combine(bodies, f, brep, sig)
        elif t == "revolve":
            brep = self._cached(sig + ":tool", lambda: K.revolve(p["points"], p.get("angle", 360)))
            self._combine(bodies, f, brep, sig)
        elif t == "boolean":
            tgt = self._target(bodies, p)
            tool = self._target(bodies, p, "tool")
            if tgt.id == tool.id:
                raise FeatureError("target and tool must be different bodies")
            new_sig = hashlib.sha1((tgt.sig + tool.sig + _feature_sig(f)).encode()).hexdigest()
            tgt.brep = self._cached(new_sig, lambda: K.boolean(p.get("op", "union"), tgt.brep, tool.brep))
            tgt.sig = new_sig
            if not p.get("keep_tool"):
                del bodies[tool.id]
        elif t in MODIFY_FEATURES:
            tgt = self._target(bodies, p)
            new_sig = tgt.touched(f)
            src = tgt.brep
            if t in ("fillet", "chamfer"):
                op = lambda: K.fillet(src, p.get("edges", []), p["radius"], chamfer=t == "chamfer")
            elif t == "shell":
                op = lambda: K.shell(src, p.get("faces", []), p["thickness"])
            elif t == "offset":
                op = lambda: K.offset(src, p["distance"])
            elif t == "transform":
                op = lambda: K.transform(src, tuple(p["translate"]), tuple(p["rotate_axis"]), p["rotate_deg"],
                                         tuple(p["pivot"]), p.get("scale", 1))
            elif t == "mirror":
                if p.get("merge", True):
                    op = lambda: K.boolean("union", src, K.mirror_copy(src, p["plane"], p.get("offset", 0)))
                else:
                    op = lambda: K.mirror_copy(src, p["plane"], p.get("offset", 0))
            elif t == "pattern_linear":
                op = lambda: K.linear_pattern(src, tuple(p["direction"]), p["spacing"], p["count"])
            else:
                op = lambda: K.circular_pattern(src, tuple(p["axis"]), tuple(p["center"]), p["count"], p["angle"])
            brep = self._cached(new_sig, op)
            makes_copy = (t == "transform" and p.get("copy")) or (t == "mirror" and not p.get("merge", True))
            if makes_copy:
                self._new_body(bodies, f, brep, new_sig)
            else:
                tgt.brep, tgt.sig = brep, new_sig
        elif t == "delete_body":
            tgt = self._target(bodies, p)
            del bodies[tgt.id]
        elif t == "import_usd":
            breps = self._cached(sig, lambda: _import_usd_data(p["filename"], p["data"]))
            if not breps:
                raise FeatureError("the file contains no BRep bodies")
            for k, b in enumerate(breps):
                self._new_body(bodies, f, b, f"{sig}:{k}", "" if k == 0 else f".{k}")
        else:
            raise FeatureError(f"unknown feature type: {t}")

    # ----------------------------------------------------------------- output

    def body_list(self) -> list[dict]:
        res = self.result()
        out = []
        for i, b in enumerate(res.bodies.values()):
            meta = self.body_meta.get(b.id, {})
            src = next((f for f in self.features if f["id"] == b.source), None)
            out.append({
                "id": b.id,
                "name": meta.get("name") or (src["name"] if src and b.id == src["id"] else b.name),
                "color": meta.get("color") or PALETTE[i % len(PALETTE)],
                "visible": meta.get("visible", True),
                "sig": b.sig,
            })
        return out

    def body(self, body_id: str) -> Body:
        b = self.result().bodies.get(body_id)
        if b is None:
            raise FeatureError(f"no body {body_id}")
        return b

    def mesh(self, body_id: str, quality: str = "normal") -> dict:
        b = self.body(body_id)
        key = f"{b.sig}:{quality}"
        m = self._mesh_cache.get(key)
        if m is None:
            with K.LOCK:
                m = K.mesh(b.brep, quality)
            self._mesh_cache[key] = m
            while len(self._mesh_cache) > 128:
                self._mesh_cache.popitem(last=False)
        return m

    def properties(self, body_id: str) -> dict:
        with K.LOCK:
            return K.properties(self.body(body_id).brep)

    def state(self) -> dict:
        res = self.result()
        return {
            "name": self.name,
            "features": self.features,
            "rollback": self.rollback,
            "active": self.active_count(),
            "status": res.status,
            "bodies": self.body_list(),
            "can_undo": bool(self._undo),
            "can_redo": bool(self._redo),
        }


def _import_usd_data(filename: str, data_b64: str) -> list:
    raw = base64.b64decode(data_b64)
    suffix = os.path.splitext(filename)[1] or ".usd"
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "import" + suffix)
        with open(path, "wb") as fh:
            fh.write(raw)
        return K.import_usd(path)


def _clean_error(ex: Exception) -> str:
    msg = str(ex).strip() or ex.__class__.__name__
    first = msg.splitlines()[0]
    return first[:300]
