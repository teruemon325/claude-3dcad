// Geometric constraint solver for 2D sketches.
//
// Unknowns are point coordinates (x, y) and circle radii. Every constraint
// contributes one or more residual equations f(x) = 0. The solver takes damped
// minimum-norm Gauss-Newton steps, so under-constrained geometry moves as little
// as possible (and "dragged" variables, weighted stiffly, move least of all).
// A rank analysis of the Jacobian reports remaining degrees of freedom and
// which entities are fully constrained.

export const ORIGIN = 'o';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ access

function buildAccess(sk) {
  const keys = [];
  const index = new Map();
  const consts = new Map();
  for (const p of sk.points) {
    if (p.id === ORIGIN) {
      consts.set(`x:${p.id}`, 0);
      consts.set(`y:${p.id}`, 0);
      continue;
    }
    for (const a of ['x', 'y']) { index.set(`${a}:${p.id}`, keys.length); keys.push(`${a}:${p.id}`); }
  }
  for (const e of sk.entities) {
    if (e.type === 'circle') { index.set(`r:${e.id}`, keys.length); keys.push(`r:${e.id}`); }
  }
  const pointById = new Map(sk.points.map((p) => [p.id, p]));
  const entById = new Map(sk.entities.map((e) => [e.id, e]));
  const x0 = keys.map((k) => {
    const [a, id] = splitKey(k);
    return a === 'r' ? +entById.get(id).r : +pointById.get(id)[a];
  });
  const get = (x, key) => (index.has(key) ? x[index.get(key)] : consts.get(key));
  return { keys, index, x0, get, pointById, entById };
}

function splitKey(k) {
  const i = k.indexOf(':');
  return [k.slice(0, i), k.slice(i + 1)];
}

// ------------------------------------------------------------- equations

