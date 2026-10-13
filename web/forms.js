// Feature schemas and the property-panel form renderer.
import { Sketcher } from './sketch.js';

const MODE_OPTS = [['new', '新規ボディ'], ['join', '結合 (和)'], ['cut', '切り取り (差)'], ['intersect', '交差 (積)']];
const PLANE_OPTS = [['XY', 'XY 平面 (上)'], ['XZ', 'XZ 平面 (正面)'], ['YZ', 'YZ 平面 (右)']];
const needsTarget = (p) => p.mode && p.mode !== 'new';

export const FEATURES = {
  box: {
    label: 'ボックス', icon: '▣', desc: '原点は最小コーナー。X/Y/Z 方向の寸法を指定します。',
    fields: [
      { k: 'origin', t: 'vec3', l: '原点 (最小コーナー)' },
      { k: 'length', t: 'num', l: '長さ (X)', min: 0 },
      { k: 'width', t: 'num', l: '幅 (Y)', min: 0 },
      { k: 'height', t: 'num', l: '高さ (Z)', min: 0 },
    ],
  },
  cylinder: {
    label: '円柱', icon: '⌭', desc: 'Z 軸方向の円柱。原点は底面の中心。',
    fields: [
      { k: 'origin', t: 'vec3', l: '底面中心' },
      { k: 'radius', t: 'num', l: '半径', min: 0 },
      { k: 'height', t: 'num', l: '高さ', min: 0 },
    ],
  },
  sphere: {
    label: '球', icon: '●',
    fields: [{ k: 'origin', t: 'vec3', l: '中心' }, { k: 'radius', t: 'num', l: '半径', min: 0 }],
  },
  cone: {
    label: '円錐', icon: '▲', desc: '上面半径 > 0 で円錐台になります。',
    fields: [
      { k: 'origin', t: 'vec3', l: '底面中心' },
      { k: 'radius_base', t: 'num', l: '底面半径', min: 0 },
      { k: 'radius_top', t: 'num', l: '上面半径', min: 0 },
      { k: 'height', t: 'num', l: '高さ', min: 0 },
    ],
  },
  torus: {
    label: 'トーラス', icon: '◎',
    fields: [
      { k: 'origin', t: 'vec3', l: '中心' },
      { k: 'radius_major', t: 'num', l: '主半径', min: 0 },
      { k: 'radius_minor', t: 'num', l: '管半径', min: 0 },
    ],
  },
  pyramid: {
    label: '角錐', icon: '△',
    fields: [
      { k: 'origin', t: 'vec3', l: '底面中心' },
      { k: 'length', t: 'num', l: '底辺', min: 0 },
      { k: 'height', t: 'num', l: '高さ', min: 0 },
    ],
  },
  extrude: {
    label: '押し出し', icon: '⇧', desc: '平面上の閉じたプロファイルを法線方向に押し出します。',
    fields: [
      { k: 'mode', t: 'select', l: '操作', opts: MODE_OPTS },
      { k: 'target', t: 'body', l: '対象ボディ', show: needsTarget },
      { k: 'plane', t: 'select', l: 'スケッチ平面', opts: PLANE_OPTS },
      { k: 'offset', t: 'num', l: '平面オフセット' },
      { k: 'profile', t: 'profile', l: 'プロファイル' },
      { k: 'distance', t: 'num', l: '距離 (負で逆方向)' },
      { k: 'symmetric', t: 'bool', l: '両側に対称' },
    ],
  },
  revolve: {
    label: '回転', icon: '↻', desc: 'R-Z 平面の閉じたプロファイルを Z 軸まわりに回転します。',
    fields: [
      { k: 'mode', t: 'select', l: '操作', opts: MODE_OPTS },
      { k: 'target', t: 'body', l: '対象ボディ', show: needsTarget },
      { k: 'points', t: 'sketch', l: 'プロファイル (r, z)', mode: 'rz' },
      { k: 'angle', t: 'num', l: '角度 (度)' },
    ],
  },
  fillet: {
    label: 'フィレット', icon: '◜', desc: 'ビューポートでエッジをクリックして選択します。',
    fields: [
      { k: 'target', t: 'body', l: 'ボディ' },
      { k: 'edges', t: 'edges', l: 'エッジ' },
      { k: 'radius', t: 'num', l: '半径', min: 0 },
    ],
  },
  chamfer: {
    label: '面取り', icon: '◸', desc: 'ビューポートでエッジをクリックして選択します。',
    fields: [
      { k: 'target', t: 'body', l: 'ボディ' },
      { k: 'edges', t: 'edges', l: 'エッジ' },
      { k: 'radius', t: 'num', l: '距離', min: 0 },
    ],
  },
  shell: {
    label: 'シェル', icon: '▢', desc: '取り除く面をクリックして選択し、内側に肉厚を付けます。',
    fields: [
      { k: 'target', t: 'body', l: 'ボディ' },
      { k: 'faces', t: 'faces', l: '開口面' },
      { k: 'thickness', t: 'num', l: '肉厚', min: 0 },
    ],
  },
  offset: {
    label: 'オフセット', icon: '⧈', desc: 'ボディ全体の面を法線方向にオフセットします (正: 太らせる / 負: 痩せさせる)。',
    fields: [
      { k: 'target', t: 'body', l: 'ボディ' },
      { k: 'distance', t: 'num', l: '距離' },
    ],
  },
  boolean: {
    label: '結合', icon: '⊕', desc: 'ターゲットにツールボディを和・差・積で結合します。',
    fields: [
      { k: 'op', t: 'select', l: '操作', opts: [['union', '和 (結合)'], ['difference', '差 (切り取り)'], ['intersection', '積 (交差)']] },
      { k: 'target', t: 'body', l: 'ターゲット' },
      { k: 'tool', t: 'body', l: 'ツール' },
      { k: 'keep_tool', t: 'bool', l: 'ツールボディを残す' },
    ],
  },
  transform: {
    label: '移動/回転', icon: '✥', desc: 'スケール → 回転 → 平行移動 の順に適用します。',
    fields: [
      { k: 'target', t: 'body', l: 'ボディ' },
      { k: 'translate', t: 'vec3', l: '平行移動' },
      { k: 'rotate_axis', t: 'vec3', l: '回転軸' },
      { k: 'rotate_deg', t: 'num', l: '回転角 (度)' },
      { k: 'pivot', t: 'vec3', l: '回転/スケール中心' },
      { k: 'scale', t: 'num', l: 'スケール', min: 0 },
      { k: 'copy', t: 'bool', l: 'コピーを作成' },
    ],
  },
  mirror: {
    label: 'ミラー', icon: '⇋',
    fields: [
      { k: 'target', t: 'body', l: 'ボディ' },
      { k: 'plane', t: 'select', l: 'ミラー平面', opts: [['YZ', 'YZ (X 反転)'], ['XZ', 'XZ (Y 反転)'], ['XY', 'XY (Z 反転)']] },
      { k: 'offset', t: 'num', l: '平面位置' },
      { k: 'merge', t: 'bool', l: '元ボディと結合 (オフで別ボディ)' },
    ],
  },
  pattern_linear: {
    label: '矩形状パターン', icon: '⋯',
    fields: [
      { k: 'target', t: 'body', l: 'ボディ' },
      { k: 'direction', t: 'vec3', l: '方向' },
      { k: 'spacing', t: 'num', l: '間隔' },
      { k: 'count', t: 'int', l: '個数', min: 1 },
    ],
  },
  pattern_circular: {
    label: '円形状パターン', icon: '✲',
    fields: [
      { k: 'target', t: 'body', l: 'ボディ' },
      { k: 'axis', t: 'vec3', l: '軸方向' },
      { k: 'center', t: 'vec3', l: '軸上の点' },
      { k: 'count', t: 'int', l: '個数', min: 1 },
      { k: 'angle', t: 'num', l: '角度範囲 (度)' },
    ],
  },
  delete_body: { label: 'ボディ削除', icon: '✕', fields: [{ k: 'target', t: 'body', l: 'ボディ' }] },
  import_usd: { label: 'インポート', icon: '⇩', desc: 'USD ファイルから読み込んだ BRep。', fields: [{ k: 'filename', t: 'text', l: 'ファイル', readonly: true }] },
};

