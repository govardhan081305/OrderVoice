// Turn-by-turn instructions from OSRM steps.
const test = require('node:test');
const assert = require('node:assert');
const { instruction, toSteps, ordinal, compass } = require('../src/nav');
const { createGeo } = require('../src/geo');

const st = (type, modifier, name = '', extra = {}) => ({ name, maneuver: { type, modifier, ...extra } });

test('instruction text', () => {
  assert.strictEqual(instruction(st('depart', null, 'Kanakapura Main Road', { bearing_after: 30 })), 'Head northeast on Kanakapura Main Road');
  assert.strictEqual(instruction(st('turn', 'left', '2nd Cross')), 'Turn left onto 2nd Cross');
  assert.strictEqual(instruction(st('turn', 'slight right')), 'Turn slight right');
  assert.strictEqual(instruction(st('turn', 'uturn')), 'Make a U-turn');
  assert.strictEqual(instruction(st('roundabout', 'right', 'BM Road', { exit: 2 })), 'At the roundabout, take the 2nd exit onto BM Road');
  assert.strictEqual(instruction(st('fork', 'slight left', 'NH 948')), 'Keep left at the fork onto NH 948');
  assert.strictEqual(instruction(st('end of road', 'right')), 'At the end of the road, turn right');
  assert.strictEqual(instruction(st('new name', 'straight', 'Bus Stand Road')), 'Continue onto Bus Stand Road');
  assert.strictEqual(instruction(st('arrive', 'left')), 'Arrive at your destination, on the left');
  assert.deepStrictEqual([ordinal(1), ordinal(2), ordinal(3), ordinal(11), ordinal(22)], ['1st', '2nd', '3rd', '11th', '22nd']);
  assert.deepStrictEqual([compass(0), compass(90), compass(225), compass(350)], ['north', 'east', 'southwest', 'north']);
});

test('steps across a via point (restaurant) are merged into one list', () => {
  const legs = [
    { steps: [{ ...st('depart', null, 'A', { location: [77.46, 12.67], bearing_after: 0 }), distance: 100, duration: 20 }, { ...st('arrive', null, '', { location: [77.47, 12.68] }), distance: 0, duration: 0 }] },
    { steps: [{ ...st('depart', null, 'B', { location: [77.47, 12.68] }), distance: 0, duration: 0 }, { ...st('turn', 'right', 'C', { location: [77.48, 12.69] }), distance: 300, duration: 60 }, { ...st('arrive', null, '', { location: [77.49, 12.69] }), distance: 0, duration: 0 }] },
  ];
  const s = toSteps(legs);
  assert.deepStrictEqual(s.map((x) => x.type), ['depart', 'turn', 'arrive']);
  assert.deepStrictEqual(s[1].location, [12.69, 77.48]);
  assert.strictEqual(s[1].instruction, 'Turn right onto C');
});

test('route with steps from OSRM, and fallback steps when offline', async () => {
  const osrm = { routes: [{ distance: 900, duration: 150, geometry: { coordinates: [[77.46, 12.67], [77.47, 12.68]] }, legs: [{ steps: [
    { name: 'Kanakapura Main Road', distance: 900, duration: 150, maneuver: { type: 'depart', bearing_after: 45, location: [77.46, 12.67] } },
    { name: '', distance: 0, duration: 0, maneuver: { type: 'arrive', location: [77.47, 12.68] } }] }] }] };
  let url = '';
  const geo = createGeo({ fetchImpl: async (u) => { url = String(u); return { ok: true, json: async () => osrm }; }, osrmUrl: 'https://osrm.test' });
  const r = await geo.route([{ lat: 12.67, lng: 77.46 }, { lat: 12.68, lng: 77.47 }], { steps: true });
  assert.ok(url.includes('steps=true'));
  assert.strictEqual(r.steps[0].instruction, 'Head northeast on Kanakapura Main Road');

  const off = createGeo({ fetchImpl: async () => { throw new Error('offline'); }, osrmUrl: 'https://osrm.test' });
  const f = await off.route([{ lat: 12.67, lng: 77.46 }, { lat: 12.68, lng: 77.47 }], { steps: true });
  assert.strictEqual(f.approximate, true);
  assert.deepStrictEqual(f.steps.map((x) => x.type), ['depart', 'arrive']);
});