/** Returns [{c: constraint, f: (x) => number}] for all constraints plus implicit arc equations. */
function buildEquations(sk, acc) {
  const { get, entById } = acc;
  const P = (x, id) => [get(x, `x:${id}`), get(x, `y:${id}`)];
  const R = (x, e) => {
    if (e.type === 'circle') return get(x, `r:${e.id}`);
    const c = P(x, e.c);
    const s = P(x, e.p1);
    return Math.hypot(s[0] - c[0], s[1] - c[1]);
  };
  const C = (x, e) => P(x, e.c);
  const L = (x, e) => [P(x, e.p1), P(x, e.p2)];
  const dir = ([a, b]) => [b[0] - a[0], b[1] - a[1]];
  const len = (v) => Math.hypot(v[0], v[1]);
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const ent = (id) => entById.get(id);
  const isPoint = (id) => acc.pointById.has(id);

  const eqs = [];
  const add = (c, f) => eqs.push({ c, f });

  // implicit: arc end points lie on the same circle
  for (const e of sk.entities) {
    if (e.type === 'arc') {
      add(null, (x) => {
        const c = P(x, e.c);
        const a = P(x, e.p1);
        const b = P(x, e.p2);
        return Math.hypot(a[0] - c[0], a[1] - c[1]) - Math.hypot(b[0] - c[0], b[1] - c[1]);
      });
    }
  }

  for (const c of sk.constraints) {
    const r = c.refs;
    const s = c.sign ?? 1;
    switch (c.type) {
      case 'coincident':
        add(c, (x) => P(x, r[0])[0] - P(x, r[1])[0]);
        add(c, (x) => P(x, r[0])[1] - P(x, r[1])[1]);
        break;
      case 'horizontal':
        if (isPoint(r[0])) add(c, (x) => P(x, r[0])[1] - P(x, r[1])[1]);
        else add(c, (x) => { const [a, b] = L(x, ent(r[0])); return a[1] - b[1]; });
        break;
      case 'vertical':
        if (isPoint(r[0])) add(c, (x) => P(x, r[0])[0] - P(x, r[1])[0]);
        else add(c, (x) => { const [a, b] = L(x, ent(r[0])); return a[0] - b[0]; });
        break;
      case 'parallel':
        add(c, (x) => {
          const u = dir(L(x, ent(r[0])));
          const v = dir(L(x, ent(r[1])));
          return cross(u, v) / (len(u) * len(v) || 1);
        });
        break;
      case 'perpendicular':
        add(c, (x) => {
          const u = dir(L(x, ent(r[0])));
          const v = dir(L(x, ent(r[1])));
          return dot(u, v) / (len(u) * len(v) || 1);
        });
        break;
      case 'equal': {
        const a = ent(r[0]);
        const b = ent(r[1]);
        if (a.type === 'line') add(c, (x) => len(dir(L(x, a))) - len(dir(L(x, b))));
        else add(c, (x) => R(x, a) - R(x, b));
        break;
      }
      case 'tangent': {
        const a = ent(r[0]);
        const b = ent(r[1]);
        if (a.type === 'line') {
          add(c, (x) => {
            const [p, q] = L(x, a);
            const d = dir([p, q]);
            const m = C(x, b);
            return s * cross(d, [m[0] - p[0], m[1] - p[1]]) / (len(d) || 1) - R(x, b);
          });
        } else {
          // s = +1: external (|c1c2| = r1 + r2), s = -1: internal (|c1c2| = |r1 - r2|)
          add(c, (x) => {
            const m1 = C(x, a);
            const m2 = C(x, b);
            const d = Math.hypot(m1[0] - m2[0], m1[1] - m2[1]);
            return s > 0 ? d - (R(x, a) + R(x, b)) : d - (c.sign2 ?? 1) * (R(x, a) - R(x, b));
          });
        }
        break;
      }
      case 'pointOnLine':
        add(c, (x) => {
          const p = P(x, r[0]);
          const [a, b] = L(x, ent(r[1]));
          const d = dir([a, b]);
          return cross(d, [p[0] - a[0], p[1] - a[1]]) / (len(d) || 1);
        });
        break;
      case 'pointOnCircle':
        add(c, (x) => {
          const p = P(x, r[0]);
          const e = ent(r[1]);
          const m = C(x, e);
          return Math.hypot(p[0] - m[0], p[1] - m[1]) - R(x, e);
        });
        break;
      case 'midpoint':
        add(c, (x) => { const p = P(x, r[0]); const [a, b] = L(x, ent(r[1])); return p[0] - (a[0] + b[0]) / 2; });
        add(c, (x) => { const p = P(x, r[0]); const [a, b] = L(x, ent(r[1])); return p[1] - (a[1] + b[1]) / 2; });
        break;
      case 'symmetric':
        // midpoint of p-q on the line, p-q perpendicular to the line
        add(c, (x) => {
          const p = P(x, r[0]);
          const q = P(x, r[1]);
          const [a, b] = L(x, ent(r[2]));
          const d = dir([a, b]);
          const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          return cross(d, [m[0] - a[0], m[1] - a[1]]) / (len(d) || 1);
        });
        add(c, (x) => {
          const p = P(x, r[0]);
          const q = P(x, r[1]);
          const d = dir(L(x, ent(r[2])));
          return dot(d, [q[0] - p[0], q[1] - p[1]]) / (len(d) || 1);
        });
        break;
      case 'fix':
        add(c, (x) => P(x, r[0])[0] - c.x);
        add(c, (x) => P(x, r[0])[1] - c.y);
        break;
      case 'distance':
        add(c, (x) => { const p = P(x, r[0]); const q = P(x, r[1]); return Math.hypot(q[0] - p[0], q[1] - p[1]) - c.value; });
        break;
      case 'hdistance':
        add(c, (x) => s * (P(x, r[1])[0] - P(x, r[0])[0]) - c.value);
        break;
      case 'vdistance':
        add(c, (x) => s * (P(x, r[1])[1] - P(x, r[0])[1]) - c.value);
        break;
      case 'length':
        add(c, (x) => len(dir(L(x, ent(r[0])))) - c.value);
        break;
      case 'pldistance':
        add(c, (x) => {
          const p = P(x, r[0]);
          const [a, b] = L(x, ent(r[1]));
          const d = dir([a, b]);
          return s * cross(d, [p[0] - a[0], p[1] - a[1]]) / (len(d) || 1) - c.value;
        });
        break;
      case 'radius':
        add(c, (x) => R(x, ent(r[0])) - c.value);
        break;
      case 'diameter':
        add(c, (x) => 2 * R(x, ent(r[0])) - c.value);
        break;
      case 'angle':
        add(c, (x) => {
          const u = dir(L(x, ent(r[0])));
          const v = dir(L(x, ent(r[1])));
          return wrap(Math.atan2(cross(u, v), dot(u, v)) - s * c.value * DEG);
        });
        break;
      default:
        throw new Error(`unknown constraint ${c.type}`);
    }
  }
  return eqs;
}

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// ---------------------------------------------------------------- linalg

function jacobian(eqs, x) {
  const n = x.length;
  const m = eqs.length;
  const J = Array.from({ length: m }, () => new Float64Array(n));
  const xx = Float64Array.from(x);
  for (let j = 0; j < n; j++) {
    const h = 1e-7 * Math.max(1, Math.abs(x[j]));
    xx[j] = x[j] + h;
    const fp = eqs.map((e) => e.f(xx));
    xx[j] = x[j] - h;
    const fm = eqs.map((e) => e.f(xx));
    xx[j] = x[j];
    for (let i = 0; i < m; i++) J[i][j] = (fp[i] - fm[i]) / (2 * h);
  }
  return J;
}

