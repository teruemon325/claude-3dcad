"""HTTP API + static web UI for claude-3dcad."""

from __future__ import annotations

import base64
import os
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import kernel as K
from . import sketch as S
from .document import FEATURE_TYPES, DEFAULT_PARAMS, Document, FeatureError

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class AddFeature(BaseModel):
    type: str
    params: dict[str, Any] | None = None
    name: str | None = None


class UpdateFeature(BaseModel):
    params: dict[str, Any] | None = None
    name: str | None = None
    suppressed: bool | None = None


class MoveFeature(BaseModel):
    index: int


class Rollback(BaseModel):
    index: int | None = None


class BodyMeta(BaseModel):
    name: str | None = None
    color: str | None = None
    visible: bool | None = None


class Preview(BaseModel):
    type: str
    params: dict[str, Any]
    feature: str | None = None


class SketchBody(BaseModel):
    sketch: dict[str, Any]


class PickEdge(BaseModel):
    body: str
    edge: int


class PickFace(BaseModel):
    body: str
    point: list[float]


def create_app(doc: Document | None = None) -> FastAPI:
    app = FastAPI(title="claude-3dcad")
    app.state.doc = doc or Document()

    def D() -> Document:
        return app.state.doc

    def ok() -> dict:
        return D().state()

    @app.exception_handler(FeatureError)
    async def _feature_error(_, ex: FeatureError):
        return JSONResponse(status_code=400, content={"detail": str(ex)})

    @app.exception_handler(K.KernelError)
    async def _kernel_error(_, ex: K.KernelError):
        return JSONResponse(status_code=400, content={"detail": str(ex)})

    # ------------------------------------------------------------ document

    @app.get("/api/doc")
    def get_doc():
        return ok()

    @app.get("/api/feature-types")
    def feature_types():
        return {"types": list(FEATURE_TYPES), "defaults": DEFAULT_PARAMS}

    @app.post("/api/features")
    def add_feature(body: AddFeature):
        f = D().add_feature(body.type, body.params, body.name)
        return {**ok(), "added": f["id"]}

    @app.put("/api/features/{fid}")
    def update_feature(fid: str, body: UpdateFeature):
        D().update_feature(fid, body.params, body.name, body.suppressed)
        return ok()

    @app.delete("/api/features/{fid}")
    def delete_feature(fid: str):
        D().delete_feature(fid)
        return ok()

    @app.post("/api/features/{fid}/move")
    def move_feature(fid: str, body: MoveFeature):
        D().move_feature(fid, body.index)
        return ok()

    @app.post("/api/rollback")
    def rollback(body: Rollback):
        D().set_rollback(body.index)
        return ok()

    @app.post("/api/undo")
    def undo():
        D().undo()
        return ok()

    @app.post("/api/redo")
    def redo():
        D().redo()
        return ok()

    @app.post("/api/new")
    def new():
        D().new()
        return ok()

    @app.put("/api/name")
    def rename(body: BodyMeta):
        if body.name:
            D().name = body.name
        return ok()

    # -------------------------------------------------------------- bodies

    @app.get("/api/bodies/{bid}/mesh")
    def body_mesh(bid: str, quality: str = "normal"):
        if quality not in ("coarse", "normal", "fine"):
            raise HTTPException(400, "quality must be coarse, normal or fine")
        try:
            return D().mesh(bid, quality)
        except RuntimeError as ex:
            raise HTTPException(400, f"tessellation failed: {ex}") from ex

    @app.get("/api/bodies/{bid}/properties")
    def body_properties(bid: str):
        return D().properties(bid)

    @app.put("/api/bodies/{bid}")
    def body_meta(bid: str, body: BodyMeta):
        if bid not in D().result().sketches:
            D().body(bid)
        D().set_body_meta(bid, name=body.name, color=body.color, visible=body.visible)
        return ok()

    @app.post("/api/pick/edge")
    def pick_edge(body: PickEdge):
        b = D().body(body.body)
        with K.LOCK:
            try:
                return {"ref": K.pick_edge(b.brep, body.edge)}
            except IndexError as ex:
                raise HTTPException(400, "edge index out of range") from ex

    @app.post("/api/preview")
    def preview(body: Preview):
        return D().preview(body.type, body.params, body.feature)

    @app.post("/api/sketch/describe")
    def sketch_describe(body: SketchBody):
        try:
            return S.describe(body.sketch)
        except S.SketchError as ex:
            raise HTTPException(400, str(ex)) from ex

    @app.post("/api/pick/plane")
    def pick_plane(body: PickFace):
        b = D().body(body.body)
        with K.LOCK:
            return {"plane": K.plane_from_face(b.brep, tuple(body.point))}

    @app.post("/api/pick/face")
    def pick_face(body: PickFace):
        b = D().body(body.body)
        if len(body.point) != 3:
            raise HTTPException(400, "point must have 3 coordinates")
        with K.LOCK:
            idx, ref = K.pick_face(b.brep, tuple(body.point))
        return {"face": idx, "ref": ref}

    # ------------------------------------------------------------- files

    @app.get("/api/project")
    def get_project():
        return D().to_project()

    @app.post("/api/project")
    def load_project(data: dict[str, Any]):
        D().load_project(data)
        return ok()

    @app.post("/api/import")
    async def import_file(file: UploadFile = File(...)):
        raw = await file.read()
        name = file.filename or "import.usd"
        ext = os.path.splitext(name)[1].lower()
        if ext not in (".usd", ".usda", ".usdc", ".step", ".stp"):
            raise HTTPException(400, "only STEP (.step / .stp) and USD BRep (.usd / .usda / .usdc) files can be imported")
        if ext in (".step", ".stp"):
            from . import step

            try:
                step.require()
            except step.StepError as ex:
                raise HTTPException(400, str(ex)) from ex
        D().add_feature("import_usd", {"filename": name, "data": base64.b64encode(raw).decode()},
                        name=os.path.splitext(name)[0][:40] or None)
        return ok()

    @app.get("/api/export/{fmt}")
    def export(fmt: str, bodies: str | None = None):
        doc = D()
        visible = [b for b in doc.body_list() if b["visible"]]
        ids = bodies.split(",") if bodies else [b["id"] for b in visible]
        breps = [doc.body(i).brep for i in ids]
        if not breps:
            raise HTTPException(400, "nothing to export")
        stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in doc.name) or "model"
        if fmt == "stl":
            with K.LOCK:
                text = K.write_stl(breps, stem)
            return Response(text, media_type="model/stl",
                            headers={"Content-Disposition": f'attachment; filename="{stem}.stl"'})
        if fmt in ("usda", "usda-mesh"):
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, f"{stem}.usda")
                with K.LOCK:
                    (K.export_usd if fmt == "usda" else K.export_usd_mesh)(breps, path)
                data = Path(path).read_bytes()
            suffix = "" if fmt == "usda" else "_mesh"
            return Response(data, media_type="text/plain",
                            headers={"Content-Disposition": f'attachment; filename="{stem}{suffix}.usda"'})
        if fmt == "step":
            from . import step

            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, f"{stem}.step")
                try:
                    with K.LOCK:
                        step.export_step(breps, path, name=doc.name)
                except step.StepError as ex:
                    raise HTTPException(400, str(ex)) from ex
                data = Path(path).read_bytes()
            return Response(data, media_type="model/step",
                            headers={"Content-Disposition": f'attachment; filename="{stem}.step"'})
        raise HTTPException(404, f"unknown export format: {fmt}")

    # ------------------------------------------------------------- web UI

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
    return app


app = create_app()


DEFAULT_PORT = 8765


def _free_port(host: str, start: int, tries: int = 20) -> int:
    """First port from ``start`` that nothing else is listening on."""
    import socket

    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
            except OSError:
                continue
            return port
    raise SystemExit(f"no free port in {start}-{start + tries - 1}")


def main() -> None:
    import argparse
    import threading
    import webbrowser

    import uvicorn

    ap = argparse.ArgumentParser(description="claude-3dcad server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help=f"port to listen on; the next free one is used if it is taken (default {DEFAULT_PORT})")
    ap.add_argument("--open", action="store_true", help="open the app in the web browser")
    args = ap.parse_args()
    port = _free_port(args.host, args.port)
    url = f"http://{args.host}:{port}/"
    if port != args.port:
        print(f"claude-3dcad: port {args.port} is in use by another program, using {port} instead")
    print(f"claude-3dcad: open {url} in your browser")
    if args.open:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=port, workers=1)


if __name__ == "__main__":
    main()
