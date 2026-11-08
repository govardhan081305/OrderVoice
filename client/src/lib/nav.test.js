// Run with: npm --prefix client test
import test from 'node:test';
import assert from 'node:assert';
import { bearing, buildTrack, distM, maneuverIcon, navState, project, spokenDistance, stepPositions } from './nav.js';

// An L-shaped route in Harohalli: ~1 km north, then ~550 m east.
const A = [12.6700, 77.4650];
const B = [12.6790, 77.4650]; // corner
const C = [12.6790, 77.4700]; // destination
const coords = [A, [12.6745, 77.4650], B, [12.6790, 77.4675], C];
const steps = [
  { type: 'depart', instruction: 'Head north on Kanakapura Main Road', location: A },
  { type: 'turn', modifier: 'right', instruction: 'Turn right onto Bus Stand Road', location: B },
  { type: 'arrive', instruction: 'Arrive at your destination', location: C },
];

test('track length and projection', () => {
  const t = buildTrack(coords);
  assert.ok(Math.abs(t.total - (distM(A, B) + distM(B, C))) < 5, String(t.total));
  const p = project(t, [12.6745, 77.4652]); // ~22 m east of the first leg's midpoint
  assert.ok(p.off > 15 && p.off < 30, String(p.off));
  assert.ok(Math.abs(p.along - distM(A, [12.6745, 77.4650])) < 5);
});

test('next turn, distance to it, remaining distance/time, arrival', () => {
  const t = buildTrack(coords);
  const at = stepPositions(t, steps);
  const s1 = navState(t, steps, at, 300, [12.6750, 77.4650]);
  assert.strictEqual(s1.step.instruction, 'Turn right onto Bus Stand Road');
  assert.ok(Math.abs(s1.toStepM - distM([12.6750, 77.4650], B)) < 8, String(s1.toStepM));
  assert.ok(s1.remainingM > s1.toStepM && s1.remainingS > 0 && s1.remainingS < 300);
  assert.strictEqual(s1.arrived, false);
  assert.ok(s1.offRouteM < 2);

  const s2 = navState(t, steps, at, 300, [12.6790, 77.4680]); // after the turn
  assert.strictEqual(s2.step.type, 'arrive');
  assert.ok(s2.toStepM < 250);

  const s3 = navState(t, steps, at, 300, [12.67901, 77.46985]);
  assert.strictEqual(s3.arrived, true);

  const off = navState(t, steps, at, 300, [12.6745, 77.4700]); // ~540 m off the route
  assert.ok(off.offRouteM > 400);
});

test('helpers: bearing, spoken distance, maneuver icons', () => {
  assert.ok(Math.abs(bearing(A, B) - 0) < 1);
  assert.ok(Math.abs(bearing(B, C) - 90) < 1);
  assert.deepStrictEqual([spokenDistance(10), spokenDistance(87), spokenDistance(340), spokenDistance(1500)], ['now', '90 m', '350 m', '1.5 km']);
  assert.strictEqual(maneuverIcon({ type: 'turn', modifier: 'left' }).rotate, -90);
  assert.strictEqual(maneuverIcon({ type: 'arrive' }).symbol, 'flag');
  assert.strictEqual(maneuverIcon({ type: 'roundabout', modifier: 'right' }).symbol, 'roundabout');
});