// Minimal 2D polyline sketcher used for extrude (XY) and revolve (R-Z) profiles.
//   click empty space  : append a point
//   click on a segment : insert a point
//   drag a point       : move it
//   right-click point  : delete it
//   wheel              : zoom

export class Sketcher {
  constructor(container, { points = [], mode = 'xy', onChange = () => {} } = {}) {
    this.mode = mode; // 'xy' | 'rz'
    this.points = points.map((p) => [Number(p[0]), Number(p[1])]);
    this.onChange = onChange;
    this.snap = 1;
    this.drag = -1;
    this.hover = -1;

    const root = document.createElement('div');
    root.className = 'sketch';
    root.innerHTML = `
      <canvas></canvas>
      <div class="tools">
        グリッド <input type="number" class="snap" min="0" step="0.5" value="1">
        <button type="button" class="fit">全体</button>
        <button type="button" class="clear danger">クリア</button>
        <span style="flex:1"></span>
        <span class="pos"></span>
      </div>
      <textarea spellcheck="false" title="1行に1点 (${mode === 'rz' ? 'r, z' : 'x, y'})"></textarea>`;
    container.appendChild(root);
    this.canvas = root.querySelector('canvas');
    this.text = root.querySelector('textarea');
    this.posEl = root.querySelector('.pos');
    root.querySelector('.snap').addEventListener('input', (e) => { this.snap = Math.max(0, Number(e.target.value) || 0); });
    root.querySelector('.fit').addEventListener('click', () => { this.fit(); this.draw(); });
    root.querySelector('.clear').addEventListener('click', () => { this.points = []; this._changed(); });
    this.text.addEventListener('change', () => this._fromText());
    this._bind();
    new ResizeObserver(() => { this._size(); this.draw(); }).observe(this.canvas);
    this._size();
    this.fit();
    this._toText();
    this.draw();
  }

