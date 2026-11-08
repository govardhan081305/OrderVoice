// Turn-by-turn navigation maths (pure functions, unit-tested in nav.test.js).
// Given the route line, its maneuver steps and the rider's live GPS position,
// work out: how far along the route they are, the next turn and the distance to
// it, remaining distance/time, whether they've left the route, and arrival.

const R = 6371e3;
const rad = (d) => (d * Math.PI) / 180;

// Local flat projection in metres around a reference point (fine for city distances).
function projector(ref) {
  const kx = R * rad(1) * Math.cos(rad(ref[0]));
  const ky = R * rad(1);
  return (p) => [(p[1] - ref[1]) * kx, (p[0] - ref[0]) * ky];
}

export function distM(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Compass bearing in degrees from a to b ([lat, lng]).
export function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Precompute cumulative distance along the polyline.
export function buildTrack(coords) {
  const proj = projector(coords[0]);
  const xy = coords.map(proj);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { coords, xy, cum, total: cum[cum.length - 1], proj };
}

// Nearest point on the track to `pos`: distance off the route and distance along it.
// `fromIdx` limits the search so we don't snap backwards onto an earlier part of the route.
export function project(track, pos, fromIdx = 0) {
  const p = track.proj(pos);
  let best = { off: Infinity, along: 0, idx: 0 };
  for (let i = Math.max(1, fromIdx); i < track.xy.length; i++) {
    const [ax, ay] = track.xy[i - 1];
    const [bx, by] = track.xy[i];
    const dx = bx - ax; const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
    const cx = ax + t * dx; const cy = ay + t * dy;
    const off = Math.hypot(p[0] - cx, p[1] - cy);
    if (off < best.off) best = { off, along: track.cum[i - 1] + t * Math.sqrt(len2), idx: i - 1 };
  }
  return best;
}

// Where each maneuver sits along the track (monotonic).
export function stepPositions(track, steps) {
  let idx = 0;
  return steps.map((s, k) => {
    if (k === steps.length - 1 || s.type === 'arrive') return track.total;
    if (!s.location) return 0;
    const pr = project(track, s.location, idx);
    idx = pr.idx;
    return pr.along;
  });
}

/**
 * Navigation state for the rider at `pos`.
 * @returns {{ offRouteM, alongM, remainingM, remainingS, stepIndex, step, nextStep, toStepM, arrived }}
 */
export function navState(track, steps, stepAt, durationS, pos, prevIdx = 0) {
  const pr = project(track, pos, Math.max(0, prevIdx - 2));
  const alongM = pr.along;
  const remainingM = Math.max(0, track.total - alongM);
  // Next maneuver = first step (after depart) whose position is still ahead of us.
  let stepIndex = steps.findIndex((s, i) => i > 0 && stepAt[i] > alongM + 8);
  if (stepIndex === -1) stepIndex = steps.length - 1;
  const toStepM = Math.max(0, stepAt[stepIndex] - alongM);
  const arrived = remainingM < 35 || distM(pos, track.coords[track.coords.length - 1]) < 35;
  return {
    offRouteM: pr.off,
    alongM,
    segIdx: pr.idx,
    remainingM,
    remainingS: track.total ? Math.round((durationS * remainingM) / track.total) : 0,
    stepIndex,
    step: steps[stepIndex],
    nextStep: steps[stepIndex + 1] || null,
    toStepM,
    arrived,
  };
}

// Distance as a driver hears it: "50 m", "300 m", "1.2 km".
export function spokenDistance(m) {
  if (m < 25) return 'now';
  if (m < 1000) return `${m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

// Arrow for a maneuver (CSS rotation in degrees, or a special symbol).
export function maneuverIcon(step) {
  if (!step) return { rotate: 0, symbol: null };
  if (step.type === 'arrive') return { rotate: 0, symbol: 'flag' };
  if (step.type === 'roundabout' || step.type === 'rotary' || step.type === 'roundabout turn') return { rotate: 0, symbol: 'roundabout' };
  const m = step.modifier || 'straight';
  const angle = { 'sharp left': -135, left: -90, 'slight left': -45, straight: 0, 'slight right': 45, right: 90, 'sharp right': 135, uturn: 180 }[m] ?? 0;
  return { rotate: angle, symbol: m === 'uturn' ? 'uturn' : null };
}