// Three.js viewport: renders bodies, edges, previews and handles picking.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const EDGE_COLOR = 0x1d232b;
const HILITE = 0xff8a00;
const SELECT = 0x2f6fdb;

export class Viewer {
  constructor(container, { onPick, onHover } = {}) {
    this.container = container;
    this.onPick = onPick || (() => {});
    this.onHover = onHover || (() => {});
    this.bodies = new Map(); // id -> { group, mesh, edges: [Line], data, color }
    this.pickMode = null; // 'body' | 'edge' | 'face' | null
    this.pickFilter = null; // optional body id restriction
    this.showEdges = true;
    this.xray = false;
    this.selectedBodies = new Set();
    this.hover = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
    camera.up.set(0, 0, 1);
    camera.position.set(80, -110, 80);
    this.camera = camera;
    scene.add(camera);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 1.5, 2);
    camera.add(key);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    controls.screenSpacePanning = true;
    this.controls = controls;

    this.world = new THREE.Group();
    scene.add(this.world);
    this.overlay = new THREE.Group();
    scene.add(this.overlay);
    this.preview = new THREE.Group();
    scene.add(this.preview);
    this.sketchGroup = new THREE.Group();
    scene.add(this.sketchGroup);
    this.previewBodies = new THREE.Group();
    scene.add(this.previewBodies);
    this.sketches = [];
    this.hiddenSketch = null;
    this.hiddenBodies = new Set();
    this.profileSel = null; // { sketch, points }
    this.activeCamera = camera;
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1e5);
    this.ortho.add(key.clone());
    scene.add(this.ortho);
    this._buildGrid(100);

    this.raycaster = new THREE.Raycaster();
    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    const loop = () => {
      if (this.activeCamera === camera) controls.update();
      renderer.render(scene, this.activeCamera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  _buildGrid(size) {
    if (this.grid) this.scene.remove(this.grid);
    const g = new THREE.Group();
    const step = niceStep(size / 10);
    const n = Math.ceil(size / step) * 2;
    const grid = new THREE.GridHelper(step * n, n, 0x9aa5b1, 0xc4ccd5);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.material.depthWrite = false;
    g.add(grid);
    const axisLen = step * 2;
    const axes = [
      [[axisLen, 0, 0], 0xd03c3c],
      [[0, axisLen, 0], 0x3ca04c],
      [[0, 0, axisLen], 0x3c6cd0],
    ];
    for (const [end, color] of axes) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...end)]);
      g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false })));
    }
    g.renderOrder = -1;
    this.grid = g;
    this.gridStep = step;
    this.scene.add(g);
  }

  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || down.b !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      this.onPick(this._hit(e), e);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const hit = this._hit(e);
      this._setHover(hit);
      this.onHover(hit);
    });
    el.addEventListener('pointerleave', () => { this._setHover(null); this.onHover(null); });
  }

  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _hit(e) {
    this.raycaster.setFromCamera(this._ndc(e), this.activeCamera);
    if (this.pickMode === 'profile' || this.pickMode === 'sketch') {
      const regions = this.sketchGroup.children.filter((o) => o.userData.region && o.visible
        && (!this.pickFilter || o.userData.sketch === this.pickFilter));
      const rh = this.raycaster.intersectObjects(regions, false)[0];
      if (rh) return { kind: 'profile', sketch: rh.object.userData.sketch, point: rh.object.userData.local(rh.point), world: rh.point.toArray() };
      if (this.pickMode === 'sketch') {
        this.raycaster.params.Line.threshold = this.camera.position.distanceTo(this.controls.target) * 0.006;
        const lines = this.sketchGroup.children.filter((o) => o.isLine && o.visible);
        const lh = this.raycaster.intersectObjects(lines, false)[0];
        if (lh) return { kind: 'profile', sketch: lh.object.userData.sketch, point: null, world: lh.point.toArray() };
      }
      return null;
    }
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.raycaster.params.Line.threshold = dist * 0.006;
    const meshes = [];
    const lines = [];
    for (const [id, b] of this.bodies) {
      if (!b.group.visible) continue;
      if (this.pickFilter && this.pickFilter !== id) continue;
      meshes.push(b.mesh);
      lines.push(...b.edges);
    }
    const faceHit = this.raycaster.intersectObjects(meshes, false)[0];
    const point = faceHit ? faceHit.point.toArray() : null;
    if (this.pickMode === 'edge') {
      const edgeHits = this.raycaster.intersectObjects(lines, false);
      // ignore edges hidden behind the nearest surface
      const eh = edgeHits.find((h) => !faceHit || h.distance <= faceHit.distance + dist * 0.01);
      if (eh) return { kind: 'edge', body: eh.object.userData.body, edge: eh.object.userData.edge, point: eh.point.toArray() };
      return point ? { kind: 'none', point } : null;
    }
    if (!faceHit) return null;
    const body = faceHit.object.userData.body;
    if (this.pickMode === 'face' || this.pickMode === 'plane') return { kind: 'face', body, point };
    return { kind: 'body', body, point };
  }

  _setHover(hit) {
    if (this.hover) {
      const { obj, restore } = this.hover;
      restore(obj);
      this.hover = null;
    }
    if (!hit || !this.pickMode) return;
    const b = this.bodies.get(hit.body);
    if (!b) return;
    if (hit.kind === 'edge') {
      const line = b.edges[hit.edge];
      if (!line) return;
      const prev = line.material;
      line.material = new THREE.LineBasicMaterial({ color: HILITE, depthTest: false });
      line.renderOrder = 10;
      this.hover = { obj: line, restore: (o) => { o.material.dispose(); o.material = prev; o.renderOrder = 1; } };
    } else if (hit.kind === 'profile') {
      const objs = this.sketchGroup.children.filter((o) => o.userData.region && o.userData.sketch === hit.sketch
        && hit.point && regionContains(o.userData.region, hit.point));
      const o = objs.sort((a, b) => a.userData.region.area - b.userData.region.area)[0];
      if (!o) return;
      const prev = o.material.opacity;
      o.material.opacity = Math.min(0.75, prev + 0.3);
      this.hover = { obj: o.material, restore: (m) => { m.opacity = prev; } };
    } else if (hit.kind === 'body' || hit.kind === 'face') {
      const mat = b.mesh.material;
      const prev = mat.emissive.getHex();
      mat.emissive.setHex(0x553300);
      this.hover = { obj: mat, restore: (m) => m.emissive.setHex(prev) };
    }
  }

  setPickMode(mode, filter = null) {
    this.pickMode = mode;
    this.pickFilter = filter;
    this._setHover(null);
    this.renderer.domElement.style.cursor = mode ? 'pointer' : '';
    this._applyStyle();
    this.setSketches();
  }

  /** bodies: [{id, color, visible, mesh: {positions, normals, indices, edges}}] */
  setBodies(list) {
    const keep = new Set(list.map((b) => b.id));
    this._setHover(null);
    for (const [id, b] of this.bodies) {
      if (!keep.has(id)) { this._dispose(b); this.bodies.delete(id); }
    }
    for (const item of list) {
      let b = this.bodies.get(item.id);
      if (b && b.data !== item.mesh) { this._dispose(b); this.bodies.delete(item.id); b = null; }
      if (!b && item.mesh) b = this._build(item);
      if (!b) continue;
      b.group.visible = item.visible && !this.hiddenBodies.has(item.id);
      b.wantVisible = item.visible;
      b.mesh.material.color.set(item.color);
    }
    this._applyStyle();
  }

  _build(item) {
    const m = item.mesh;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
    geo.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      color: item.color, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.body = item.id;
    const group = new THREE.Group();
    group.add(mesh);
    const edgeMat = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
    const edges = m.edges.map((pts, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts.length >= 6 ? pts : pts.concat(pts), 3));
      const line = new THREE.Line(g, edgeMat);
      line.userData = { body: item.id, edge: i };
      line.renderOrder = 1;
      group.add(line);
      return line;
    });
    this.world.add(group);
    const b = { group, mesh, edges, edgeMat, data: m };
    this.bodies.set(item.id, b);
    return b;
  }

  _dispose(b) {
    this.world.remove(b.group);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
    b.edgeMat.dispose();
    for (const e of b.edges) e.geometry.dispose();
  }

  _applyStyle() {
    for (const [id, b] of this.bodies) {
      const m = b.mesh.material;
      const ghost = this.xray || this.activeCamera === this.ortho;
      m.transparent = ghost;
      m.opacity = ghost ? 0.3 : 1;
      m.depthWrite = !ghost;
      const sel = this.selectedBodies.has(id);
      m.emissive.setHex(sel ? 0x0b2a5c : 0x000000);
      for (const e of b.edges) e.visible = this.showEdges || this.pickMode === 'edge';
    }
  }

  // ---------------------------------------------------------- sketch view

  setSketchView({ plane, cx, cy, scale, width, height }) {
    const { o, x, y, n } = frameOf(plane);
    const center = o.clone().addScaledVector(x, cx).addScaledVector(y, cy);
    const hw = width / 2 / scale;
    const hh = height / 2 / scale;
    const cam = this.ortho;
    const D = Math.max(1000, (hw + hh) * 50);
    Object.assign(cam, { left: -hw, right: hw, top: hh, bottom: -hh, near: D * 0.001, far: D * 2 });
    cam.up.copy(y);
    cam.position.copy(center).addScaledVector(n, D);
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    const entering = this.activeCamera !== cam;
    this.activeCamera = cam;
    this.controls.enabled = false;
    this._sketchCenter = center;
    this._sketchDist = Math.max(hw, hh) * 2.5;
    this._sketchNormal = n;
    if (entering) this._applyStyle();
  }

  exitSketchView() {
    if (this.activeCamera !== this.ortho) return;
    this.activeCamera = this.camera;
    this.controls.enabled = true;
    // continue in 3D looking at the sketch from a slight angle
    if (this._sketchCenter) {
      const dir = this._sketchNormal.clone().add(new THREE.Vector3(0.35, -0.45, 0.3)).normalize();
      this.controls.target.copy(this._sketchCenter);
      this.camera.position.copy(this._sketchCenter).addScaledVector(dir, this._sketchDist);
    }
    this._applyStyle();
  }

  /** sketches: [{id, visible, plane, curves:[{points, construction}], regions:[{outer, holes, point, area}]}] */
  setSketches(list = this.sketches) {
    this.sketches = list;
    this._clearGroup(this.sketchGroup);
    const css = getComputedStyle(document.documentElement);
    const lineColor = new THREE.Color(css.getPropertyValue('--sk-3d').trim() || '#1d4f91');
    for (const sk of list) {
      const show = sk.visible || (this.profileSel && this.profileSel.sketch === sk.id) || this.pickMode === 'sketch' || this.pickMode === 'profile';
      if (!show || sk.id === this.hiddenSketch) continue;
      const { o, x, y, n } = frameOf(sk.plane);
      const toW = ([u, v]) => o.clone().addScaledVector(x, u).addScaledVector(y, v);
      for (const c of sk.curves) {
        const geo = new THREE.BufferGeometry().setFromPoints(c.points.map(toW));
        const mat = c.construction
          ? new THREE.LineDashedMaterial({ color: lineColor, dashSize: this.markerSize() * 1.5, gapSize: this.markerSize(), transparent: true, opacity: 0.6 })
          : new THREE.LineBasicMaterial({ color: lineColor });
        const line = new THREE.Line(geo, mat);
        if (c.construction) line.computeLineDistances();
        line.userData = { sketch: sk.id };
        line.renderOrder = 5;
        this.sketchGroup.add(line);
      }
      const basis = new THREE.Matrix4().makeBasis(x, y, n).setPosition(o);
      const inv = basis.clone().invert();
      const selected = this.profileSel && this.profileSel.sketch === sk.id ? this.profileSel : null;
      for (const r of sk.regions) {
        const shape = new THREE.Shape(r.outer.map(([u, v]) => new THREE.Vector2(u, v)));
        for (const h of r.holes) shape.holes.push(new THREE.Path(h.map(([u, v]) => new THREE.Vector2(u, v))));
        const geo = new THREE.ShapeGeometry(shape);
        const isSel = selected && (selected.points.length
          ? selected.points.some((q) => regionContains(r, q) && smallestContaining(sk.regions, q) === r)
          : r.depth % 2 === 0);
        const mat = new THREE.MeshBasicMaterial({
          color: isSel ? 0x2f6fdb : 0x6f8fb8, transparent: true, opacity: isSel ? 0.45 : 0.12,
          side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.applyMatrix4(basis);
        mesh.userData = {
          sketch: sk.id, region: r,
          local: (p) => { const q = p.clone().applyMatrix4(inv); return [q.x, q.y]; },
        };
        mesh.renderOrder = 4;
        this.sketchGroup.add(mesh);
      }
    }
  }

  setHiddenSketch(id) { this.hiddenSketch = id; this.setSketches(); }

  setProfileSelection(sel) { this.profileSel = sel; this.setSketches(); }

  /** Show a feature preview: translucent result meshes, hiding the bodies they replace. */
  setPreviewBodies(pv) {
    this._clearGroup(this.previewBodies);
    this.hiddenBodies = new Set();
    if (pv) {
      for (const id of pv.removed || []) this.hiddenBodies.add(id);
      for (const b of pv.bodies || []) {
        if (b.replaces) this.hiddenBodies.add(b.replaces);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(b.mesh.positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.mesh.normals, 3));
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: 0xf29b38, transparent: true, opacity: 0.6, roughness: 0.6, side: THREE.DoubleSide, depthWrite: false,
        }));
        this.previewBodies.add(mesh);
        for (const pts of b.mesh.edges) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pts.length >= 6 ? pts : pts.concat(pts), 3));
          this.previewBodies.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x8a4b00 })));
        }
      }
    }
    for (const [id, b] of this.bodies) b.group.visible = (b.wantVisible ?? true) && !this.hiddenBodies.has(id);
  }

  setEdgesVisible(v) { this.showEdges = v; this._applyStyle(); }
  setXray(v) { this.xray = v; this._applyStyle(); }
  setSelectedBodies(ids) { this.selectedBodies = new Set(ids); this._applyStyle(); }

  /** Highlight selected edge refs / face refs on a body. */
  setSelection({ body = null, edgeRefs = [], faceRefs = [] } = {}) {
    this._clearGroup(this.overlay);
    const b = body && this.bodies.get(body);
    if (!b) return;
    for (const ref of edgeRefs) {
      const idx = this.nearestEdge(body, ref);
      if (idx < 0) continue;
      const src = b.edges[idx].geometry;
      const line = new THREE.Line(src, new THREE.LineBasicMaterial({ color: SELECT, depthTest: false }));
      line.renderOrder = 9;
      this.overlay.add(line);
    }
    const r = this.markerSize();
    for (const ref of faceRefs) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshBasicMaterial({ color: SELECT, depthTest: false }));
      s.position.set(...ref);
      s.renderOrder = 9;
      this.overlay.add(s);
    }
  }

  markerSize() {
    return this.camera.position.distanceTo(this.controls.target) * 0.008;
  }

  nearestEdge(bodyId, p) {
    const b = this.bodies.get(bodyId);
    if (!b) return -1;
    let best = -1;
    let bestD = Infinity;
    b.data.edges.forEach((pts, i) => {
      const d = distToPolyline(p, pts);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /** Draw preview polylines (world coords). Each item: {points: [[x,y,z],...], closed, color} */
  setPreview(items = []) {
    this._clearGroup(this.preview);
    for (const it of items) {
      const pts = it.points.map((p) => new THREE.Vector3(...p));
      if (it.closed && pts.length) pts.push(pts[0].clone());
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = it.dashed
        ? new THREE.LineDashedMaterial({ color: it.color ?? 0xe0662f, dashSize: this.markerSize() * 2, gapSize: this.markerSize(), depthTest: false })
        : new THREE.LineBasicMaterial({ color: it.color ?? 0xe0662f, depthTest: false });
      const line = new THREE.Line(geo, mat);
      if (it.dashed) line.computeLineDistances();
      line.renderOrder = 8;
      this.preview.add(line);
    }
  }

  _clearGroup(g) {
    for (const c of [...g.children]) {
      g.remove(c);
      if (c.material) c.material.dispose();
      if (c.geometry && !this._isShared(c.geometry)) c.geometry.dispose();
    }
  }

  _isShared(geo) {
    for (const b of this.bodies.values()) if (b.edges.some((e) => e.geometry === geo)) return true;
    return false;
  }

  bounds() {
    const box = new THREE.Box3();
    for (const b of this.bodies.values()) if (b.group.visible) box.expandByObject(b.group);
    return box;
  }

  fit() {
    const box = this.bounds();
    if (box.isEmpty()) box.set(new THREE.Vector3(-25, -25, 0), new THREE.Vector3(25, 25, 25));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.1;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = dist / 1000;
    this.camera.far = dist * 1000;
    this.camera.updateProjectionMatrix();
    const size = Math.max(radius * 2, 10);
    if (Math.abs(niceStep(size / 10) - this.gridStep) > 1e-9) this._buildGrid(size);
  }

  setView(name) {
    const dirs = {
      iso: [1, -1, 0.8], top: [0, -0.0001, 1], front: [0, -1, 0], right: [1, 0, 0],
    };
    if (name === 'fit') return this.fit();
    const d = dirs[name];
    if (!d) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const v = new THREE.Vector3(...d).normalize().multiplyScalar(dist);
    this.camera.position.copy(this.controls.target).add(v);
    this.fit();
  }
}

function frameOf(plane) {
  const o = new THREE.Vector3(...plane.origin);
  const x = new THREE.Vector3(...plane.x).normalize();
  const y0 = new THREE.Vector3(...plane.y);
  const y = y0.sub(x.clone().multiplyScalar(y0.dot(x))).normalize();
  const n = new THREE.Vector3().crossVectors(x, y);
  return { o, x, y, n };
}

function pointInPoly([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function regionContains(r, q) {
  return pointInPoly(q, r.outer) && !r.holes.some((h) => pointInPoly(q, h));
}

function smallestContaining(regions, q) {
  let best = null;
  for (const r of regions) if (regionContains(r, q) && (!best || r.area < best.area)) best = r;
  return best;
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-6))));
  const m = x / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

function distToPolyline(p, flat) {
  let best = Infinity;
  const n = flat.length / 3;
  if (n === 1) return Math.hypot(p[0] - flat[0], p[1] - flat[1], p[2] - flat[2]);
  for (let i = 0; i < n - 1; i++) {
    const a = [flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]];
    const b = [flat[3 * i + 3], flat[3 * i + 4], flat[3 * i + 5]];
    best = Math.min(best, distToSegment(p, a, b));
  }
  return best;
}

function distToSegment(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  let t = L > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}