const PROFILE_TYPES = {
  rectangle: { l: '長方形', fields: [['cx', '中心 X'], ['cy', '中心 Y'], ['width', '幅'], ['height', '高さ']], def: { cx: 0, cy: 0, width: 20, height: 10 } },
  circle: { l: '円', fields: [['cx', '中心 X'], ['cy', '中心 Y'], ['radius', '半径']], def: { cx: 0, cy: 0, radius: 10 } },
  polygon: { l: '正多角形', fields: [['cx', '中心 X'], ['cy', '中心 Y'], ['sides', '辺数'], ['radius', '外接円半径']], def: { cx: 0, cy: 0, sides: 6, radius: 10 } },
  polyline: { l: '自由形状 (スケッチ)', fields: [], def: { points: [[0, 0], [20, 0], [20, 10], [10, 16], [0, 10]] } },
};

/** Renders a feature's parameters and manages viewport pick targets. */
export class FeatureForm {
  constructor(el, { type, params, bodies, editing, onChange, onPickField }) {
    this.el = el;
    this.type = type;
    this.schema = FEATURES[type];
    this.params = structuredClone(params);
    this.bodies = bodies;
    this.editing = editing;
    this.onChange = onChange;
    this.onPickField = onPickField;
    this.active = null; // key of the active pick field
    const pickables = this.schema.fields.filter((f) => ['edges', 'faces'].includes(f.t));
    if (pickables.length) this.active = pickables[0].k;
    else {
      const emptyBody = this.schema.fields.find((f) => f.t === 'body' && !this.params[f.k] && (!f.show || f.show(this.params)));
      if (emptyBody) this.active = emptyBody.k;
    }
    this.render();
  }

