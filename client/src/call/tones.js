// Ringtone (incoming) and ringback (outgoing) generated with Web Audio,
// so the app ships no audio files.
let ctx = null;
let timer = null;
let nodes = [];

function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function beep(freqs, durationMs, volume) {
  const c = audioCtx();
  if (!c) return;
  const gain = c.createGain();
  gain.gain.value = volume;
  gain.connect(c.destination);
  const now = c.currentTime;
  gain.gain.setValueAtTime(volume, now);
  gain.gain.setValueAtTime(volume, now + durationMs / 1000 - 0.02);
  gain.gain.linearRampToValueAtTime(0, now + durationMs / 1000);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.frequency.value = f;
    o.connect(gain);
    o.start(now);
    o.stop(now + durationMs / 1000);
    nodes.push(o);
  }
}

export function startRingtone() {
  stopTones();
  const pattern = () => { beep([880, 1320], 350, 0.12); setTimeout(() => beep([880, 1320], 350, 0.12), 450); };
  pattern();
  timer = setInterval(pattern, 2200);
}

export function startRingback() {
  stopTones();
  const pattern = () => beep([400, 450], 1200, 0.06); // classic Indian/UK-style ringback
  pattern();
  timer = setInterval(pattern, 3000);
}

export function stopTones() {
  clearInterval(timer);
  timer = null;
  nodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } });
  nodes = [];
}
