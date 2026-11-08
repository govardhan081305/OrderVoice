// Turns OSRM route steps into turn-by-turn instructions, e.g.
// "Turn left onto Kanakapura Main Road", "At the roundabout, take the 2nd exit".

const ordinal = (n) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${s}`;
};

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compass = (bearing) => COMPASS[Math.round((((bearing ?? 0) % 360) + 360) % 360 / 45) % 8];

function instruction(step) {
  const m = step.maneuver || {};
  const mod = m.modifier || '';
  const name = step.name || step.ref || '';
  const onto = name ? ` onto ${name}` : '';
  switch (m.type) {
    case 'depart': return `Head ${compass(m.bearing_after)}${name ? ` on ${name}` : ''}`;
    case 'arrive': return mod === 'left' || mod === 'right' ? `Arrive at your destination, on the ${mod}` : 'Arrive at your destination';
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn': return m.exit ? `At the roundabout, take the ${ordinal(m.exit)} exit${onto}` : `Go through the roundabout${onto}`;
    case 'exit roundabout':
    case 'exit rotary': return `Exit the roundabout${onto}`;
    case 'merge': return `Merge${mod && mod !== 'straight' ? ` ${mod}` : ''}${onto}`;
    case 'on ramp': return `Take the ramp${mod.includes('left') ? ' on the left' : mod.includes('right') ? ' on the right' : ''}${onto}`;
    case 'off ramp': return `Take the exit${mod.includes('left') ? ' on the left' : mod.includes('right') ? ' on the right' : ''}${onto}`;
    case 'fork': return `Keep ${mod.includes('left') ? 'left' : mod.includes('right') ? 'right' : 'straight'} at the fork${onto}`;
    case 'end of road': return `At the end of the road, turn ${mod.replace('sharp ', '').replace('slight ', '') || 'left'}${onto}`;
    case 'new name': return name ? `Continue onto ${name}` : 'Continue straight';
    case 'continue':
      if (mod === 'uturn') return `Make a U-turn${onto}`;
      return `Continue ${mod && mod !== 'straight' ? mod : 'straight'}${onto}`;
    case 'notification': return name ? `Continue on ${name}` : 'Continue';
    default: // 'turn' and anything new
      if (mod === 'uturn') return `Make a U-turn${onto}`;
      if (mod === 'straight' || !mod) return `Go straight${onto}`;
      return `Turn ${mod}${onto}`;
  }
}

// OSRM legs -> flat list of steps the app can show.
function toSteps(legs = []) {
  const out = [];
  legs.forEach((leg, li) => {
    for (const s of leg.steps || []) {
      const m = s.maneuver || {};
      // Drop the intermediate "arrive"/"depart" pair at a via point (e.g. the restaurant).
      if (li < legs.length - 1 && m.type === 'arrive') continue;
      if (li > 0 && m.type === 'depart') continue;
      out.push({
        type: m.type || 'turn',
        modifier: m.modifier || null,
        exit: m.exit || null,
        name: s.name || s.ref || '',
        instruction: instruction(s),
        distanceM: Math.round(s.distance || 0),
        durationS: Math.round(s.duration || 0),
        location: m.location ? [m.location[1], m.location[0]] : null, // [lat, lng]
      });
    }
  });
  return out;
}

module.exports = { instruction, toSteps, ordinal, compass };