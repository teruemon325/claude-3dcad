import { Viewer, regionContains } from './viewer.js';
import { FEATURES, FeatureForm, refPoint } from './forms.js';
import { SketchEditor, CONSTRAINT_LABELS, fmtNum } from './sketch/editor.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  doc: null,
  defaults: {},
  meshes: new Map(), // `${id}:${sig}` -> mesh
  selectedBody: null,
  form: null, // { type, featureId, form: FeatureForm, prevRollback, error }
  sketch: null, // { editor: SketchEditor, featureId, prevRollback }
  planePick: false,
  showEdges: true,
  xray: false,
};

// ------------------------------------------------------------------ API

let busyCount = 0;
function busy(delta) {
  busyCount += delta;
  $('#busy').hidden = busyCount <= 0;
}

async function api(method, path, body) {
  busy(1);
  try {
    const opts = { method, headers: {} };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(path, opts);
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw new Error((data && data.detail) || r.statusText);
    return data;
  } finally {
    busy(-1);
  }
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, err ? 6000 : 2500);
}

function status(msg) { $('#statusText').textContent = msg; }

// ------------------------------------------------------------- viewport

const viewer = new Viewer($('#viewport'), { onPick, onHover });

function onHover(hit) {
  $('#cursorPos').textContent = hit && hit.point ? hit.point.map((c) => c.toFixed(2)).join(', ') : '';
}

async function onPick(hit) {
  if (state.planePick) {
    if (hit && hit.kind === 'face') {
      try {
        const { plane } = await api('POST', '/api/pick/plane', { body: hit.body, point: hit.point });
        startSketch(plane);
      } catch (e) { toast(e.message, true); }
    }
    return;
  }
  const f = state.form;
  if (f && hit && hit.kind === 'profile') return pickProfile(f.form, hit);
  if (!f) {
    selectBody(hit && hit.body ? hit.body : null);
    return;
  }
  const field = f.form.pickField();
  if (!field || !hit || !hit.body) return;
  const form = f.form;
  try {
    if (field.t === 'body') {
      form.setBody(field.k, hit.body);
    } else if (field.t === 'edges' && hit.kind === 'edge') {
      if (form.params.target !== hit.body) form.setBody('target', hit.body);
      form.active = field.k;
      const { ref } = await api('POST', '/api/pick/edge', { body: hit.body, edge: hit.edge });
      form.toggleRef(field.k, ref, (r) => viewer.nearestEdge(hit.body, refPoint(r)) === hit.edge);
    } else if (field.t === 'faces' && hit.kind === 'face') {
      if (form.params.target !== hit.body) form.setBody('target', hit.body);
      form.active = field.k;
      const { face, ref } = await api('POST', '/api/pick/face', { body: hit.body, point: hit.point });
      const known = await faceIndices(hit.body, form.params[field.k] || []);
      const i = known.indexOf(face);
      const refs = [...(form.params[field.k] || [])];
      if (i >= 0) refs.splice(i, 1); else refs.push(ref);
      form.set(field.k, refs, true);
    }
  } catch (e) {
    toast(e.message, true);
  }
}

function pickProfile(form, hit) {
  const field = form.pickField();
  if (!('sketch' in form.params)) return;
  if (form.params.sketch !== hit.sketch) {
    form.params.sketch = hit.sketch;
    form.params.profiles = [];
  }
  if (!hit.point || !field || field.t !== 'profiles') { form.render(); form.onChange(form.params); return; }
  const sk = state.doc.sketches.find((s) => s.id === hit.sketch);
  const smallest = (q) => sk.regions.filter((r) => regionContains(r, q)).sort((a, b) => a.area - b.area)[0];
  const region = smallest(hit.point);
  const refs = [...(form.params.profiles || [])];
  const i = refs.findIndex((q) => smallest(q) === region);
  if (i >= 0) refs.splice(i, 1); else refs.push(region ? region.point : hit.point);
  form.set('profiles', refs, true);
}

async function faceIndices(body, refs) {
  const out = [];
  for (const r of refs) out.push((await api('POST', '/api/pick/face', { body, point: refPoint(r) })).face);
  return out;
}

