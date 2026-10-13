// Interactive 2D sketch editor drawn on a canvas overlaid on the 3D viewport.
// The 3D camera is locked normal to the sketch plane and kept in sync with the
// 2D view, so the model stays visible behind the sketch.
import { solve, measure, constrainedSet, DIMENSION_TYPES, ORIGIN } from './solver.js';

const GLYPH = {
  coincident: '●', horizontal: '━', vertical: '┃', parallel: '∥', perpendicular: '⊥', equal: '=',
  tangent: 'T', pointOnLine: '◦', pointOnCircle: '◦', midpoint: 'M', fix: '⚓', symmetric: '⇔',
};

export const CONSTRAINT_LABELS = {
  coincident: '一致', horizontal: '水平', vertical: '垂直', parallel: '平行', perpendicular: '直交', equal: '等しい',
  tangent: '正接', pointOnLine: '線上', pointOnCircle: '円上', midpoint: '中点', fix: '固定', symmetric: '対称',
  distance: '距離', hdistance: '水平距離', vdistance: '垂直距離', length: '長さ', pldistance: '距離', radius: '半径',
  diameter: '直径', angle: '角度',
};

const TOOL_HINTS = {
  select: 'クリックで選択 (Shift で追加)。ドラッグで移動・範囲選択。右ドラッグでパン、ホイールでズーム。',
  line: 'クリックで点を追加して線を連続作成。始点をクリックで閉じる。右クリック / Esc で終了。',
  rect: '対角の 2 点をクリック。',
  circle: '中心 → 半径の点 をクリック。',
  arc: '中心 → 始点 → 終点 をクリック (マウスを回した向きに作成)。',
  point: 'クリックで点を作成。',
  dimension: '線・円・弧をクリック、または 2 つの点 / 線をクリックして寸法を入力。',
};

export class SketchEditor {
  constructor({ container, viewer, sketch, name, describe, onFinish, onCancel, onChange }) {
    this.container = container;
    this.viewer = viewer;
    this.sk = structuredClone(sketch);
    if (!this.sk.points.some((p) => p.id === ORIGIN)) this.sk.points.unshift({ id: ORIGIN, x: 0, y: 0 });
    this.sk.entities ||= [];
    this.sk.constraints ||= [];
    this.name = name;
    this.describe = describe;
    this.onFinish = onFinish;
    this.onCancel = onCancel;
    this.onChange = onChange || (() => {});
    this.tool = 'select';
    this.ts = {}; // tool state
    this.sel = new Set();
    this.hover = null;
    this.mouse = null;
    this.snapGrid = true;
    this.undoStack = [];
    this.redoStack = [];
    this.regions = [];
    this.message = '';
    this.glyphRects = [];
    this.dimRects = [];
    this._counter = 1 + Math.max(0, ...[...this.sk.points, ...this.sk.entities, ...this.sk.constraints]
      .map((o) => parseInt(String(o.id).replace(/\D/g, ''), 10) || 0));

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sketch-overlay';
    container.appendChild(this.canvas);
    this.popup = null;
    this._bind();
    this._resizeObs = new ResizeObserver(() => { this._size(); this._syncCamera(); this.draw(); });
    this._resizeObs.observe(container);
    this._size();
    this._initView();
    this.status = solve(this.sk);
    this._refreshRegions();
    this._syncCamera();
    this.draw();
  }

  // --------------------------------------------------------------- lifecycle

  destroy() {
    this._resizeObs.disconnect();
    window.removeEventListener('keydown', this._onKey, true);
    this.canvas.remove();
    this._closePopup();
  }

  finish() { this._closePopup(); this.onFinish(this.result()); }
  cancel() { this._closePopup(); this.onCancel(); }

  result() {
    const sk = structuredClone(this.sk);
    return sk;
  }

  // ------------------------------------------------------------------ view

  _size() {
    const r = this.container.getBoundingClientRect();
    this.w = Math.max(r.width, 10);
    this.h = Math.max(r.height, 10);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
  }

  _initView() {
    const pts = this.sk.points.filter((p) => p.id !== ORIGIN);
    if (pts.length) return this.fit();
    // center on the projection of the 3D view target, keep a similar zoom
    const t = this.viewer.controls.target;
    const { origin: o, x, y } = this.sk.plane;
    const d = [t.x - o[0], t.y - o[1], t.z - o[2]];
    this.cx = d[0] * x[0] + d[1] * x[1] + d[2] * x[2];
    this.cy = d[0] * y[0] + d[1] * y[1] + d[2] * y[2];
    const dist = this.viewer.camera.position.distanceTo(t);
    this.scale = this.h / Math.max(dist * 0.8, 1);
  }

  fit() {
    const pts = this.sk.points.map((p) => [p.x, p.y]);
    for (const e of this.sk.entities) {
      if (e.type === 'circle') {
        const c = this.P(e.c);
        pts.push([c.x - e.r, c.y - e.r], [c.x + e.r, c.y + e.r]);
      }
    }
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const span = Math.max(x1 - x0, y1 - y0, 10);
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.scale = Math.min(this.w, this.h) / (span * 1.4);
    this._syncCamera();
    this.draw();
  }

  _syncCamera() {
    this.viewer.setSketchView({ plane: this.sk.plane, cx: this.cx, cy: this.cy, scale: this.scale, width: this.w, height: this.h });
  }

  toScreen(x, y) { return [this.w / 2 + (x - this.cx) * this.scale, this.h / 2 - (y - this.cy) * this.scale]; }
  toModel(sx, sy) { return [this.cx + (sx - this.w / 2) / this.scale, this.cy - (sy - this.h / 2) / this.scale]; }

