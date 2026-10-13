// Run with: node --test tests/js/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, measure, constrainedSet } from '../../web/sketch/solver.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

function rect() {
  return {
    points: [{ id: 'o', x: 0, y: 0 }, { id: 'b', x: 9, y: 0.5 }, { id: 'c', x: 9.5, y: 4 }, { id: 'd', x: 0.3, y: 5 }],
    entities: [
      { id: 'l1', type: 'line', p1: 'o', p2: 'b' }, { id: 'l2', type: 'line', p1: 'b', p2: 'c' },
      { id: 'l3', type: 'line', p1: 'c', p2: 'd' }, { id: 'l4', type: 'line', p1: 'd', p2: 'o' },
    ],
    constraints: [
      { id: 'k1', type: 'horizontal', refs: ['l1'] }, { id: 'k2', type: 'horizontal', refs: ['l3'] },
      { id: 'k3', type: 'vertical', refs: ['l2'] }, { id: 'k4', type: 'vertical', refs: ['l4'] },
    ],
  };
}

test('rectangle with dimensions becomes fully constrained', () => {
  const sk = rect();
  let r = solve(sk);
  assert.ok(r.ok);
  assert.equal(r.dof, 2);
  sk.constraints.push({ id: 'd1', type: 'length', refs: ['l1'], value: 20 });
  sk.constraints.push({ id: 'd2', type: 'length', refs: ['l2'], value: 10 });
  r = solve(sk);
  assert.ok(r.ok);
  assert.equal(r.dof, 0);
  const c = sk.points.find((p) => p.id === 'c');
  near(c.x, 20); near(c.y, 10);
  const done = constrainedSet(sk, r.fixed);
  assert.ok(['l1', 'l2', 'l3', 'l4', 'b', 'c', 'd'].every((id) => done.has(id)));
});

test('conflicting constraints are reported and do not move geometry', () => {
  const sk = rect();
  solve(sk);
  sk.constraints.push({ id: 'x', type: 'parallel', refs: ['l1', 'l2'] });
  const before = JSON.stringify(sk.points);
  const r = solve(sk);
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(sk.points), before);
});

test('circle tangent to line, radius and concentric arc', () => {
  const sk = {
    points: [{ id: 'o', x: 0, y: 0 }, { id: 'a', x: 10, y: 0 }, { id: 'm', x: 4, y: 3 }],
    entities: [{ id: 'l', type: 'line', p1: 'o', p2: 'a' }, { id: 'c', type: 'circle', c: 'm', r: 2 }],
    constraints: [{ id: 'h', type: 'horizontal', refs: ['l'] }],
  };
  const t = { id: 't', type: 'tangent', refs: ['l', 'c'], ...measure(sk, { type: 'tangent', refs: ['l', 'c'] }) };
  sk.constraints.push(t, { id: 'r', type: 'radius', refs: ['c'], value: 5 });
  assert.ok(solve(sk).ok);
  const m = sk.points.find((p) => p.id === 'm');
  near(m.y, 5);
  near(sk.entities[1].r, 5);
});

test('angle, equal, midpoint, symmetric and point-on-circle', () => {
  const sk = {
    points: [{ id: 'o', x: 0, y: 0 }, { id: 'a', x: 10, y: 1 }, { id: 'b', x: 1, y: 8 }, { id: 'p', x: 3, y: 1 },
      { id: 'q', x: 2, y: -3 }, { id: 'r', x: 6, y: 2 }],
    entities: [{ id: 'l1', type: 'line', p1: 'o', p2: 'a' }, { id: 'l2', type: 'line', p1: 'o', p2: 'b' }],
    constraints: [{ id: 'h', type: 'horizontal', refs: ['l1'] }],
  };
  sk.constraints.push({ id: 'ang', type: 'angle', refs: ['l1', 'l2'], value: 60, sign: 1 });
  sk.constraints.push({ id: 'eq', type: 'equal', refs: ['l1', 'l2'] });
  sk.constraints.push({ id: 'len', type: 'length', refs: ['l1'], value: 10 });
  sk.constraints.push({ id: 'mid', type: 'midpoint', refs: ['p', 'l1'] });
  sk.constraints.push({ id: 'sym', type: 'symmetric', refs: ['q', 'r', 'l1'] });
  assert.ok(solve(sk).ok);
  const P = Object.fromEntries(sk.points.map((p) => [p.id, p]));
  near(P.b.x, 5); near(P.b.y, Math.sqrt(75));
  near(P.p.x, 5); near(P.p.y, 0);
  near(P.q.x, P.r.x); near(P.q.y, -P.r.y);
});

test('dragging keeps the dragged point where the user put it', () => {
  const sk = rect();
  solve(sk);
  const c = sk.points.find((p) => p.id === 'c');
  c.x = 15; c.y = 7;
  assert.ok(solve(sk, { dragged: ['c'] }).ok);
  near(c.x, 15, 1e-3); near(c.y, 7, 1e-3);
  const b = sk.points.find((p) => p.id === 'b');
  near(b.x, c.x); near(b.y, 0);
});