  _size() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(r.width, 50);
    this.h = Math.max(r.height, 50);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.dpr = dpr;
  }

  fit() {
    const pts = this.points.length ? this.points : [[-10, -10], [10, 10]];
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (this.mode === 'rz') x0 = Math.min(x0, 0);
    const span = Math.max(x1 - x0, y1 - y0, 1) * 1.4;
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.scale = Math.min(this.w, this.h) / span;
  }

  toScreen([x, y]) { return [this.w / 2 + (x - this.cx) * this.scale, this.h / 2 - (y - this.cy) * this.scale]; }
  toModel(sx, sy) { return [this.cx + (sx - this.w / 2) / this.scale, this.cy - (sy - this.h / 2) / this.scale]; }

  _snapPt([x, y]) {
    const s = this.snap;
    if (s > 0) { x = Math.round(x / s) * s; y = Math.round(y / s) * s; }
    if (this.mode === 'rz') x = Math.max(0, x);
    return [round(x), round(y)];
  }

  _event(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _pointAt(sx, sy) {
    for (let i = this.points.length - 1; i >= 0; i--) {
      const [px, py] = this.toScreen(this.points[i]);
      if (Math.hypot(px - sx, py - sy) < 8) return i;
    }
    return -1;
  }

  _segmentAt(sx, sy) {
    const n = this.points.length;
    if (n < 2) return -1;
    for (let i = 0; i < n; i++) {
      const a = this.toScreen(this.points[i]);
      const b = this.toScreen(this.points[(i + 1) % n]);
      if (segDist([sx, sy], a, b) < 5) return i;
    }
    return -1;
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const i = this._pointAt(...this._event(e));
      if (i >= 0) { this.points.splice(i, 1); this._changed(); }
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [sx, sy] = this._event(e);
      let i = this._pointAt(sx, sy);
      if (i < 0) {
        const seg = this._segmentAt(sx, sy);
        const p = this._snapPt(this.toModel(sx, sy));
        if (seg >= 0) { this.points.splice(seg + 1, 0, p); i = seg + 1; } else { this.points.push(p); i = this.points.length - 1; }
        this._changed(false);
      }
      this.drag = i;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const [sx, sy] = this._event(e);
      const m = this._snapPt(this.toModel(sx, sy));
      this.posEl.textContent = `${this.mode === 'rz' ? 'r' : 'x'}=${m[0]}  ${this.mode === 'rz' ? 'z' : 'y'}=${m[1]}`;
      if (this.drag >= 0) {
        this.points[this.drag] = m;
        this._changed(false);
      } else {
        const h = this._pointAt(sx, sy);
        if (h !== this.hover) { this.hover = h; this.draw(); }
      }
    });
    c.addEventListener('pointerup', () => {
      if (this.drag >= 0) { this.drag = -1; this._changed(); }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this._event(e);
      const before = this.toModel(sx, sy);
      this.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const after = this.toModel(sx, sy);
      this.cx += before[0] - after[0];
      this.cy += before[1] - after[1];
      this.draw();
    }, { passive: false });
  }

  _changed(commit = true) {
    this._toText();
    this.draw();
    this.onChange(this.points.map((p) => [...p]), commit);
  }

  _toText() { this.text.value = this.points.map((p) => `${p[0]}, ${p[1]}`).join('\n'); }

  _fromText() {
    const pts = [];
    for (const line of this.text.value.split('\n')) {
      const m = line.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (m.length >= 2 && m.every(Number.isFinite)) pts.push([m[0], m[1]]);
    }
    this.points = pts;
    this.fit();
    this._changed();
  }

  setPoints(points) {
    this.points = points.map((p) => [Number(p[0]), Number(p[1])]);
    this._toText();
    this.draw();
  }

  draw() {
    const g = this.canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--text').trim() || '#222';
    const muted = css.getPropertyValue('--border').trim() || '#ccc';
    const accent = css.getPropertyValue('--accent').trim() || '#2f6fdb';
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);

    // grid
    let step = this.snap > 0 ? this.snap : 1;
    while (step * this.scale < 8) step *= 5;
    const [mx0, my1] = this.toModel(0, 0);
    const [mx1, my0] = this.toModel(this.w, this.h);
    g.strokeStyle = muted;
    g.lineWidth = 0.5;
    g.beginPath();
    for (let x = Math.ceil(mx0 / step) * step; x <= mx1; x += step) { const [sx] = this.toScreen([x, 0]); g.moveTo(sx, 0); g.lineTo(sx, this.h); }
    for (let y = Math.ceil(my0 / step) * step; y <= my1; y += step) { const [, sy] = this.toScreen([0, y]); g.moveTo(0, sy); g.lineTo(this.w, sy); }
    g.stroke();

    // axes
    const [ox, oy] = this.toScreen([0, 0]);
    g.lineWidth = 1.2;
    g.strokeStyle = '#d03c3c';
    g.beginPath(); g.moveTo(0, oy); g.lineTo(this.w, oy); g.stroke();
    g.strokeStyle = this.mode === 'rz' ? '#3c6cd0' : '#3ca04c';
    g.beginPath(); g.moveTo(ox, 0); g.lineTo(ox, this.h); g.stroke();
    g.fillStyle = fg;
    g.font = '10px system-ui';
    g.fillText(this.mode === 'rz' ? 'r' : 'X', this.w - 10, oy - 4);
    g.fillText(this.mode === 'rz' ? 'Z (回転軸)' : 'Y', ox + 4, 10);
    if (this.mode === 'rz') {
      g.fillStyle = 'rgba(128,128,128,0.12)';
      g.fillRect(0, 0, Math.max(0, ox), this.h);
    }

    // profile
    const n = this.points.length;
    if (n) {
      g.strokeStyle = accent;
      g.fillStyle = accent + '22';
      g.lineWidth = 2;
      g.beginPath();
      this.points.forEach((p, i) => { const [sx, sy] = this.toScreen(p); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
      if (n > 2) g.closePath();
      g.fill();
      g.stroke();
      this.points.forEach((p, i) => {
        const [sx, sy] = this.toScreen(p);
        g.fillStyle = i === this.hover || i === this.drag ? '#ff8a00' : accent;
        g.beginPath(); g.arc(sx, sy, i === 0 ? 5 : 4, 0, Math.PI * 2); g.fill();
      });
    }
  }
}

function round(v) { return Math.round(v * 1e6) / 1e6; }

function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