function updatePickMode() {
  if (state.sketch) return;
  if (state.planePick) {
    viewer.setPickMode('plane');
    viewer.setProfileSelection(null);
    $('#viewHint').textContent = 'スケッチを作成する平らな面をクリック、または右のパネルで平面を選択';
    return;
  }
  const f = state.form && state.form.form ? state.form : null;
  const field = f && f.form.pickField();
  const p = f ? f.form.params : null;
  viewer.setProfileSelection(p && 'sketch' in p && p.sketch ? { sketch: p.sketch, points: p.profiles || [] } : null);
  if (field && field.t === 'profiles') {
    viewer.setPickMode('profile', null);
    $('#viewHint').textContent = 'スケッチの領域をクリックして選択 / 解除';
  } else if (!field) {
    viewer.setPickMode(f ? null : 'body');
    $('#viewHint').textContent = '';
  } else if (field.t === 'body') {
    viewer.setPickMode('body');
    $('#viewHint').textContent = `${field.l} をクリックして選択`;
  } else if (field.t === 'edges') {
    viewer.setPickMode('edge', f.form.params.target || null);
    $('#viewHint').textContent = 'エッジをクリックして選択 / 解除';
  } else if (field.t === 'faces') {
    viewer.setPickMode('face', f.form.params.target || null);
    $('#viewHint').textContent = '面をクリックして選択 / 解除';
  }
  updateOverlay();
}

function updateOverlay() {
  const f = state.form && state.form.form ? state.form : null;
  if (!f) {
    viewer.setSelection();
    viewer.setPreview();
    viewer.setSelectedBodies(state.selectedBody ? [state.selectedBody] : []);
    return;
  }
  const p = f.form.params;
  viewer.setSelectedBodies([p.target, p.tool].filter(Boolean));
  viewer.setSelection({ body: p.target, edgeRefs: (p.edges || []).map(refPoint), faceRefs: (p.faces || []).map(refPoint) });
}

// live preview of the feature being edited
let previewTimer = null;
let previewSeq = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 250);
}

async function runPreview() {
  const f = state.form;
  if (!f || !f.form) return;
  const seq = ++previewSeq;
  try {
    const pv = await api('POST', '/api/preview', { type: f.type, params: f.form.params, feature: f.featureId });
    if (seq !== previewSeq || state.form !== f) return;
    viewer.setPreviewBodies(pv.status.state === 'ok' ? pv : null);
    f.err.hidden = pv.status.state === 'ok';
    if (pv.status.state !== 'ok') f.err.textContent = `プレビュー: ${pv.status.message}`;
  } catch (e) {
    if (seq === previewSeq) { f.err.textContent = e.message; f.err.hidden = false; }
  }
}

// ---------------------------------------------------------------- render

async function setDoc(doc) {
  state.doc = doc;
  $('#docName').value = doc.name;
  $('#btnUndo').disabled = !doc.can_undo;
  $('#btnRedo').disabled = !doc.can_redo;
  if (state.selectedBody && !doc.bodies.some((b) => b.id === state.selectedBody)) state.selectedBody = null;
  renderBodies();
  renderSketches();
  renderFeatures();
  viewer.setSketches(doc.sketches);
  await loadMeshes();
  if (state.form && state.form.form) { state.form.form.bodies = doc.bodies; state.form.form.sketches = doc.sketches; }
  if (!state.form) renderPanel();
  updateOverlay();
}

async function loadMeshes() {
  const doc = state.doc;
  const need = doc.bodies.filter((b) => !state.meshes.has(`${b.id}:${b.sig}`));
  await Promise.all(need.map(async (b) => {
    try {
      state.meshes.set(`${b.id}:${b.sig}`, await api('GET', `/api/bodies/${b.id}/mesh`));
    } catch (e) {
      toast(`${b.name}: ${e.message}`, true);
    }
  }));
  if (state.doc !== doc) return; // a newer state arrived meanwhile
  viewer.setBodies(doc.bodies.map((b) => ({ ...b, mesh: state.meshes.get(`${b.id}:${b.sig}`) })));
  const wanted = new Set(doc.bodies.map((b) => `${b.id}:${b.sig}`));
  for (const k of state.meshes.keys()) if (!wanted.has(k)) state.meshes.delete(k);
  if (!loadMeshes.fitted && doc.bodies.length) { viewer.fit(); loadMeshes.fitted = true; }
}