  pickField() {
    const f = this.schema.fields.find((x) => x.k === this.active);
    return f && (!f.show || f.show(this.params)) ? f : null;
  }

  set(key, value, rerender = false) {
    this.params[key] = value;
    if (rerender) this.render();
    this.onChange(this.params);
  }

  render() {
    const el = this.el;
    el.innerHTML = '';
    for (const f of this.schema.fields) {
      if (f.show && !f.show(this.params)) continue;
      el.appendChild(this.renderField(f));
    }
    this.onPickField(this.pickField());
  }

  renderField(f) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = f.l;
    wrap.appendChild(label);
    const v = this.params[f.k];

    if (f.t === 'num' || f.t === 'int') {
      const inp = numInput(v, f.t === 'int' ? 1 : 'any', f.min);
      inp.addEventListener('input', () => { if (inp.value !== '' && Number.isFinite(+inp.value)) this.set(f.k, +inp.value); });
      wrap.appendChild(inp);
    } else if (f.t === 'text') {
      const inp = document.createElement('input');
      inp.value = v ?? '';
      inp.readOnly = !!f.readonly;
      wrap.appendChild(inp);
    } else if (f.t === 'vec3') {
      wrap.appendChild(vec3Input(v, (nv) => this.set(f.k, nv)));
    } else if (f.t === 'bool') {
      label.remove();
      const row = document.createElement('label');
      row.className = 'check';
      row.style.display = 'flex';
      row.style.gap = '6px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!v;
      cb.addEventListener('change', () => this.set(f.k, cb.checked));
      row.append(cb, document.createTextNode(f.l));
      wrap.appendChild(row);
    } else if (f.t === 'select') {
      const sel = document.createElement('select');
      for (const [val, text] of f.opts) sel.add(new Option(text, val, false, val === v));
      sel.addEventListener('change', () => this.set(f.k, sel.value, true));
      wrap.appendChild(sel);
    } else if (f.t === 'body') {
      const sel = document.createElement('select');
      sel.add(new Option('— ビューポートでクリック —', ''));
      for (const b of this.bodies) sel.add(new Option(b.name, b.id, false, b.id === v));
      if (v && !this.bodies.some((b) => b.id === v)) sel.add(new Option(`(存在しない: ${v})`, v, false, true));
      sel.addEventListener('focus', () => this.activate(f.k));
      sel.addEventListener('change', () => this.setBody(f.k, sel.value || null));
      if (this.active === f.k) sel.style.outline = '2px solid var(--accent)';
      wrap.appendChild(sel);
    } else if (f.t === 'edges' || f.t === 'faces') {
      const box = document.createElement('div');
      box.className = 'picklist' + (this.active === f.k ? ' active' : '');
      const refs = v || [];
      if (!refs.length) {
        const hint = document.createElement('span');
        hint.className = 'desc';
        hint.textContent = f.t === 'edges' ? 'エッジをクリック (再クリックで解除)' : '面をクリック (再クリックで解除)';
        box.appendChild(hint);
      }
      refs.forEach((r, i) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = `${f.t === 'edges' ? 'エッジ' : '面'} ${i + 1}`;
        chip.title = refPoint(r).map((c) => c.toFixed(2)).join(', ');
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.addEventListener('click', (e) => { e.stopPropagation(); this.removeRef(f.k, i); });
        chip.appendChild(x);
        box.appendChild(chip);
      });
      box.addEventListener('click', () => this.activate(f.k));
      wrap.appendChild(box);
    } else if (f.t === 'profile') {
      wrap.appendChild(this.renderProfile(v));
    } else if (f.t === 'sketch') {
      const holder = document.createElement('div');
      wrap.appendChild(holder);
      requestAnimationFrame(() => {
        this.sketcher = new Sketcher(holder, { points: v || [], mode: f.mode, onChange: (pts) => this.set(f.k, pts) });
      });
    }
    return wrap;
  }

  renderProfile(profile) {
    const box = document.createElement('div');
    box.className = 'sub-fields';
    const sel = document.createElement('select');
    for (const [k, def] of Object.entries(PROFILE_TYPES)) sel.add(new Option(def.l, k, false, k === profile.type));
    sel.addEventListener('change', () => {
      const prev = this.params.profile;
      const next = { type: sel.value, ...structuredClone(PROFILE_TYPES[sel.value].def) };
      for (const k of ['cx', 'cy']) if (k in prev && k in next) next[k] = prev[k];
      this.set('profile', next, true);
    });
    box.appendChild(sel);
    const def = PROFILE_TYPES[profile.type] || PROFILE_TYPES.rectangle;
    if (profile.type === 'polyline') {
      const holder = document.createElement('div');
      box.appendChild(holder);
      requestAnimationFrame(() => {
        this.sketcher = new Sketcher(holder, {
          points: profile.points || [], mode: 'xy',
          onChange: (pts) => this.set('profile', { ...this.params.profile, points: pts }),
        });
      });
    } else {
      const grid = document.createElement('div');
      grid.style.display = 'grid';
      grid.style.gridTemplateColumns = '1fr 1fr';
      grid.style.gap = '4px';
      for (const [k, l] of def.fields) {
        const f = document.createElement('div');
        f.className = 'field';
        const lab = document.createElement('label');
        lab.textContent = l;
        const inp = numInput(profile[k], k === 'sides' ? 1 : 'any');
        inp.addEventListener('input', () => {
          if (inp.value === '' || !Number.isFinite(+inp.value)) return;
          this.set('profile', { ...this.params.profile, [k]: +inp.value });
        });
        f.append(lab, inp);
        grid.appendChild(f);
      }
      box.appendChild(grid);
    }
    return box;
  }

  activate(key) {
    if (this.active === key) return;
    this.active = key;
    this.render();
  }

  setBody(key, id) {
    const prev = this.params[key];
    this.params[key] = id;
    // edge / face references belong to the target body
    if (key === 'target' && prev !== id) {
      for (const f of this.schema.fields) if (['edges', 'faces'].includes(f.t)) this.params[f.k] = [];
    }
    const next = this.schema.fields.find((f) => ['edges', 'faces'].includes(f.t))
      || this.schema.fields.find((f) => f.t === 'body' && !this.params[f.k] && (!f.show || f.show(this.params)));
    this.active = next ? next.k : null;
    this.render();
    this.onChange(this.params);
  }

  removeRef(key, i) {
    const refs = [...(this.params[key] || [])];
    refs.splice(i, 1);
    this.set(key, refs, true);
  }

  toggleRef(key, ref, sameAs) {
    const refs = [...(this.params[key] || [])];
    const i = refs.findIndex(sameAs);
    if (i >= 0) refs.splice(i, 1); else refs.push(ref);
    this.set(key, refs, true);
  }
}