  gridStep() {
    const raw = 12 / this.scale;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  // ----------------------------------------------------------------- model

  P(id) { return this.sk.points.find((p) => p.id === id); }
  E(id) { return this.sk.entities.find((e) => e.id === id); }
  K(id) { return this.sk.constraints.find((c) => c.id === id); }
  kind(id) {
    if (this.sk.points.some((p) => p.id === id)) return 'point';
    const e = this.E(id);
    if (e) return e.type;
    if (this.K(id)) return 'constraint';
    return null;
  }
  newId(prefix) { return `${prefix}${this._counter++}`; }

  addPoint(x, y) {
    const p = { id: this.newId('p'), x: round(x), y: round(y) };
    this.sk.points.push(p);
    return p.id;
  }

  radius(e) {
    if (e.type === 'circle') return e.r;
    const c = this.P(e.c);
    const s = this.P(e.p1);
    return Math.hypot(s.x - c.x, s.y - c.y);
  }

  arcAngles(e) {
    const c = this.P(e.c);
    const s = this.P(e.p1);
    const t = this.P(e.p2);
    const a0 = Math.atan2(s.y - c.y, s.x - c.x);
    let a1 = Math.atan2(t.y - c.y, t.x - c.x);
    while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
    return [a0, a1];
  }

  _snapshot() { return JSON.stringify({ points: this.sk.points, entities: this.sk.entities, constraints: this.sk.constraints }); }

  _restore(s) {
    const d = JSON.parse(s);
    Object.assign(this.sk, d);
  }

  /** Run a modification; revert it when the sketch can no longer be solved. */
  edit(fn, { checkRedundant = false, message, silent = false } = {}) {
    const before = this._snapshot();
    const prevDof = this.status ? this.status.dof : null;
    const nBefore = this.sk.constraints.length;
    fn();
    const st = solve(this.sk);
    if (!st.ok) {
      this._restore(before);
      this.status = solve(this.sk);
      if (!silent) this.flash(message || '拘束が矛盾するため適用できません (過剰拘束)');
      this.draw();
      return false;
    }
    if (checkRedundant && prevDof !== null && st.dof >= prevDof && this.sk.constraints.length > nBefore) {
      this._restore(before);
      this.status = solve(this.sk);
      this.flash('この拘束は既存の拘束で決まっているため不要です (冗長)');
      this.draw();
      return false;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.status = st;
    this._changed();
    return true;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this.status = solve(this.sk);
    this.sel.clear();
    this._changed();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this.status = solve(this.sk);
    this._changed();
  }

  _changed() {
    this._refreshRegions();
    this.draw();
    this.onChange(this);
  }

  _refreshRegions() {
    clearTimeout(this._regionTimer);
    this._regionTimer = setTimeout(async () => {
      try {
        const d = await this.describe(this.result());
        this.regions = d.regions || [];
        this.regionError = d.error;
        this.draw();
        this.onChange(this);
      } catch { /* server unavailable: keep last */ }
    }, 120);
  }

  flash(msg) {
    this.message = msg;
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => { this.message = ''; this.draw(); }, 3500);
    this.draw();
  }

  /** Merge point `drop` into `keep` (coincidence by identity). */
  mergePoints(keep, drop) {
    if (keep === drop) return;
    if (drop === ORIGIN) [keep, drop] = [drop, keep];
    for (const e of this.sk.entities) for (const k of ['p1', 'p2', 'c']) if (e[k] === drop) e[k] = keep;
    for (const c of this.sk.constraints) c.refs = c.refs.map((r) => (r === drop ? keep : r));
    this.sk.points = this.sk.points.filter((p) => p.id !== drop);
    this.sk.entities = this.sk.entities.filter((e) => !(e.type === 'line' && e.p1 === e.p2));
    this._cleanup();
  }

  _cleanup() {
    const ids = new Set([...this.sk.points.map((p) => p.id), ...this.sk.entities.map((e) => e.id)]);
    this.sk.constraints = this.sk.constraints.filter((c) => {
      if (!c.refs.every((r) => ids.has(r))) return false;
      if (['coincident', 'horizontal', 'vertical', 'distance', 'hdistance', 'vdistance'].includes(c.type)
        && c.refs.length === 2 && c.refs[0] === c.refs[1]) return false;
      return true;
    });
  }

  deleteSelection() {
    if (!this.sel.size) return;
    const sel = new Set(this.sel);
    this.edit(() => {
      this.sk.constraints = this.sk.constraints.filter((c) => !sel.has(c.id));
      const delPts = new Set([...sel].filter((id) => this.kind(id) === 'point' && id !== ORIGIN));
      const used = (e) => [e.p1, e.p2, e.c].filter(Boolean);
      const removed = this.sk.entities.filter((e) => sel.has(e.id) || used(e).some((p) => delPts.has(p)));
      this.sk.entities = this.sk.entities.filter((e) => !removed.includes(e));
      // drop points no longer used by any entity (except explicit sketch points)
      const still = new Set(this.sk.entities.flatMap(used));
      const orphan = new Set(removed.flatMap(used).filter((p) => !still.has(p) && p !== ORIGIN && !this.P(p)?.free));
      this.sk.points = this.sk.points.filter((p) => !delPts.has(p.id) && !orphan.has(p.id));
      this._cleanup();
    });
    this.sel.clear();
    this.draw();
  }

  toggleConstruction() {
    const ents = [...this.sel].map((id) => this.E(id)).filter(Boolean);
    if (!ents.length) return this.flash('線・円・弧を選択してください');
    const on = !ents.every((e) => e.construction);
    this.edit(() => { for (const e of ents) e.construction = on; });
  }

  // ------------------------------------------------------------ constraints

  addConstraint(type, refs, extra = {}) {
    const c = { id: this.newId('k'), type, refs, ...extra };
    this.sk.constraints.push(c);
    return c;
  }

  applyConstraint(type) {
    const ids = [...this.sel];
    const pts = ids.filter((id) => this.kind(id) === 'point');
    const lines = ids.filter((id) => this.kind(id) === 'line');
    const curves = ids.filter((id) => ['circle', 'arc'].includes(this.kind(id)));
    const ents = [...lines, ...curves];
    const need = (ok, msg) => { if (!ok) this.flash(msg); return ok; };
    const opts = { checkRedundant: true };
    let done = false;
    switch (type) {
      case 'coincident':
        if (pts.length >= 2 && !ents.length) {
          done = this.edit(() => { for (const p of pts.slice(1)) this.mergePoints(pts[0], p); });
        } else if (pts.length === 1 && ents.length === 1) {
          const t = lines.length ? 'pointOnLine' : 'pointOnCircle';
          done = this.edit(() => this.addConstraint(t, [pts[0], ents[0]]), opts);
        } else need(false, '2 つの点、または点と線/円を選択してください');
        break;
      case 'horizontal':
      case 'vertical':
        if (lines.length && !pts.length) done = this.edit(() => lines.forEach((l) => this.addConstraint(type, [l])), opts);
        else if (pts.length === 2 && !ents.length) done = this.edit(() => this.addConstraint(type, pts), opts);
        else need(false, '線、または 2 つの点を選択してください');
        break;
      case 'parallel':
      case 'perpendicular':
        if (need(lines.length >= 2 && !pts.length && !curves.length, '2 本以上の線を選択してください')) {
          done = this.edit(() => lines.slice(1).forEach((l) => this.addConstraint(type, [lines[0], l])), opts);
        }
        break;
      case 'equal':
        if (need((lines.length >= 2 && !curves.length) || (curves.length >= 2 && !lines.length), '同じ種類の線どうし、または円/弧どうしを 2 つ以上選択してください')) {
          const list = lines.length ? lines : curves;
          done = this.edit(() => list.slice(1).forEach((e) => this.addConstraint('equal', [list[0], e])), opts);
        }
        break;
      case 'tangent':
        if (need(ents.length === 2 && curves.length >= 1 && !pts.length, '線と円/弧、または円/弧を 2 つ選択してください')) {
          const refs = lines.length ? [lines[0], curves[0]] : curves;
          const m = measure(this.sk, { type: 'tangent', refs });
          done = this.edit(() => this.addConstraint('tangent', refs, m), opts);
        }
        break;
      case 'midpoint':
        if (need(pts.length === 1 && lines.length === 1 && !curves.length, '点と線を 1 つずつ選択してください')) {
          done = this.edit(() => this.addConstraint('midpoint', [pts[0], lines[0]]), opts);
        }
        break;
      case 'concentric':
        if (need(curves.length === 2 && !pts.length && !lines.length, '円/弧を 2 つ選択してください')) {
          done = this.edit(() => this.mergePoints(this.E(curves[0]).c, this.E(curves[1]).c));
        }
        break;
      case 'fix': {
        const targets = new Set(pts);
        for (const id of ents) { const e = this.E(id); for (const k of ['p1', 'p2', 'c']) if (e[k]) targets.add(e[k]); }
        targets.delete(ORIGIN);
        if (need(targets.size > 0, '点または線/円を選択してください')) {
          done = this.edit(() => {
            for (const p of targets) {
              if (this.sk.constraints.some((c) => c.type === 'fix' && c.refs[0] === p)) continue;
              const q = this.P(p);
              this.addConstraint('fix', [p], { x: q.x, y: q.y });
            }
            for (const id of curves) {
              const e = this.E(id);
              if (e.type === 'circle') this.addConstraint('radius', [id], { value: e.r, offset: 0, angle: 45 });
            }
          });
        }
        break;
      }
      case 'symmetric':
        if (need(pts.length === 2 && lines.length === 1 && !curves.length, '2 つの点と対称軸の線を選択してください')) {
          done = this.edit(() => this.addConstraint('symmetric', [pts[0], pts[1], lines[0]]), opts);
        }
        break;
      default:
        break;
    }
    if (done) this.sel.clear();
    this.draw();
  }

  /** Auto constraints for a freshly drawn line. */
  _autoLineConstraints(lineId, hint) {
    if (hint === 'h') this.addConstraint('horizontal', [lineId]);
    if (hint === 'v') this.addConstraint('vertical', [lineId]);
  }

  // --------------------------------------------------------------- picking

  hitTest(sx, sy, { pointsOnly = false, exclude = null } = {}) {
    if (!pointsOnly) {
      for (const r of this.dimRects) if (inRect(sx, sy, r)) return { kind: 'dimension', id: r.id };
      for (const r of this.glyphRects) if (inRect(sx, sy, r)) return { kind: 'constraint', id: r.id };
    }
    let best = null;
    let bestD = 7;
    for (const p of this.sk.points) {
      if (exclude && exclude.has(p.id)) continue;
      const [x, y] = this.toScreen(p.x, p.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestD) { bestD = d; best = { kind: 'point', id: p.id }; }
    }
    if (best || pointsOnly) return best;
    bestD = 6;
    for (const e of this.sk.entities) {
      const d = this._distToEntity(e, sx, sy);
      if (d < bestD) { bestD = d; best = { kind: e.type, id: e.id }; }
    }
    return best;
  }

  _distToEntity(e, sx, sy) {
    if (e.type === 'line') {
      const a = this.P(e.p1);
      const b = this.P(e.p2);
      return segDist([sx, sy], this.toScreen(a.x, a.y), this.toScreen(b.x, b.y));
    }
    const c = this.P(e.c);
    const [cx, cy] = this.toScreen(c.x, c.y);
    const r = this.radius(e) * this.scale;
    const d = Math.abs(Math.hypot(sx - cx, sy - cy) - r);
    if (e.type === 'circle') return d;
    const [a0, a1] = this.arcAngles(e);
    let a = Math.atan2(-(sy - cy), sx - cx);
    while (a < a0) a += 2 * Math.PI;
    return a <= a1 ? d : Infinity;
  }

  /** Snap a screen position for drawing: existing point, else grid. Returns {x, y, id?}. */
  snap(sx, sy, exclude) {
    const hit = this.hitTest(sx, sy, { pointsOnly: true, exclude });
    if (hit) { const p = this.P(hit.id); return { x: p.x, y: p.y, id: p.id }; }
    let [x, y] = this.toModel(sx, sy);
    if (this.snapGrid) { const g = this.gridStep(); x = Math.round(x / g) * g; y = Math.round(y / g) * g; }
    x = round(x);
    y = round(y);
    // a grid position that lands on an existing point reuses it (no duplicate, overlapping points)
    const tol = 0.5 / this.scale;
    const same = this.sk.points.find((p) => (!exclude || !exclude.has(p.id)) && Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol);
    if (same) return { x: same.x, y: same.y, id: same.id };
    return { x, y };
  }

  /** H/V inference relative to a base point. */
  infer(base, s) {
    if (s.id) return { ...s, hint: null };
    const b = this.P(base);
    const dx = s.x - b.x;
    const dy = s.y - b.y;
    const tol = 4 / this.scale;
    if (Math.abs(dy) < Math.max(tol, Math.abs(dx) * 0.05) && Math.abs(dx) > tol) return { x: s.x, y: b.y, hint: 'h' };
    if (Math.abs(dx) < Math.max(tol, Math.abs(dy) * 0.05) && Math.abs(dy) > tol) return { x: b.x, y: s.y, hint: 'v' };
    return { ...s, hint: null };
  }

  pid(s) { return s.id || this.addPoint(s.x, s.y); }

  // ---------------------------------------------------------------- events

  _bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('dblclick', (e) => this._dbl(e));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this._pos(e);
      const before = this.toModel(sx, sy);
      this.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const after = this.toModel(sx, sy);
      this.cx += before[0] - after[0];
      this.cy += before[1] - after[1];
      this._syncCamera();
      this.draw();
    }, { passive: false });
    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey, true);
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _down(e) {
    if (this.popup) return;
    const [sx, sy] = this._pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.press = { sx, sy, button: e.button, moved: false, shift: e.shiftKey || e.ctrlKey || e.metaKey };
    if (e.button === 1 || e.button === 2) { this.press.pan = { cx: this.cx, cy: this.cy }; return; }
    if (this.tool !== 'select') return;
    const hit = this.hitTest(sx, sy);
    this.press.hit = hit;
    if (hit && hit.kind === 'dimension') {
      this.press.dragDim = hit.id;
    } else if (hit && ['point', 'line', 'circle', 'arc'].includes(hit.kind) && !(hit.kind === 'point' && hit.id === ORIGIN)) {
      this.press.drag = { hit, start: this.toModel(sx, sy), snap: this._snapshot(), last: this._snapshot() };
    }
  }

  _move(e) {
    const [sx, sy] = this._pos(e);
    this.mouse = [sx, sy];
    const pr = this.press;
    if (pr) {
      if (Math.hypot(sx - pr.sx, sy - pr.sy) > 3) pr.moved = true;
      if (pr.pan) {
        this.cx = pr.pan.cx - (sx - pr.sx) / this.scale;
        this.cy = pr.pan.cy + (sy - pr.sy) / this.scale;
        this._syncCamera();
        this.draw();
        return;
      }
      if (pr.moved && pr.dragDim) { this._dragDimension(pr.dragDim, this.toModel(sx, sy)); return; }
      if (pr.moved && pr.drag) { this._dragGeometry(pr.drag, this.toModel(sx, sy)); return; }
      if (pr.moved && this.tool === 'select' && !pr.hit) { pr.box = [pr.sx, pr.sy, sx, sy]; this.draw(); return; }
    }
    const h = this.tool === 'select' || this.tool === 'dimension' ? this.hitTest(sx, sy) : this.hitTest(sx, sy, { pointsOnly: true });
    this.hover = h;
    if (this.tool === 'arc' && this.ts.c && this.ts.start) this._trackSweep(sx, sy);
    this.draw();
  }

  _up(e) {
    const pr = this.press;
    this.press = null;
    if (!pr) return;
    const [sx, sy] = this._pos(e);
    if (pr.pan) {
      if (!pr.moved && pr.button === 2) this._cancelTool();
      return;
    }
    if (pr.button !== 0) return;
    if (pr.drag && pr.moved) { this._endDrag(pr.drag); return; }
    if (pr.dragDim && pr.moved) { this.undoStack.push(pr.dragDimSnap || this._snapshot()); this.onChange(this); return; }
    if (pr.box) { this._boxSelect(pr.box, pr.shift); return; }
    if (pr.moved) return;
    this._click(sx, sy, pr.shift);
  }

  _dbl(e) {
    const [sx, sy] = this._pos(e);
    const hit = this.hitTest(sx, sy);
    if (hit && hit.kind === 'dimension') this.editDimension(hit.id, sx, sy);
    else if (this.tool === 'line') this._cancelTool();
  }

  _key(e) {
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
      if (e.key === 'Escape' && this.popup) { e.preventDefault(); this._closePopup(); }
      return;
    }
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (mod && k === 'z') this[e.shiftKey ? 'redo' : 'undo']();
    else if (mod && k === 'y') this.redo();
    else if (mod) handled = false;
    else if (e.key === 'Escape') { if (this.tool !== 'select' || Object.keys(this.ts).length) this._cancelTool(true); else this.sel.clear(); this.draw(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
    else if (k === 'l') this.setTool('line');
    else if (k === 'r') this.setTool('rect');
    else if (k === 'c') this.setTool('circle');
    else if (k === 'a') this.setTool('arc');
    else if (k === 'p') this.setTool('point');
    else if (k === 'd') this.setTool('dimension');
    else if (k === 's') this.setTool('select');
    else if (k === 'x') this.toggleConstruction();
    else if (k === 'h') this.applyConstraint('horizontal');
    else if (k === 'v') this.applyConstraint('vertical');
    else if (k === 'f') this.fit();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  setTool(t) {
    this._cancelTool(false);
    this.tool = t;
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.draw();
    this.onChange(this);
  }

  _cancelTool(toSelect = false) {
    // a chain in progress is finished; incomplete shapes are discarded
    this.ts = {};
    this._closePopup();
    if (toSelect) this.setTool('select');
    this.draw();
  }

  _click(sx, sy, shift) {
    switch (this.tool) {
      case 'select': {
        const hit = this.hitTest(sx, sy);
        if (!hit) { if (!shift) this.sel.clear(); break; }
        const id = hit.id;
        if (shift) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); } else { this.sel.clear(); this.sel.add(id); }
        break;
      }
      case 'line': return this._lineClick(sx, sy);
      case 'rect': return this._rectClick(sx, sy);
      case 'circle': return this._circleClick(sx, sy);
      case 'arc': return this._arcClick(sx, sy);
      case 'point': {
        const s = this.snap(sx, sy);
        if (s.id) return;
        this.edit(() => { const id = this.addPoint(s.x, s.y); this.P(id).free = true; });
        break;
      }
      case 'dimension': return this._dimClick(sx, sy);
      default: break;
    }
    this.draw();
    this.onChange(this);
  }

  _lineClick(sx, sy) {
    const ts = this.ts;
    if (!ts.startPos) {
      const s0 = this.snap(sx, sy);
      this.ts = { startPos: s0, start: s0.id || null, chainStart: s0.id || null };
      this.draw();
      return;
    }
    const s0 = this.snap(sx, sy, ts.start ? new Set([ts.start]) : null);
    const s = ts.start ? this.infer(ts.start, s0) : this._inferPos(ts.startPos, s0);
    if (!s.id && Math.hypot(s.x - ts.startPos.x, s.y - ts.startPos.y) < 1e-9) return;
    let a = null;
    let b = null;
    const make = (hint) => () => {
      a = ts.start || this.addPoint(ts.startPos.x, ts.startPos.y);
      b = s.id || this.addPoint(s.x, s.y);
      if (a === b) return;
      const lid = this.newId('e');
      this.sk.entities.push({ id: lid, type: 'line', p1: a, p2: b, construction: false });
      this._autoLineConstraints(lid, hint);
    };
    // an inferred horizontal/vertical constraint may conflict with existing ones: retry without it
    const ok = this.edit(make(s.hint), { silent: true }) || (s.hint && this.edit(make(null)));
    if (!ok || a === b) return;
    if (s.id) {
      this.ts = {}; // connected to existing geometry (or closed the chain): finish
    } else {
      const p = this.P(b);
      this.ts = { start: b, startPos: { x: p.x, y: p.y, id: b }, chainStart: ts.chainStart || a };
    }
    this.draw();
  }

  _rectClick(sx, sy) {
    const s = this.snap(sx, sy);
    if (!this.ts.a) { this.ts.a = s; this.draw(); return; }
    const a = this.ts.a;
    if (Math.abs(s.x - a.x) < 1e-9 || Math.abs(s.y - a.y) < 1e-9) return;
    this.edit(() => {
      const p1 = a.id || this.addPoint(a.x, a.y);
      const p2 = this.addPoint(s.x, a.y);
      const p3 = s.id || this.addPoint(s.x, s.y);
      const p4 = this.addPoint(a.x, s.y);
      const L = (u, v) => { const id = this.newId('e'); this.sk.entities.push({ id, type: 'line', p1: u, p2: v, construction: false }); return id; };
      const l1 = L(p1, p2);
      const l2 = L(p2, p3);
      const l3 = L(p3, p4);
      const l4 = L(p4, p1);
      this.addConstraint('horizontal', [l1]);
      this.addConstraint('horizontal', [l3]);
      this.addConstraint('vertical', [l2]);
      this.addConstraint('vertical', [l4]);
    });
    this.ts = {};
    this.draw();
  }

  _circleClick(sx, sy) {
    if (!this.ts.c) { this.ts.c = this.snap(sx, sy); this.draw(); return; }
    const c = this.ts.c;
    const s = this.snap(sx, sy, c.id ? new Set([c.id]) : null);
    const r = Math.hypot(s.x - c.x, s.y - c.y);
    if (r < 1e-9) return;
    this.edit(() => {
      const cid = c.id || this.addPoint(c.x, c.y);
      const id = this.newId('e');
      this.sk.entities.push({ id, type: 'circle', c: cid, r: round(r), construction: false });
      if (s.id) this.addConstraint('pointOnCircle', [s.id, id]);
    });
    this.ts = {};
    this.draw();
  }

  _arcClick(sx, sy) {
    const ts = this.ts;
    if (!ts.c) { ts.c = this.snap(sx, sy); this.draw(); return; }
    if (!ts.start) {
      const s = this.snap(sx, sy, ts.c.id ? new Set([ts.c.id]) : null);
      if (Math.hypot(s.x - ts.c.x, s.y - ts.c.y) < 1e-9) return;
      ts.start = s;
      ts.sweep = 0;
      ts.lastAng = Math.atan2(s.y - ts.c.y, s.x - ts.c.x);
      this.draw();
      return;
    }
    const s = this.snap(sx, sy, new Set([ts.c.id, ts.start.id].filter(Boolean)));
    const r = Math.hypot(ts.start.x - ts.c.x, ts.start.y - ts.c.y);
    const ang = Math.atan2(s.y - ts.c.y, s.x - ts.c.x);
    const end = s.id ? s : { x: ts.c.x + r * Math.cos(ang), y: ts.c.y + r * Math.sin(ang) };
    this._trackSweep(...this.toScreen(end.x, end.y));
    if (Math.abs(ts.sweep) < 1e-6) return;
    const ccw = ts.sweep > 0;
    this.edit(() => {
      const c = ts.c.id || this.addPoint(ts.c.x, ts.c.y);
      const a = ts.start.id || this.addPoint(ts.start.x, ts.start.y);
      const b = end.id || this.addPoint(end.x, end.y);
      this.sk.entities.push({ id: this.newId('e'), type: 'arc', c, p1: ccw ? a : b, p2: ccw ? b : a, construction: false });
    });
    this.ts = {};
    this.draw();
  }

  _trackSweep(sx, sy) {
    const ts = this.ts;
    const [mx, my] = this.toModel(sx, sy);
    const a = Math.atan2(my - ts.c.y, mx - ts.c.x);
    let d = a - ts.lastAng;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    ts.sweep += d;
    ts.lastAng = a;
  }

  // -------------------------------------------------------------- dragging

  _dragGeometry(drag, [mx, my]) {
    const { hit, start } = drag;
    this._restore(drag.snap);
    const dx = mx - start[0];
    const dy = my - start[1];
    const dragged = [];
    if (hit.kind === 'point') {
      const p = this.P(hit.id);
      const [gx, gy] = this.snapGrid ? this._gridSnap(p.x + dx, p.y + dy) : [p.x + dx, p.y + dy];
      p.x = gx; p.y = gy;
      dragged.push(p.id);
    } else if (hit.kind === 'line') {
      const e = this.E(hit.id);
      for (const id of [e.p1, e.p2]) { if (id === ORIGIN) continue; const p = this.P(id); p.x += dx; p.y += dy; dragged.push(id); }
    } else if (hit.kind === 'circle') {
      const e = this.E(hit.id);
      const c = this.P(e.c);
      e.r = Math.max(1e-6, Math.hypot(mx - c.x, my - c.y));
      dragged.push(`r:${e.id}`);
    } else if (hit.kind === 'arc') {
      const e = this.E(hit.id);
      const c = this.P(e.c);
      const r = Math.max(1e-6, Math.hypot(mx - c.x, my - c.y));
      for (const id of [e.p1, e.p2]) {
        const p = this.P(id);
        const a = Math.atan2(p.y - c.y, p.x - c.x);
        p.x = c.x + r * Math.cos(a); p.y = c.y + r * Math.sin(a);
        dragged.push(id);
      }
    }
    const st = solve(this.sk, { dragged, analyze: false, maxIter: 30 });
    if (!st.ok) { this._restore(drag.last); } else { drag.last = this._snapshot(); }
    this.draw();
  }

  _gridSnap(x, y) {
    const g = this.gridStep();
    return [Math.round(x / g) * g, Math.round(y / g) * g];
  }

  _endDrag(drag) {
    this._restore(drag.last);
    this.undoStack.push(drag.snap);
    this.redoStack = [];
    this.status = solve(this.sk);
    this._changed();
  }

  _boxSelect([x0, y0, x1, y1], add) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const inside = (p) => { const [x, y] = this.toScreen(p.x, p.y); return x >= ax && x <= bx && y >= ay && y <= by; };
    if (!add) this.sel.clear();
    for (const e of this.sk.entities) {
      const pts = [e.p1, e.p2, e.c].filter(Boolean).map((id) => this.P(id));
      let ok = pts.every(inside);
      if (e.type === 'circle') {
        const c = this.P(e.c);
        ok = inside({ x: c.x - e.r, y: c.y - e.r }) && inside({ x: c.x + e.r, y: c.y + e.r });
      }
      if (ok) this.sel.add(e.id);
    }
    for (const p of this.sk.points) if (p.free && inside(p)) this.sel.add(p.id);
    this.draw();
    this.onChange(this);
  }

  _dragDimension(id, [mx, my]) {
    const c = this.K(id);
    if (!this.press.dragDimSnap) this.press.dragDimSnap = this._snapshot();
    const g = this._dimGeometry(c);
    if (!g) return;
    if (g.kind === 'linear') {
      c.offset = (mx - g.a[0]) * g.n[0] + (my - g.a[1]) * g.n[1];
    } else if (g.kind === 'radial') {
      c.angle = Math.atan2(my - g.c[1], mx - g.c[0]) * 180 / Math.PI;
    } else {
      c.offset = Math.hypot(mx - g.anchor[0], my - g.anchor[1]) * Math.sign((mx - g.anchor[0]) * g.n[0] + (my - g.anchor[1]) * g.n[1] || 1);
    }
    this.draw();
  }

  // ------------------------------------------------------------- dimensions

  _dimClick(sx, sy) {
    const hit = this.hitTest(sx, sy);
    if (hit && hit.kind === 'dimension') { this.editDimension(hit.id, sx, sy); return; }
    const first = this.ts.first;
    if (!first) {
      if (!hit || hit.kind === 'constraint') return;
      if (hit.kind === 'circle') return this._askDimension({ type: 'diameter', refs: [hit.id] }, sx, sy);
      if (hit.kind === 'arc') return this._askDimension({ type: 'radius', refs: [hit.id] }, sx, sy);
      this.ts.first = hit;
      this.sel.clear();
      this.sel.add(hit.id);
      this.draw();
      return;
    }
    if (!hit || hit.id === first.id) {
      if (first.kind === 'line') return this._askDimension({ type: 'length', refs: [first.id] }, sx, sy, ['length', 'hdistance', 'vdistance']);
      this.ts = {};
      this.sel.clear();
      this.draw();
      return;
    }
    const a = first;
    const b = hit;
    if (a.kind === 'point' && b.kind === 'point') {
      const p = this.P(a.id);
      const q = this.P(b.id);
      const t = Math.abs(q.y - p.y) < 1e-9 ? 'hdistance' : Math.abs(q.x - p.x) < 1e-9 ? 'vdistance' : 'distance';
      return this._askDimension({ type: t, refs: [a.id, b.id] }, sx, sy, ['distance', 'hdistance', 'vdistance']);
    }
    if ((a.kind === 'point' && b.kind === 'line') || (a.kind === 'line' && b.kind === 'point')) {
      const [p, l] = a.kind === 'point' ? [a.id, b.id] : [b.id, a.id];
      return this._askDimension({ type: 'pldistance', refs: [p, l] }, sx, sy);
    }
    if (a.kind === 'line' && b.kind === 'line') {
      const m = measure(this.sk, { type: 'angle', refs: [a.id, b.id] });
      if (m.value < 0.5 || m.value > 179.5) {
        return this._askDimension({ type: 'pldistance', refs: [this.E(b.id).p1, a.id] }, sx, sy);
      }
      return this._askDimension({ type: 'angle', refs: [a.id, b.id] }, sx, sy);
    }
    if (a.kind === 'point' && ['circle', 'arc'].includes(b.kind)) {
      return this._askDimension({ type: 'distance', refs: [a.id, this.E(b.id).c] }, sx, sy, ['distance', 'hdistance', 'vdistance']);
    }
    if (['circle', 'arc'].includes(a.kind) && ['circle', 'arc'].includes(b.kind)) {
      return this._askDimension({ type: 'distance', refs: [this.E(a.id).c, this.E(b.id).c] }, sx, sy, ['distance', 'hdistance', 'vdistance']);
    }
    this.flash('この組み合わせには寸法を付けられません');
    this.ts = {};
    this.sel.clear();
    this.draw();
  }

  _askDimension(c, sx, sy, alternatives = null) {
    this.ts = {};
    this.sel.clear();
    this._popup(sx, sy, {
      title: CONSTRAINT_LABELS[c.type],
      types: alternatives,
      type: c.type,
      value: (t) => this._initial({ ...c, type: t, refs: this._refsFor(c, t) }).value,
      onOk: (t, v) => {
        const refs = this._refsFor(c, t);
        const m = this._initial({ ...c, type: t, refs });
        const [mx, my] = this.toModel(sx, sy);
        const extra = { value: v, sign: m.sign ?? 1 };
        const g0 = this._dimGeometry({ type: t, refs, ...extra, offset: 0, angle: 45 });
        if (g0 && g0.kind === 'linear') extra.offset = (mx - g0.a[0]) * g0.n[0] + (my - g0.a[1]) * g0.n[1];
        else if (g0 && g0.kind === 'radial') extra.angle = Math.atan2(my - g0.c[1], mx - g0.c[0]) * 180 / Math.PI;
        else extra.offset = 30 / this.scale;
        this.edit(() => this.addConstraint(t, refs, extra), {
          checkRedundant: true, message: 'この寸法は既存の拘束と矛盾します',
        });
      },
    });
  }

  _refsFor(c, t) {
    // a line length can also be dimensioned horizontally / vertically between its end points
    if (c.type === 'length' && t !== 'length') { const e = this.E(c.refs[0]); return [e.p1, e.p2]; }
    return c.refs;
  }

  _initial(c) {
    const m = measure(this.sk, c);
    return { value: round(m.value ?? 0, 6), sign: m.sign };
  }

  editDimension(id, sx, sy) {
    const c = this.K(id);
    if (!c) return;
    this._popup(sx, sy, {
      title: CONSTRAINT_LABELS[c.type],
      type: c.type,
      value: () => c.value,
      onOk: (_t, v) => this.setDimensionValue(id, v),
    });
  }

  setDimensionValue(id, v) {
    const c = this.K(id);
    if (!c || !(v > 0 || (c.type === 'angle' && v >= 0))) { this.flash('正の値を入力してください'); return false; }
    return this.edit(() => { this.K(id).value = v; }, { message: 'その値では拘束を満たす形状が作れません' });
  }

  _popup(sx, sy, { title, types, type, value, onOk }) {
    this._closePopup();
    const box = document.createElement('div');
    box.className = 'dim-popup';
    box.style.left = `${Math.min(sx + 12, this.w - 190)}px`;
    box.style.top = `${Math.min(sy + 12, this.h - 90)}px`;
    let cur = type;
    const head = document.createElement('div');
    head.className = 'dim-title';
    head.textContent = title;
    box.appendChild(head);
    let sel = null;
    if (types && types.length > 1) {
      sel = document.createElement('select');
      for (const t of types) sel.add(new Option(CONSTRAINT_LABELS[t] + (t === 'hdistance' ? ' (X)' : t === 'vdistance' ? ' (Y)' : ''), t, false, t === type));
      box.appendChild(sel);
    }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.inputMode = 'decimal';
    const fmt = (v) => String(round(v, 6));
    inp.value = fmt(value(cur));
    box.appendChild(inp);
    const hint = document.createElement('div');
    hint.className = 'dim-hint';
    hint.textContent = 'Enter で確定 / Esc で取消 (式も可: 20/2+5)';
    box.appendChild(hint);
    if (sel) sel.addEventListener('change', () => { cur = sel.value; inp.value = fmt(value(cur)); inp.focus(); inp.select(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = evalExpr(inp.value);
        if (v === null) { inp.classList.add('bad'); return; }
        this._closePopup();
        onOk(cur, v);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._closePopup();
      }
    });
    this.container.appendChild(box);
    this.popup = box;
    inp.focus();
    inp.select();
  }

  _closePopup() {
    if (this.popup) { this.popup.remove(); this.popup = null; }
  }

  // ---------------------------------------------------------------- render

  _colors() {
    const css = getComputedStyle(document.documentElement);
    const v = (n, d) => css.getPropertyValue(n).trim() || d;
    return {
      fixed: v('--sk-fixed', '#1f2933'), free: v('--sk-free', '#2f6fdb'), sel: '#ff7a00', hover: '#ffb055',
      cons: v('--sk-cons', '#7d8a99'), dim: v('--sk-dim', '#a33ea1'), grid: v('--sk-grid', 'rgba(120,130,145,0.18)'),
      region: 'rgba(47,111,219,0.10)', bad: v('--danger', '#c93a3a'), text: v('--text', '#1f2933'), bg: v('--panel', '#fff'),
    };
  }

  draw() {
    const g = this.canvas.getContext('2d');
    const C = this._colors();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    this.glyphRects = [];
    this.dimRects = [];
    const done = this.status ? constrainedSet(this.sk, this.status.fixed) : new Set();
    const colorOf = (id) => {
      if (this.sel.has(id)) return C.sel;
      if (this.hover && this.hover.id === id) return C.hover;
      return done.has(id) ? C.fixed : C.free;
    };

    // grid & axes
    const step = this.gridStep();
    const [x0, y1] = this.toModel(0, 0);
    const [x1, y0] = this.toModel(this.w, this.h);
    g.lineWidth = 1;
    g.strokeStyle = C.grid;
    g.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { const [sx] = this.toScreen(x, 0); g.moveTo(sx, 0); g.lineTo(sx, this.h); }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { const [, sy] = this.toScreen(0, y); g.moveTo(0, sy); g.lineTo(this.w, sy); }
    g.stroke();
    const [ox, oy] = this.toScreen(0, 0);
    g.setLineDash([6, 4]);
    g.strokeStyle = 'rgba(208,60,60,0.55)';
    g.beginPath(); g.moveTo(0, oy); g.lineTo(this.w, oy); g.stroke();
    g.strokeStyle = 'rgba(60,160,76,0.55)';
    g.beginPath(); g.moveTo(ox, 0); g.lineTo(ox, this.h); g.stroke();
    g.setLineDash([]);

    // closed profiles
    g.fillStyle = C.region;
    for (const r of this.regions) {
      g.beginPath();
      for (const loop of [r.outer, ...r.holes]) {
        loop.forEach(([x, y], i) => { const [sx, sy] = this.toScreen(x, y); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
        g.closePath();
      }
      g.fill('evenodd');
    }

    // entities
    for (const e of this.sk.entities) {
      g.strokeStyle = colorOf(e.id);
      g.lineWidth = this.sel.has(e.id) || (this.hover && this.hover.id === e.id) ? 2.5 : 1.6;
      g.setLineDash(e.construction ? [7, 4] : []);
      g.beginPath();
      if (e.type === 'line') {
        const a = this.P(e.p1);
        const b = this.P(e.p2);
        g.moveTo(...this.toScreen(a.x, a.y));
        g.lineTo(...this.toScreen(b.x, b.y));
      } else {
        const c = this.P(e.c);
        const [cx, cy] = this.toScreen(c.x, c.y);
        const r = this.radius(e) * this.scale;
        if (e.type === 'circle') g.arc(cx, cy, r, 0, Math.PI * 2);
        else { const [a0, a1] = this.arcAngles(e); g.arc(cx, cy, r, -a0, -a1, true); }
      }
      g.stroke();
    }
    g.setLineDash([]);

    // points
    const usedAsCenter = new Set(this.sk.entities.filter((e) => e.c).map((e) => e.c));
    for (const p of this.sk.points) {
      const [sx, sy] = this.toScreen(p.x, p.y);
      g.fillStyle = colorOf(p.id);
      if (p.id === ORIGIN) {
        g.beginPath(); g.arc(sx, sy, 4, 0, Math.PI * 2); g.fill();
        continue;
      }
      const s = this.sel.has(p.id) || (this.hover && this.hover.id === p.id) ? 4 : usedAsCenter.has(p.id) ? 2.5 : 3;
      g.fillRect(sx - s, sy - s, 2 * s, 2 * s);
    }

    this._drawConstraints(g, C);
    this._drawDimensions(g, C);
    this._drawToolPreview(g, C);

    if (this.press && this.press.box) {
      const [a, b, c, d] = this.press.box;
      g.strokeStyle = C.sel;
      g.setLineDash([4, 3]);
      g.strokeRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
      g.setLineDash([]);
    }

    // status line
    const msg = this.message || (this.status && !this.status.ok ? '拘束を満たせません' : '');
    if (msg) {
      g.font = '13px system-ui, sans-serif';
      const w = g.measureText(msg).width + 20;
      g.fillStyle = this.message ? 'rgba(201,58,58,0.95)' : C.bad;
      roundRect(g, this.w / 2 - w / 2, this.h - 44, w, 26, 6);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(msg, this.w / 2 - w / 2 + 10, this.h - 26);
    }
  }

  _drawConstraints(g, C) {
    const slots = new Map();
    const place = (key, x, y, nx = 0, ny = -1) => {
      const n = slots.get(key) || 0;
      slots.set(key, n + 1);
      return [x + nx * 14 + n * 16, y + ny * 14];
    };
    const mid = (l) => {
      const a = this.P(l.p1);
      const b = this.P(l.p2);
      const [ax, ay] = this.toScreen(a.x, a.y);
      const [bx, by] = this.toScreen(b.x, b.y);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      return [(ax + bx) / 2, (ay + by) / 2, -(by - ay) / len, (bx - ax) / len];
    };
    const anchorEntity = (id) => {
      const e = this.E(id);
      if (!e) return null;
      if (e.type === 'line') return mid(e);
      const c = this.P(e.c);
      const r = this.radius(e);
      let a = Math.PI / 4;
      if (e.type === 'arc') { const [a0, a1] = this.arcAngles(e); a = (a0 + a1) / 2; }
      const [sx, sy] = this.toScreen(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
      return [sx, sy, Math.cos(a), -Math.sin(a)];
    };
    const anchorPoint = (id) => { const p = this.P(id); const [sx, sy] = this.toScreen(p.x, p.y); return [sx, sy, 0.7, -0.7]; };
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const c of this.sk.constraints) {
      if (DIMENSION_TYPES.has(c.type)) continue;
      const glyph = GLYPH[c.type] || '?';
      let anchors = [];
      if (['parallel', 'perpendicular', 'equal', 'tangent'].includes(c.type)) anchors = c.refs.map((id) => [id, anchorEntity(id)]);
      else if (['horizontal', 'vertical'].includes(c.type)) {
        if (this.E(c.refs[0])) anchors = [[c.refs[0], anchorEntity(c.refs[0])]];
        else anchors = c.refs.map((id) => [id, anchorPoint(id)]);
      } else anchors = [[c.refs[0], anchorPoint(c.refs[0])]];
      for (const [key, an] of anchors) {
        if (!an) continue;
        const [x, y] = place(key, an[0], an[1], an[2], an[3]);
        const active = this.sel.has(c.id) || (this.hover && this.hover.id === c.id);
        g.fillStyle = active ? C.sel : C.bg;
        g.strokeStyle = active ? C.sel : C.cons;
        roundRect(g, x - 7, y - 7, 14, 14, 3);
        g.fill();
        g.stroke();
        g.fillStyle = active ? '#fff' : C.cons;
        g.fillText(glyph, x, y + 0.5);
        this.glyphRects.push({ id: c.id, x: x - 7, y: y - 7, w: 14, h: 14 });
      }
    }
    g.textAlign = 'start';
    g.textBaseline = 'alphabetic';
  }

  /** Screen-space geometry of a dimension. */
  _dimGeometry(c) {
    const P = (id) => { const p = this.P(id); return p ? [p.x, p.y] : null; };
    const r = c.refs;
    if (['distance', 'hdistance', 'vdistance', 'length'].includes(c.type)) {
      let a;
      let b;
      if (c.type === 'length') { const e = this.E(r[0]); if (!e) return null; a = P(e.p1); b = P(e.p2); } else { a = P(r[0]); b = P(r[1]); }
      if (!a || !b) return null;
      let u = c.type === 'hdistance' ? [1, 0] : c.type === 'vdistance' ? [0, 1] : [b[0] - a[0], b[1] - a[1]];
      const l = Math.hypot(u[0], u[1]) || 1;
      u = [u[0] / l, u[1] / l];
      const n = [-u[1], u[0]];
      return { kind: 'linear', a, b, u, n };
    }
    if (c.type === 'pldistance') {
      const p = P(r[0]);
      const e = this.E(r[1]);
      if (!p || !e) return null;
      const a = P(e.p1);
      const b = P(e.p2);
      let u = [b[0] - a[0], b[1] - a[1]];
      const l = Math.hypot(u[0], u[1]) || 1;
      u = [u[0] / l, u[1] / l];
      const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
      const foot = [a[0] + u[0] * t, a[1] + u[1] * t];
      const nn = [p[0] - foot[0], p[1] - foot[1]];
      const nl = Math.hypot(nn[0], nn[1]) || 1;
      return { kind: 'linear', a: foot, b: p, u: [nn[0] / nl, nn[1] / nl], n: [-nn[1] / nl, nn[0] / nl] };
    }
    if (c.type === 'radius' || c.type === 'diameter') {
      const e = this.E(r[0]);
      if (!e) return null;
      return { kind: 'radial', c: P(e.c), r: this.radius(e) };
    }
    if (c.type === 'angle') {
      const l1 = this.E(r[0]);
      const l2 = this.E(r[1]);
      if (!l1 || !l2) return null;
      const a1 = P(l1.p1); const b1 = P(l1.p2); const a2 = P(l2.p1); const b2 = P(l2.p2);
      const d1 = [b1[0] - a1[0], b1[1] - a1[1]];
      const d2 = [b2[0] - a2[0], b2[1] - a2[1]];
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      let anchor;
      if (Math.abs(den) > 1e-12) {
        const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den;
        anchor = [a1[0] + d1[0] * t, a1[1] + d1[1] * t];
      } else anchor = [(a1[0] + b2[0]) / 2, (a1[1] + b2[1]) / 2];
      const l1n = Math.hypot(...d1) || 1;
      const l2n = Math.hypot(...d2) || 1;
      const bis = [d1[0] / l1n + d2[0] / l2n, d1[1] / l1n + d2[1] / l2n];
      const bl = Math.hypot(...bis) || 1;
      return { kind: 'angular', anchor, n: [bis[0] / bl, bis[1] / bl], d1: [d1[0] / l1n, d1[1] / l1n], d2: [d2[0] / l2n, d2[1] / l2n] };
    }
    return null;
  }

  _drawDimensions(g, C) {
    g.font = '12px system-ui, sans-serif';
    for (const c of this.sk.constraints) {
      if (!DIMENSION_TYPES.has(c.type)) continue;
      const geo = this._dimGeometry(c);
      if (!geo) continue;
      const active = this.sel.has(c.id) || (this.hover && this.hover.id === c.id);
      const col = active ? C.sel : C.dim;
      g.strokeStyle = col;
      g.fillStyle = col;
      g.lineWidth = 1;
      let label;
      let lx;
      let ly;
      if (geo.kind === 'linear') {
        const off = c.offset ?? 20 / this.scale;
        const { a, b, n } = geo;
        const a2 = [a[0] + n[0] * off, a[1] + n[1] * off];
        const db = (a[0] - b[0]) * n[0] + (a[1] - b[1]) * n[1];
        const b2 = [b[0] + n[0] * (off + db), b[1] + n[1] * (off + db)];
        const [sa, sa2, sb, sb2] = [a, a2, b, b2].map((p) => this.toScreen(p[0], p[1]));
        g.beginPath();
        g.moveTo(...sa); g.lineTo(...extend(sa, sa2, 4));
        g.moveTo(...sb); g.lineTo(...extend(sb, sb2, 4));
        g.moveTo(...sa2); g.lineTo(...sb2);
        g.stroke();
        arrow(g, sb2, sa2);
        arrow(g, sa2, sb2);
        [lx, ly] = [(sa2[0] + sb2[0]) / 2, (sa2[1] + sb2[1]) / 2];
        label = fmtNum(c.value);
      } else if (geo.kind === 'radial') {
        const ang = ((c.angle ?? 45) * Math.PI) / 180;
        const { c: ctr, r } = geo;
        const q = [ctr[0] + r * Math.cos(ang), ctr[1] + r * Math.sin(ang)];
        const sc = this.toScreen(...ctr);
        const sq = this.toScreen(...q);
        const out = extend(sc, sq, 24);
        g.beginPath();
        if (c.type === 'diameter') { const q2 = this.toScreen(ctr[0] - r * Math.cos(ang), ctr[1] - r * Math.sin(ang)); g.moveTo(...q2); arrow(g, sq, q2); } else g.moveTo(...sc);
        g.lineTo(...out);
        g.stroke();
        arrow(g, sc, sq);
        [lx, ly] = out;
        label = (c.type === 'diameter' ? '⌀' : 'R') + fmtNum(c.value);
      } else {
        const off = c.offset ?? 30 / this.scale;
        const { anchor, n } = geo;
        const p = [anchor[0] + n[0] * off, anchor[1] + n[1] * off];
        [lx, ly] = this.toScreen(...p);
        const sa = this.toScreen(...anchor);
        g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(...sa); g.lineTo(lx, ly); g.stroke();
        g.setLineDash([]);
        label = `${fmtNum(c.value)}°`;
      }
      const w = g.measureText(label).width + 8;
      g.fillStyle = C.bg;
      roundRect(g, lx - w / 2, ly - 9, w, 18, 4);
      g.fill();
      g.strokeStyle = col;
      g.stroke();
      g.fillStyle = col;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, lx, ly + 0.5);
      g.textAlign = 'start';
      g.textBaseline = 'alphabetic';
      this.dimRects.push({ id: c.id, x: lx - w / 2, y: ly - 9, w, h: 18 });
    }
  }

  _drawToolPreview(g, C) {
    if (!this.mouse) return;
    const [mx, my] = this.mouse;
    const ts = this.ts;
    g.strokeStyle = C.free;
    g.lineWidth = 1.4;
    g.setLineDash([5, 4]);
    const snapMark = (s) => {
      if (!s) return;
      const [x, y] = this.toScreen(s.x, s.y);
      g.save();
      g.setLineDash([]);
      g.strokeStyle = s.id ? C.sel : C.free;
      g.beginPath(); g.arc(x, y, s.id ? 6 : 3, 0, Math.PI * 2); g.stroke();
      g.restore();
    };
    if (this.tool === 'line') {
      const base = ts.startPos;
      let s = this.snap(mx, my, ts.start ? new Set([ts.start]) : null);
      if (base) {
        if (ts.start) s = this.infer(ts.start, s);
        else s = this._inferPos(base, s);
        g.beginPath(); g.moveTo(...this.toScreen(base.x, base.y)); g.lineTo(...this.toScreen(s.x, s.y)); g.stroke();
        const len = Math.hypot(s.x - base.x, s.y - base.y);
        this._tipText(g, `${fmtNum(len)}${s.hint === 'h' ? '  ━' : s.hint === 'v' ? '  ┃' : ''}`);
      }
      snapMark(s);
    } else if (this.tool === 'rect') {
      const s = this.snap(mx, my);
      if (ts.a) {
        const [ax, ay] = this.toScreen(ts.a.x, ts.a.y);
        const [bx, by] = this.toScreen(s.x, s.y);
        g.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
        this._tipText(g, `${fmtNum(Math.abs(s.x - ts.a.x))} × ${fmtNum(Math.abs(s.y - ts.a.y))}`);
      }
      snapMark(s);
    } else if (this.tool === 'circle') {
      const s = this.snap(mx, my);
      if (ts.c) {
        const r = Math.hypot(s.x - ts.c.x, s.y - ts.c.y);
        g.beginPath(); g.arc(...this.toScreen(ts.c.x, ts.c.y), r * this.scale, 0, Math.PI * 2); g.stroke();
        this._tipText(g, `R ${fmtNum(r)}`);
      }
      snapMark(s);
    } else if (this.tool === 'arc') {
      const s = this.snap(mx, my);
      if (ts.c && !ts.start) {
        g.beginPath(); g.moveTo(...this.toScreen(ts.c.x, ts.c.y)); g.lineTo(...this.toScreen(s.x, s.y)); g.stroke();
      } else if (ts.c && ts.start) {
        const r = Math.hypot(ts.start.x - ts.c.x, ts.start.y - ts.c.y);
        const a0 = Math.atan2(ts.start.y - ts.c.y, ts.start.x - ts.c.x);
        const [cx, cy] = this.toScreen(ts.c.x, ts.c.y);
        g.beginPath();
        g.arc(cx, cy, r * this.scale, -a0, -(a0 + ts.sweep), ts.sweep > 0);
        g.stroke();
      }
      snapMark(s);
    } else if (this.tool === 'point') {
      snapMark(this.snap(mx, my));
    }
    g.setLineDash([]);
  }

  _inferPos(base, s) {
    if (s.id) return s;
    const tol = 4 / this.scale;
    if (Math.abs(s.y - base.y) < tol && Math.abs(s.x - base.x) > tol) return { ...s, y: base.y, hint: 'h' };
    if (Math.abs(s.x - base.x) < tol && Math.abs(s.y - base.y) > tol) return { ...s, x: base.x, hint: 'v' };
    return s;
  }

  _tipText(g, text) {
    const [mx, my] = this.mouse;
    g.save();
    g.setLineDash([]);
    g.font = '11px system-ui, sans-serif';
    const w = g.measureText(text).width + 8;
    g.fillStyle = 'rgba(31,41,51,0.85)';
    roundRect(g, mx + 14, my + 10, w, 16, 3);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(text, mx + 18, my + 22);
    g.restore();
  }

  // ------------------------------------------------------------ panel data

  info() {
    const st = this.status || { ok: true, dof: 0 };
    const dims = this.sk.constraints.filter((c) => DIMENSION_TYPES.has(c.type));
    return {
      ok: st.ok,
      dof: st.dof,
      regions: this.regions.length,
      regionError: this.regionError,
      dims,
      selection: [...this.sel].map((id) => ({ id, kind: this.kind(id) })),
      tool: this.tool,
      hint: TOOL_HINTS[this.tool],
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }
}

// ------------------------------------------------------------------ helpers

function round(v, d = 9) {
  const f = Math.pow(10, d);
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function fmtNum(v) {
  if (v === undefined || v === null || !Number.isFinite(v)) return '?';
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

function inRect(x, y, r) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

function extend(from, to, px) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const l = Math.hypot(dx, dy) || 1;
  return [to[0] + (dx / l) * px, to[1] + (dy / l) * px];
}

function arrow(g, from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const s = 7;
  g.beginPath();
  g.moveTo(to[0], to[1]);
  g.lineTo(to[0] - ux * s - uy * s * 0.35, to[1] - uy * s + ux * s * 0.35);
  g.lineTo(to[0] - ux * s + uy * s * 0.35, to[1] - uy * s - ux * s * 0.35);
  g.closePath();
  g.fill();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Evaluate a simple arithmetic expression (numbers, + - * / and parentheses). */
export function evalExpr(s) {
  const src = String(s).trim();
  if (!src || !/^[\d\s+\-*/().eE]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const skip = () => { while (src[i] === ' ') i++; };
  const num = () => {
    skip();
    if (peek() === '(') { i++; const v = expr(); skip(); if (src[i] !== ')') throw new Error(); i++; return v; }
    if (peek() === '-') { i++; return -num(); }
    if (peek() === '+') { i++; return num(); }
    const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i)) || /^\d+\.?/.exec(src.slice(i));
    if (!m) throw new Error();
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = () => {
    let v = num();
    for (;;) { skip(); if (peek() === '*') { i++; v *= num(); } else if (peek() === '/') { i++; v /= num(); } else return v; }
  };
  const expr = () => {
    let v = term();
    for (;;) { skip(); if (peek() === '+') { i++; v += term(); } else if (peek() === '-') { i++; v -= term(); } else return v; }
  };
  try {
    const v = expr();
    skip();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