function renderBodies() {
  const ul = $('#bodyList');
  ul.innerHTML = '';
  if (!state.doc.bodies.length) {
    ul.innerHTML = '<li class="desc" style="cursor:default">ボディはありません</li>';
    return;
  }
  for (const b of state.doc.bodies) {
    const li = document.createElement('li');
    if (b.id === state.selectedBody) li.classList.add('selected');
    const vis = document.createElement('button');
    vis.className = 'vis' + (b.visible ? '' : ' off');
    vis.textContent = '👁';
    vis.title = '表示/非表示';
    vis.addEventListener('click', async (e) => {
      e.stopPropagation();
      await setDoc(await api('PUT', `/api/bodies/${b.id}`, { visible: !b.visible }));
    });
    const sw = document.createElement('input');
    sw.type = 'color';
    sw.className = 'swatch';
    sw.value = b.color;
    sw.title = '色';
    sw.addEventListener('click', (e) => e.stopPropagation());
    sw.addEventListener('change', async () => setDoc(await api('PUT', `/api/bodies/${b.id}`, { color: sw.value })));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = b.name;
    name.title = 'ダブルクリックで名前変更';
    name.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const nn = prompt('ボディ名', b.name);
      if (nn) await setDoc(await api('PUT', `/api/bodies/${b.id}`, { name: nn }));
    });
    li.append(vis, sw, name);
    li.addEventListener('click', () => {
      if (state.form) {
        const field = state.form.form.pickField();
        if (field && field.t === 'body') state.form.form.setBody(field.k, b.id);
      } else selectBody(b.id);
    });
    ul.appendChild(li);
  }
}

function renderSketches() {
  const ul = $('#sketchList');
  ul.innerHTML = '';
  if (!state.doc.sketches.length) {
    ul.innerHTML = '<li class="desc" style="cursor:default">スケッチはありません</li>';
    return;
  }
  for (const sk of state.doc.sketches) {
    const li = document.createElement('li');
    const vis = document.createElement('button');
    vis.className = 'vis' + (sk.visible ? '' : ' off');
    vis.textContent = '👁';
    vis.title = '表示/非表示';
    vis.addEventListener('click', async (e) => {
      e.stopPropagation();
      await setDoc(await api('PUT', `/api/bodies/${sk.id}`, { visible: !sk.visible }));
    });
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '✎';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = sk.name;
    const info = document.createElement('span');
    info.className = 'desc';
    info.textContent = sk.regions.length ? `${sk.regions.length} 領域` : '開いた形状';
    li.append(vis, icon, name, info);
    li.title = 'クリックで編集';
    li.addEventListener('click', () => {
      const f = state.doc.features.find((x) => x.id === sk.id);
      if (f) openSketch(f);
    });
    ul.appendChild(li);
  }
}

const STATE_ICON = { ok: '✓', error: '⚠', suppressed: '⊘', rolledback: '·' };

function renderFeatures() {
  const ul = $('#featureList');
  ul.innerHTML = '';
  const { features, status, active } = state.doc;
  if (!features.length) {
    ul.innerHTML = `<li class="welcome" style="cursor:default"><div>
      <b>はじめかた</b>
      <ol><li>「新規スケッチ」で平面を選び、線・円などを描く</li><li>寸法と拘束で形を決めて「スケッチ終了」</li>
      <li>「押し出し」「回転」で立体にする</li><li>フィレット・面取り・穴あけ (切り取り押し出し) で仕上げ</li></ol>
      履歴をクリックすると、いつでもスケッチの寸法やフィーチャーのパラメータを変更できます。</div></li>`;
    return;
  }
  features.forEach((f, i) => {
    if (i === active && active < features.length) ul.appendChild(rollMarker());
    const st = status[f.id] || { state: 'ok' };
    const li = document.createElement('li');
    li.classList.add(st.state);
    if (f.suppressed) li.classList.add('suppressed');
    if (state.form && state.form.featureId === f.id) li.classList.add('selected');
    li.title = st.message ? `エラー: ${st.message}` : `${FEATURES[f.type]?.label || f.type}`;
    li.draggable = true;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = st.state === 'error' ? '⚠' : FEATURES[f.type]?.icon || '•';
    if (st.state === 'error') icon.style.color = 'var(--danger)';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;
    const roll = actButton('▶', 'ここまでロールバック', async () => {
      await setDoc(await api('POST', '/api/rollback', { index: i + 1 >= features.length ? null : i + 1 }));
    });
    const sup = actButton(f.suppressed ? '◉' : '⊘', f.suppressed ? '抑制解除' : '抑制', async () => {
      await setDoc(await api('PUT', `/api/features/${f.id}`, { suppressed: !f.suppressed }));
    });
    const del = actButton('✕', '削除', async () => {
      if (state.form && state.form.featureId === f.id) await closeForm(false);
      await setDoc(await api('DELETE', `/api/features/${f.id}`));
    });
    li.append(icon, name, roll, sup, del);
    li.addEventListener('click', () => (f.type === 'sketch' ? openSketch(f) : openForm(f.type, f)));
    li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', f.id); });
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('dragover'); });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/plain');
      if (!id || id === f.id) return;
      const from = features.findIndex((x) => x.id === id);
      await setDoc(await api('POST', `/api/features/${id}/move`, { index: from < i ? i - 1 : i }));
    });
    ul.appendChild(li);
  });
  if (active < features.length) {
    const li = document.createElement('li');
    li.className = 'marker';
    const b = document.createElement('button');
    b.textContent = '⏭ 最後まで再生';
    b.style.margin = '4px';
    b.addEventListener('click', async () => setDoc(await api('POST', '/api/rollback', { index: null })));
    li.appendChild(b);
    ul.appendChild(li);
  } else {
    ul.appendChild(rollMarker());
  }
}