export const PROFILE_LABELS = Object.fromEntries(Object.entries(PROFILE_TYPES).map(([k, v]) => [k, v.l]));

function numInput(v, step, min) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = step;
  if (min !== undefined) inp.min = min;
  inp.value = v ?? 0;
  return inp;
}

function vec3Input(v, onChange) {
  const box = document.createElement('div');
  box.className = 'vec3';
  const cur = [...(v || [0, 0, 0])];
  ['X', 'Y', 'Z'].forEach((axis, i) => {
    const span = document.createElement('span');
    span.dataset.axis = axis;
    const inp = numInput(cur[i], 'any');
    inp.addEventListener('input', () => {
      if (inp.value === '' || !Number.isFinite(+inp.value)) return;
      cur[i] = +inp.value;
      onChange([...cur]);
    });
    span.appendChild(inp);
    box.appendChild(span);
  });
  return box;
}

/** Point of a topological reference ({p, n} from the server, or a legacy [x, y, z]). */
export function refPoint(r) {
  return Array.isArray(r) ? r : r.p;
}

/** Profile outline (closed polyline) in the sketch plane's local XY. */
export function profileOutline(p) {
  const cx = +p.cx || 0;
  const cy = +p.cy || 0;
  if (p.type === 'rectangle') {
    const w = (+p.width || 0) / 2;
    const h = (+p.height || 0) / 2;
    return [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]];
  }
  if (p.type === 'circle' || p.type === 'polygon') {
    const n = p.type === 'circle' ? 64 : Math.max(3, Math.round(+p.sides || 3));
    const r = +p.radius || 0;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
  }
  return (p.points || []).map((q) => [+q[0], +q[1]]);
}

/** Map local sketch coordinates to world, matching cad3d.kernel.place_on_plane. */
export function sketchToWorld(plane, [x, y], z) {
  if (plane === 'XZ') return [x, -z, y];
  if (plane === 'YZ') return [z, x, y];
  return [x, y, z];
}