function solveLinear(A, b) {
  // Gaussian elimination with partial pivoting (A is small and regularized)
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]];
    const piv = M[k][k];
    if (Math.abs(piv) < 1e-300) continue;
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / piv;
      if (!f) continue;
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  const y = new Array(n).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let s = M[k][n];
    for (let j = k + 1; j < n; j++) s -= M[k][j] * y[j];
    y[k] = Math.abs(M[k][k]) < 1e-300 ? 0 : s / M[k][k];
  }
  return y;
}

const norm = (r) => r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Null-space basis of J (rows = equations) via reduced row echelon form. */
function nullspace(J, n) {
  const m = J.length;
  const M = J.map((row) => Array.from(row));
  let scale = 0;
  for (const row of M) for (const v of row) scale = Math.max(scale, Math.abs(v));
  const tol = 1e-8 * Math.max(scale, 1);
  const pivots = [];
  let r = 0;
  for (let c = 0; c < n && r < m; c++) {
    let p = r;
    for (let i = r + 1; i < m; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) <= tol) continue;
    [M[r], M[p]] = [M[p], M[r]];
    const pv = M[r][c];
    for (let j = c; j < n; j++) M[r][j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === r || !M[i][c]) continue;
      const f = M[i][c];
      for (let j = c; j < n; j++) M[i][j] -= f * M[r][j];
    }
    pivots.push(c);
    r++;
  }
  const isPivot = new Set(pivots);
  const basis = [];
  for (let f = 0; f < n; f++) {
    if (isPivot.has(f)) continue;
    const v = new Float64Array(n);
    v[f] = 1;
    pivots.forEach((pc, row) => { v[pc] = -M[row][f]; });
    basis.push(v);
  }
  return { rank: pivots.length, basis };
}

// ----------------------------------------------------------------- solve

/**
 * Solve the sketch in place.
 * opts.dragged: iterable of point ids that should move as little as possible.
 * Returns { ok, residual, dof, fixed: Set<key>, iterations }.
 */
export function solve(sk, opts = {}) {
  const acc = buildAccess(sk);
  const eqs = buildEquations(sk, acc);
  const n = acc.keys.length;
  let x = Float64Array.from(acc.x0);
  const w = new Float64Array(n).fill(1);
  for (const id of opts.dragged || []) {
    for (const a of ['x', 'y']) {
      const k = acc.index.get(`${a}:${id}`);
      if (k !== undefined) w[k] = 1e6;
    }
  }
  let r = eqs.map((e) => e.f(x));
  let res = norm(r);
  let it = 0;
  const maxIter = opts.maxIter ?? 80;
  while (res > 1e-10 && it < maxIter && eqs.length) {
    it++;
    const J = jacobian(eqs, x);
    const m = eqs.length;
    // A = J W^-1 J^T + mu I
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    for (let i = 0; i < m; i++) {
      for (let k = i; k < m; k++) {
        let s = 0;
        const Ji = J[i];
        const Jk = J[k];
        for (let j = 0; j < n; j++) s += (Ji[j] * Jk[j]) / w[j];
        A[i][k] = s;
        A[k][i] = s;
      }
    }
    let diag = 0;
    for (let i = 0; i < m; i++) diag = Math.max(diag, A[i][i]);
    const mu = 1e-10 * Math.max(diag, 1);
    for (let i = 0; i < m; i++) A[i][i] += mu;
    const y = solveLinear(A, r);
    const dx = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += J[i][j] * y[i];
      dx[j] = -s / w[j];
    }
    let t = 1;
    let improved = false;
    while (t > 1e-4) {
      const xn = x.map((v, j) => v + t * dx[j]);
      const rn = eqs.map((e) => e.f(xn));
      const resn = norm(rn);
      if (resn < res || resn < 1e-10) {
        x = Float64Array.from(xn);
        r = rn;
        res = resn;
        improved = true;
        break;
      }
      t /= 2;
    }
    if (!improved) break;
  }
  const ok = res < 1e-6 && x.every(Number.isFinite);
  if (ok || opts.writeOnFail) {
    acc.keys.forEach((k, j) => {
      const [a, id] = splitKey(k);
      if (a === 'r') acc.entById.get(id).r = round(x[j]);
      else acc.pointById.get(id)[a] = round(x[j]);
    });
  }
  const out = { ok, residual: res, iterations: it, dof: n, fixed: new Set() };
  if (opts.analyze !== false) Object.assign(out, analyze(eqs, x, acc.keys));
  return out;
}