function rollMarker() {
  const li = document.createElement('li');
  li.className = 'marker';
  li.title = 'ロールバックマーカー (ここより下は無効)';
  const bar = document.createElement('div');
  bar.className = 'rollbar';
  li.appendChild(bar);
  return li;
}

function actButton(text, title, fn) {
  const b = document.createElement('button');
  b.className = 'act';
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await fn(); } catch (err) { toast(err.message, true); }
  });
  return b;
}

function selectBody(id) {
  state.selectedBody = id;
  renderBodies();
  renderPanel();
  updateOverlay();
}

async function renderPanel() {
  const panel = $('#panel');
  const id = state.selectedBody;
  if (!id) {
    panel.innerHTML = `<h2>プロパティ</h2>
      <p class="desc">ボディをクリックすると体積・表面積などを表示します。</p>
      <div class="welcome">
        <p><b>操作</b></p>
        <p>左ドラッグ: 回転 / 右ドラッグ: パン / ホイール: ズーム</p>
        <p><kbd>Ctrl+Z</kbd> 元に戻す <kbd>Ctrl+Y</kbd> やり直し<br><kbd>Ctrl+S</kbd> 保存 <kbd>F</kbd> 全体表示 <kbd>Esc</kbd> キャンセル</p>
      </div>`;
    return;
  }
  const b = state.doc.bodies.find((x) => x.id === id);
  panel.innerHTML = `<h2>${escapeHtml(b.name)}</h2><p class="desc">計算中…</p>`;
  try {
    const p = await api('GET', `/api/bodies/${id}/properties`);
    if (state.selectedBody !== id || state.form) return;
    const fmt = (v, d = 3) => (v == null ? '—' : Number(v).toFixed(d));
    const [mn, mx] = p.bounds;
    const size = mx.map((v, i) => v - mn[i]);
    panel.innerHTML = `<h2>${escapeHtml(b.name)}</h2>
      <table class="props">
        <tr><td>体積</td><td>${fmt(p.volume)}</td></tr>
        <tr><td>表面積</td><td>${fmt(p.area)}</td></tr>
        <tr><td>重心</td><td>${p.centroid ? p.centroid.map((c) => fmt(c, 2)).join(', ') : '—'}</td></tr>
        <tr><td>サイズ X×Y×Z</td><td>${size.map((c) => fmt(c, 2)).join(' × ')}</td></tr>
        <tr><td>最小</td><td>${mn.map((c) => fmt(c, 2)).join(', ')}</td></tr>
        <tr><td>最大</td><td>${mx.map((c) => fmt(c, 2)).join(', ')}</td></tr>
        <tr><td>面 / エッジ / 頂点</td><td>${p.faces} / ${p.edges} / ${p.vertices}</td></tr>
        <tr><td>閉じたソリッド</td><td>${p.manifold ? 'はい' : 'いいえ'}</td></tr>
      </table>
      <div class="buttons">
        <button data-q="fillet">フィレット</button>
        <button data-q="shell">シェル</button>
        <button data-q="transform">移動</button>
      </div>`;
    panel.querySelectorAll('[data-q]').forEach((btn) => btn.addEventListener('click', () => openForm(btn.dataset.q, null, { target: id })));
  } catch (e) {
    panel.innerHTML = `<h2>${escapeHtml(b.name)}</h2><div class="error-box">${escapeHtml(e.message)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------ feature form

async function openForm(type, feature = null, overrides = {}) {
  if (state.sketch) return;
  if (state.planePick) cancelPlanePick();
  if (state.form) await closeForm(false);
  if (feature && ['extrude', 'revolve'].includes(type) && !feature.params.sketch && ('profile' in feature.params || 'points' in feature.params)) {
    toast('旧形式 (v0.1) の押し出し/回転です。パラメータ編集には対応していません。削除・抑制は可能です。', true);
    return;
  }
  const schema = FEATURES[type];
  if (!schema) return;
  let prevRollback = state.doc.rollback;
  if (feature) {
    // show the model as it was just before this feature, so picks resolve against it
    const idx = state.doc.features.findIndex((f) => f.id === feature.id);
    await setDoc(await api('POST', '/api/rollback', { index: idx }));
  }
  const params = feature ? structuredClone(feature.params) : { ...structuredClone(state.defaults[type]), ...overrides };
  if (!feature) {
    // sensible defaults: preselect the selected body
    const sel = state.selectedBody;
    for (const fld of schema.fields) {
      if (fld.t === 'body' && fld.k === 'target' && !params.target && sel && type !== 'extrude' && type !== 'revolve') params.target = sel;
    }
    if ('sketch' in params && !params.sketch && state.doc.sketches.length) {
      const sks = state.doc.sketches;
      params.sketch = ([...sks].reverse().find((s) => s.visible) || sks[sks.length - 1]).id;
    }
    // cutting / joining needs a body: default to the selected or the only one
    if ('mode' in params && !params.target && state.doc.bodies.length) params.target = sel || state.doc.bodies[state.doc.bodies.length - 1].id;
  }
  const panel = $('#panel');
  panel.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = `${schema.icon} ${feature ? `${feature.name} を編集` : schema.label}`;
  panel.appendChild(h);
  if (schema.desc) {
    const d = document.createElement('p');
    d.className = 'desc';
    d.textContent = schema.desc;
    panel.appendChild(d);
  }
  let nameInput = null;
  if (feature) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.innerHTML = '<label>名前</label>';
    nameInput = document.createElement('input');
    nameInput.value = feature.name;
    wrap.appendChild(nameInput);
    panel.appendChild(wrap);
  }
  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '8px';
  panel.appendChild(body);
  const err = document.createElement('div');
  err.className = 'error-box';
  err.hidden = true;
  panel.appendChild(err);
  const st = feature && state.doc.status[feature.id];
  if (st && st.state === 'error') { err.textContent = st.message; err.hidden = false; }
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const cancel = document.createElement('button');
  cancel.textContent = 'キャンセル';
  const okBtn = document.createElement('button');
  okBtn.className = 'primary';
  okBtn.textContent = 'OK';
  buttons.append(cancel, okBtn);
  panel.appendChild(buttons);

  state.form = { type, featureId: feature ? feature.id : null, prevRollback, err, nameInput, form: null };
  state.form.form = new FeatureForm(body, {
    type, params, bodies: state.doc.bodies, sketches: state.doc.sketches, editing: !!feature,
    onChange: () => { updatePickMode(); schedulePreview(); },
    onPickField: () => { updatePickMode(); },
  });
  cancel.addEventListener('click', () => closeForm(false));
  okBtn.addEventListener('click', () => commitForm());
  renderFeatures();
  updatePickMode();
  schedulePreview();
}

async function commitForm() {
  const f = state.form;
  if (!f) return;
  const params = f.form.params;
  f.err.hidden = true;
  try {
    let doc;
    let fid = f.featureId;
    if (fid) {
      await api('PUT', `/api/features/${fid}`, { params, name: f.nameInput ? f.nameInput.value : undefined });
      doc = await api('POST', '/api/rollback', { index: f.prevRollback });
    } else {
      doc = await api('POST', '/api/features', { type: f.type, params });
      fid = doc.added;
    }
    const st = doc.status[fid];
    if (st && st.state === 'error') {
      // keep the dialog open, revert the change so the model stays valid
      await api('POST', '/api/undo');
      doc = await api('POST', '/api/rollback', { index: f.featureId ? doc.features.findIndex((x) => x.id === fid) : f.prevRollback });
      await setDoc(doc);
      f.err.textContent = `失敗: ${st.message}`;
      f.err.hidden = false;
      return;
    }
    state.form = null;
    previewSeq++;
    viewer.setPreviewBodies(null);
    await setDoc(doc);
    updatePickMode();
    status(`${FEATURES[f.type].label} を${f.featureId ? '更新' : '追加'}しました`);
  } catch (e) {
    f.err.textContent = e.message;
    f.err.hidden = false;
  }
}

async function closeForm(keep) {
  const f = state.form;
  if (!f) return;
  state.form = null;
  previewSeq++;
  viewer.setPreviewBodies(null);
  if (!keep && f.featureId) {
    await setDoc(await api('POST', '/api/rollback', { index: f.prevRollback }));
  } else {
    renderFeatures();
    renderPanel();
  }
  updatePickMode();
}

// --------------------------------------------------------------- commands

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function safeName() {
  return (state.doc.name || 'model').replace(/[^\w\-]+/g, '_');
}

async function exportFile(fmt) {
  try {
    busy(1);
    const r = await fetch(`/api/export/${fmt}`);
    if (!r.ok) throw new Error((await r.json()).detail);
    const blob = await r.blob();
    const name = { step: `${safeName()}.step`, stl: `${safeName()}.stl`, usda: `${safeName()}.usda`, 'usda-mesh': `${safeName()}_mesh.usda` }[fmt];
    download(name, blob);
    status(`${name} をエクスポートしました`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy(-1);
  }
}

const COMMANDS = {
  new: async () => {
    if (state.doc.features.length && !confirm('現在のドキュメントを破棄して新規作成しますか？ (元に戻すで復元できます)')) return;
    await closeForm(false);
    loadMeshes.fitted = false;
    await setDoc(await api('POST', '/api/new'));
  },
  open: () => $('#fileOpen').click(),
  save: async () => {
    const proj = await api('GET', '/api/project');
    download(`${safeName()}.c3d.json`, new Blob([JSON.stringify(proj, null, 1)], { type: 'application/json' }));
    status('プロジェクトを保存しました');
  },
  import: () => $('#fileImport').click(),
  'export-step': () => exportFile('step'),
  'export-usda': () => exportFile('usda'),
  'export-usda-mesh': () => exportFile('usda-mesh'),
  'export-stl': () => exportFile('stl'),
  sketch: () => choosePlane(),
  undo: async () => { await closeForm(false); await setDoc(await api('POST', '/api/undo')); },
  redo: async () => { await closeForm(false); await setDoc(await api('POST', '/api/redo')); },
};

async function run(cmd) {
  try { await COMMANDS[cmd](); } catch (e) { toast(e.message, true); }
}

document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => run(b.dataset.cmd)));
document.querySelectorAll('[data-feature]').forEach((b) => b.addEventListener('click', () => openForm(b.dataset.feature).catch((e) => toast(e.message, true))));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.setView(b.dataset.view)));
document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.toggle;
  if (k === 'edges') { state.showEdges = !state.showEdges; viewer.setEdgesVisible(state.showEdges); b.classList.toggle('on', state.showEdges); }
  if (k === 'xray') { state.xray = !state.xray; viewer.setXray(state.xray); b.classList.toggle('on', state.xray); }
  if (k === 'ortho') toggleProjection();
}));

function setProjection(mode) {
  viewer.setProjection(mode);
  const b = document.querySelector('[data-toggle=ortho]');
  b.classList.toggle('on', mode === 'ortho');
  b.querySelector('.proj-label').textContent = mode === 'ortho' ? '正投影' : 'パース';
  status(mode === 'ortho' ? '正投影で表示しています' : 'パース投影で表示しています');
  try { localStorage.setItem('c3d.projection', mode); } catch { /* storage unavailable */ }
}

function toggleProjection() {
  setProjection(viewer.projection === 'ortho' ? 'perspective' : 'ortho');
}

try { if (localStorage.getItem('c3d.projection') === 'ortho') setProjection('ortho'); } catch { /* storage unavailable */ }

$('#fileOpen').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await closeForm(false);
    loadMeshes.fitted = false;
    await setDoc(await api('POST', '/api/project', data));
    status(`${file.name} を開きました`);
  } catch (err) { toast(`開けませんでした: ${err.message}`, true); }
});

$('#fileImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    await closeForm(false);
    const doc = await api('POST', '/api/import', fd);
    await setDoc(doc);
    const last = doc.features[doc.features.length - 1];
    const st = doc.status[last.id];
    if (st.state === 'error') toast(`インポート失敗: ${st.message}`, true);
    else { viewer.fit(); status(`${file.name} をインポートしました`); }
  } catch (err) { toast(err.message, true); }
});

$('#docName').addEventListener('change', async (e) => {
  await setDoc(await api('PUT', '/api/name', { name: e.target.value || 'Untitled' }));
});

window.addEventListener('keydown', (e) => {
  if (state.sketch) return; // the sketch editor handles its own keys
  if (e.key === 'Escape' && state.planePick) { cancelPlanePick(); return; }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); run(e.shiftKey ? 'redo' : 'undo'); }
  else if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); run('redo'); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); run('save'); }
  else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); run('open'); }
  else if (e.key === 'Escape' && state.form) { closeForm(false); }
  else if (e.key === 'Enter' && state.form && !typing) { commitForm(); }
  else if (e.key.toLowerCase() === 'f' && !typing && !mod) { viewer.fit(); }
  else if (e.key.toLowerCase() === 'o' && !typing && !mod) { toggleProjection(); }
});

// ------------------------------------------------------------ sketching

const STD_PLANES = {
  XY: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] },
};

async function choosePlane() {
  if (state.sketch) return;
  await closeForm(false);
  state.planePick = true;
  const panel = $('#panel');
  panel.innerHTML = `<h2>✎ 新規スケッチ</h2>
    <p class="desc">スケッチを描く平面を選びます。ボディの平らな面をビューポートでクリックしても選べます。</p>
    <div class="plane-buttons">
      <button data-plane="XY"><b>XY</b><span>上面 (Z 方向)</span></button>
      <button data-plane="XZ"><b>XZ</b><span>正面 (Y 方向)</span></button>
      <button data-plane="YZ"><b>YZ</b><span>右側面 (X 方向)</span></button>
    </div>
    <div class="field"><label>平面のオフセット (法線方向)</label><input type="number" id="planeOffset" value="0" step="any"></div>
    <div class="buttons"><button id="planeCancel">キャンセル</button></div>`;
  panel.querySelectorAll('[data-plane]').forEach((b) => b.addEventListener('click', () => {
    const pl = STD_PLANES[b.dataset.plane];
    const off = +$('#planeOffset').value || 0;
    startSketch({ origin: pl.n.map((c) => c * off), x: pl.x, y: pl.y });
  }));
  $('#planeCancel').addEventListener('click', cancelPlanePick);
  updatePickMode();
}

function cancelPlanePick() {
  state.planePick = false;
  renderPanel();
  updatePickMode();
}

function startSketch(plane) {
  state.planePick = false;
  const params = { ...structuredClone(state.defaults.sketch), plane };
  const n = state.doc.features.filter((f) => f.type === 'sketch').length + 1;
  enterSketch({ params, name: `Sketch${n}`, featureId: null, prevRollback: state.doc.rollback });
}

async function openSketch(feature) {
  if (state.sketch) return;
  await closeForm(false);
  const prevRollback = state.doc.rollback;
  const idx = state.doc.features.findIndex((f) => f.id === feature.id);
  await setDoc(await api('POST', '/api/rollback', { index: idx }));
  enterSketch({ params: feature.params, name: feature.name, featureId: feature.id, prevRollback });
}

function enterSketch({ params, name, featureId, prevRollback }) {
  viewer.setPickMode(null);
  viewer.setSelection();
  viewer.setProfileSelection(null);
  $('#viewHint').textContent = '';
  document.body.classList.add('sketching');
  const editor = new SketchEditor({
    container: $('#viewport'),
    viewer,
    sketch: params,
    name,
    describe: (sk) => api('POST', '/api/sketch/describe', { sketch: sk }),
    onChange: () => renderSketchPanel(),
    onFinish: (sk) => finishSketch(sk),
    onCancel: () => leaveSketch(true),
  });
  state.sketch = { editor, featureId, prevRollback, name };
  viewer.setHiddenSketch(featureId);
  renderSketchPanel();
  updateSketchRibbon();
}

async function finishSketch(sk) {
  const s = state.sketch;
  if (!s) return;
  try {
    let doc;
    if (s.featureId) {
      await api('PUT', `/api/features/${s.featureId}`, { params: sk });
      doc = await api('POST', '/api/rollback', { index: s.prevRollback });
    } else {
      doc = await api('POST', '/api/features', { type: 'sketch', params: sk, name: s.name });
    }
    await leaveSketch(false);
    await setDoc(doc);
    const bad = doc.features.filter((f) => doc.status[f.id] && doc.status[f.id].state === 'error').length;
    status(s.featureId ? `${s.name} を更新しました${bad ? ` (エラーのフィーチャー ${bad} 件)` : ''}` : `${s.name} を作成しました。「押し出し」で立体にできます`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function leaveSketch(restore) {
  const s = state.sketch;
  if (!s) return;
  s.editor.destroy();
  state.sketch = null;
  document.body.classList.remove('sketching');
  viewer.exitSketchView();
  viewer.setHiddenSketch(null);
  if (restore && s.featureId) await setDoc(await api('POST', '/api/rollback', { index: s.prevRollback }));
  renderPanel();
  updatePickMode();
}

function updateSketchRibbon() {
  const ed = state.sketch && state.sketch.editor;
  document.querySelectorAll('#sketchRibbon [data-tool]').forEach((b) => b.classList.toggle('on', !!ed && ed.tool === b.dataset.tool));
  const snap = $('#sketchRibbon [data-sk=snap]');
  if (snap && ed) snap.classList.toggle('on', ed.snapGrid);
}

function renderSketchPanel() {
  const s = state.sketch;
  if (!s) return;
  updateSketchRibbon();
  const ed = s.editor;
  const info = ed.info();
  const hasGeom = ed.sk.entities.length > 0;
  const badge = !info.ok ? '<span class="badge bad">拘束エラー</span>'
    : !hasGeom ? '<span class="badge">空のスケッチ</span>'
      : info.dof === 0 ? '<span class="badge ok">完全拘束</span>'
        : `<span class="badge free">未拘束: 自由度 ${info.dof}</span>`;
  const sel = info.selection;
  const kinds = { point: '点', line: '線', circle: '円', arc: '弧', constraint: '拘束' };
  const count = {};
  for (const x of sel) count[x.kind] = (count[x.kind] || 0) + 1;
  const selText = sel.length ? Object.entries(count).map(([k, n]) => `${kinds[k] || k}×${n}`).join('、') : 'なし';
  const panel = $('#panel');
  const focused = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.dataset.dim : null;
  panel.innerHTML = `<h2>✎ ${escapeHtml(s.name)}</h2>
    <div class="sk-status">${badge}<span class="desc">閉じた領域: ${info.regions}</span></div>
    <p class="desc tool-hint">${escapeHtml(info.hint || '')}</p>
    <div class="field"><label>選択</label><div>${selText}</div></div>
    <div class="field"><label>寸法 (値を変更すると形状が追従します)</label>
      <table class="props dims">${info.dims.length ? info.dims.map((c, i) => `
        <tr><td>${i + 1}. ${CONSTRAINT_LABELS[c.type]}</td>
        <td><input data-dim="${c.id}" value="${fmtNum(c.value)}" inputmode="decimal"></td></tr>`).join('')
    : '<tr><td colspan="2" class="desc">寸法ツール (D) で線や円をクリックして追加</td></tr>'}</table></div>
    <details class="help"><summary>拘束の付け方</summary>
      <p>図形を選択してから、上のリボンの拘束ボタンを押します。</p>
      <ul><li>一致: 点＋点 / 点＋線・円</li><li>水平・垂直: 線、または 点＋点</li><li>平行・直交: 線＋線</li>
      <li>等しい: 線どうし / 円・弧どうし</li><li>正接: 線＋円弧、円弧＋円弧</li><li>中点: 点＋線</li><li>同心: 円＋円</li>
      <li>対称: 点＋点＋線</li><li>固定: 点・図形</li></ul>
      <p>拘束アイコンや寸法をクリックして Delete で削除できます。寸法はダブルクリックで値を編集、ドラッグで位置を移動。</p>
    </details>
    <div class="buttons">
      <button id="skCancel">キャンセル</button>
      <button id="skFinish" class="primary">✓ スケッチ終了</button>
    </div>`;
  panel.querySelectorAll('input[data-dim]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', () => {
      const v = evalNumber(inp.value);
      if (v === null || !ed.setDimensionValue(inp.dataset.dim, v)) inp.value = fmtNum(ed.K(inp.dataset.dim)?.value);
    });
  });
  if (focused) panel.querySelector(`input[data-dim="${focused}"]`)?.focus();
  $('#skFinish').addEventListener('click', () => ed.finish());
  $('#skCancel').addEventListener('click', () => {
    if (ed.undoStack.length && !confirm('スケッチの変更を破棄しますか？')) return;
    ed.cancel();
  });
}

function evalNumber(s) {
  const v = Number(String(s).trim());
  return Number.isFinite(v) ? v : null;
}

document.querySelectorAll('#sketchRibbon [data-tool]').forEach((b) => b.addEventListener('click', () => state.sketch && state.sketch.editor.setTool(b.dataset.tool)));
document.querySelectorAll('#sketchRibbon [data-constraint]').forEach((b) => b.addEventListener('click', () => state.sketch && state.sketch.editor.applyConstraint(b.dataset.constraint)));
document.querySelectorAll('#sketchRibbon [data-sk]').forEach((b) => b.addEventListener('click', () => {
  const ed = state.sketch && state.sketch.editor;
  if (!ed) return;
  const a = b.dataset.sk;
  if (a === 'construction') ed.toggleConstruction();
  else if (a === 'delete') ed.deleteSelection();
  else if (a === 'undo') ed.undo();
  else if (a === 'redo') ed.redo();
  else if (a === 'fit') ed.fit();
  else if (a === 'snap') { ed.snapGrid = !ed.snapGrid; updateSketchRibbon(); }
  else if (a === 'finish') ed.finish();
  else if (a === 'cancel') $('#skCancel')?.click();
}));

// ------------------------------------------------------------------ boot

(async () => {
  try {
    state.defaults = (await api('GET', '/api/feature-types')).defaults;
    await setDoc(await api('GET', '/api/doc'));
    updatePickMode();
    viewer.fit();
  } catch (e) {
    toast(`サーバーに接続できません: ${e.message}`, true);
  }
})();

// handle for debugging and automated UI tests
window.cad = { state, viewer };