function round(v) {
  return Math.abs(v) < 1e-12 ? 0 : v;
}

function analyze(eqs, x, keys) {
  const n = keys.length;
  if (!eqs.length) return { dof: n, fixed: new Set() };
  const J = jacobian(eqs, x);
  const { rank, basis } = nullspace(J, n);
  const fixed = new Set();
  keys.forEach((k, j) => {
    let free = false;
    for (const v of basis) {
      // normalize per basis vector so the threshold is scale-independent
      let mx = 0;
      for (const c of v) mx = Math.max(mx, Math.abs(c));
      if (Math.abs(v[j]) > 1e-6 * mx) { free = true; break; }
    }
    if (!free) fixed.add(k);
  });
  return { dof: n - rank, fixed };
}

/** Status of each point/entity: true when fully constrained. */
export function constrainedSet(sk, fixedKeys) {
  const done = new Set([ORIGIN]);
  const has = (id) => id === ORIGIN || (fixedKeys.has(`x:${id}`) && fixedKeys.has(`y:${id}`));
  for (const p of sk.points) if (has(p.id)) done.add(p.id);
  for (const e of sk.entities) {
    let ok;
    if (e.type === 'line') ok = has(e.p1) && has(e.p2);
    else if (e.type === 'circle') ok = has(e.c) && fixedKeys.has(`r:${e.id}`);
    else ok = has(e.c) && has(e.p1) && has(e.p2);
    if (ok) done.add(e.id);
  }
  return done;
}

// --------------------------------------------------------------- measure

/** Current value (and orientation sign) of a dimension constraint, for initial values. */
export function measure(sk, c) {
  const pts = new Map(sk.points.map((p) => [p.id, [p.x, p.y]]));
  const ents = new Map(sk.entities.map((e) => [e.id, e]));
  const P = (id) => pts.get(id);
  const R = (e) => (e.type === 'circle' ? e.r : Math.hypot(P(e.p1)[0] - P(e.c)[0], P(e.p1)[1] - P(e.c)[1]));
  const D = (e) => [P(e.p2)[0] - P(e.p1)[0], P(e.p2)[1] - P(e.p1)[1]];
  const r = c.refs;
  switch (c.type) {
    case 'distance': return { value: Math.hypot(P(r[1])[0] - P(r[0])[0], P(r[1])[1] - P(r[0])[1]) };
    case 'hdistance': { const d = P(r[1])[0] - P(r[0])[0]; return { value: Math.abs(d), sign: d < 0 ? -1 : 1 }; }
    case 'vdistance': { const d = P(r[1])[1] - P(r[0])[1]; return { value: Math.abs(d), sign: d < 0 ? -1 : 1 }; }
    case 'length': { const d = D(ents.get(r[0])); return { value: Math.hypot(d[0], d[1]) }; }
    case 'pldistance': {
      const e = ents.get(r[1]);
      const d = D(e);
      const a = P(e.p1);
      const p = P(r[0]);
      const v = (d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / (Math.hypot(d[0], d[1]) || 1);
      return { value: Math.abs(v), sign: v < 0 ? -1 : 1 };
    }
    case 'radius': return { value: R(ents.get(r[0])) };
    case 'diameter': return { value: 2 * R(ents.get(r[0])) };
    case 'angle': {
      const u = D(ents.get(r[0]));
      const v = D(ents.get(r[1]));
      const a = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) / DEG;
      return { value: Math.abs(a), sign: a < 0 ? -1 : 1 };
    }
    case 'tangent': {
      const a = ents.get(r[0]);
      const b = ents.get(r[1]);
      if (a.type === 'line') {
        const d = D(a);
        const p = P(a.p1);
        const m = P(b.c);
        const v = d[0] * (m[1] - p[1]) - d[1] * (m[0] - p[0]);
        return { sign: v < 0 ? -1 : 1 };
      }
      const dist = Math.hypot(P(a.c)[0] - P(b.c)[0], P(a.c)[1] - P(b.c)[1]);
      const ext = Math.abs(dist - (R(a) + R(b)));
      const inn = Math.abs(dist - Math.abs(R(a) - R(b)));
      return { sign: ext <= inn ? 1 : -1, sign2: R(a) >= R(b) ? 1 : -1 };
    }
    default: return {};
  }
}

export const DIMENSION_TYPES = new Set(['distance', 'hdistance', 'vdistance', 'length', 'pldistance', 'radius', 'diameter', 'angle']);
