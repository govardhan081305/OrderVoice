// In-app turn-by-turn navigation for the delivery partner.
// Follows the live GPS position: shows the next turn and the distance to it,
// remaining distance / time / arrival clock, re-routes when the rider leaves the
// route, speaks instructions (optional) and offers the next action on arrival.
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, storage } from '../lib/api';
import { bearing, buildTrack, distM, maneuverIcon, navState, spokenDistance, stepPositions } from '../lib/nav';
import { fmtDistance, fmtEta, navigateUrl } from '../lib/geo';
import { ICONS } from './TrackMap';

const OFF_ROUTE_M = 45;

function Arrow({ step, size = 44 }) {
  const { rotate, symbol } = maneuverIcon(step);
  if (symbol === 'flag') return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>;
  if (symbol === 'roundabout') return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="10" r="4" /><path d="M12 14v7M16 10h5l-2-2M19 12l2-2" /></svg>;
  if (symbol === 'uturn') return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M8 21V9a5 5 0 0 1 10 0v4M15 10l3 3 3-3" /></svg>;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: `rotate(${rotate}deg)` }}>
      <path d="M12 21V5M6 11l6-6 6 6" />
    </svg>
  );
}

const riderIcon = (deg) => L.divIcon({
  className: 'nav-rider',
  html: `<div style="transform: rotate(${deg}deg)"><svg viewBox="0 0 40 40" width="40" height="40"><circle cx="20" cy="20" r="17" fill="#178a56" stroke="#fff" stroke-width="3"/><path d="M20 9 L28 28 L20 23 L12 28 Z" fill="#fff"/></svg></div>`,
  iconSize: [40, 40], iconAnchor: [20, 20],
});

function Follow({ pos, following, onUserMove }) {
  const map = useMap();
  useEffect(() => {
    const h = () => onUserMove();
    map.on('dragstart', h);
    return () => { map.off('dragstart', h); };
  }, [map, onUserMove]);
  useEffect(() => {
    if (following && pos) map.setView(pos, Math.max(map.getZoom(), 17), { animate: true, duration: 0.6 });
  }, [pos, following, map]);
  useEffect(() => { setTimeout(() => map.invalidateSize(), 50); }, [map]);
  return null;
}

function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    u.rate = 1;
    window.speechSynthesis.speak(u);
  } catch { /* unsupported */ }
}

export default function NavigationView({ destination, position, onExit, arrivedAction, sharing, onStartGps }) {
  const [route, setRoute] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ok | rerouting | error
  const [following, setFollowing] = useState(true);
  const [voice, setVoice] = useState(storage.get('ov.navVoice') === '1');
  const [heading, setHeading] = useState(null); // from movement; null until the rider moves
  const [busy, setBusy] = useState(false);
  const offCount = useRef(0);
  const lastReroute = useRef(0);
  const lastPos = useRef(null);
  const spoken = useRef({ step: -1, near: -1, arrived: false });
  const prevIdx = useRef(0);
  const destKey = `${destination.lat},${destination.lng}`;
  const pos = position ? [position.lat, position.lng] : null;

  // Fetch a route with turn-by-turn steps from the rider's position to the destination.
  const fetchRoute = async (from, reason) => {
    setStatus(reason === 'reroute' ? 'rerouting' : 'loading');
    if (reason === 'reroute') lastReroute.current = Date.now(); // throttle only re-routes, not the first route
    try {
      const r = await api.get(`/geo/route?from=${from[0]},${from[1]}&to=${destination.lat},${destination.lng}&steps=1`);
      setRoute(r);
      setStatus('ok');
      offCount.current = 0;
      prevIdx.current = 0;
      spoken.current = { step: -1, near: -1, arrived: false };
    } catch { setStatus('error'); }
  };

  // First route once we have a position, and again whenever the destination changes.
  useEffect(() => {
    setRoute(null);
    if (pos) fetchRoute(pos, 'start');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destKey, !!pos]);

  const track = useMemo(() => (route?.coordinates?.length >= 2 ? buildTrack(route.coordinates) : null), [route]);
  const stepAt = useMemo(() => (track && route?.steps ? stepPositions(track, route.steps) : []), [track, route]);
  const nav = track && pos && route?.steps?.length ? navState(track, route.steps, stepAt, route.durationS, pos, prevIdx.current) : null;
  if (nav) prevIdx.current = nav.segIdx;

  // Heading from movement (ignore GPS jitter under 3 m).
  useEffect(() => {
    if (!pos) return;
    const prev = lastPos.current;
    if (prev && distM(prev, pos) >= 3) setHeading(bearing(prev, pos));
    if (!prev || distM(prev, pos) >= 3) lastPos.current = pos;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.lat, position?.lng]);

  // Off-route detection -> re-route (two readings in a row, at most once every 6 s).
  useEffect(() => {
    if (!nav || status !== 'ok' || nav.arrived) return;
    offCount.current = nav.offRouteM > OFF_ROUTE_M ? offCount.current + 1 : 0;
    if (offCount.current >= 2 && Date.now() - lastReroute.current > 6000) fetchRoute(pos, 'reroute');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.lat, position?.lng, status]);

  // Voice guidance.
  useEffect(() => {
    if (!voice || !nav) return;
    const sp = spoken.current;
    if (nav.arrived) { if (!sp.arrived) { sp.arrived = true; speak(`You have arrived at ${destination.label}`); } return; }
    if (sp.step !== nav.stepIndex) {
      sp.step = nav.stepIndex;
      speak(nav.toStepM > 60 ? `In ${spokenDistance(nav.toStepM)}, ${nav.step.instruction}` : nav.step.instruction);
    } else if (nav.toStepM < 60 && sp.near !== nav.stepIndex) {
      sp.near = nav.stepIndex;
      speak(nav.step.instruction);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, nav?.stepIndex, nav?.arrived, Math.round((nav?.toStepM || 0) / 20)]);

  const toggleVoice = () => { const v = !voice; setVoice(v); storage.set('ov.navVoice', v ? '1' : '0'); if (v) speak('Voice guidance on'); };

  // Split the line into the part already travelled (grey) and the part ahead (green).
  let done = null; let ahead = route?.coordinates || null;
  if (track && nav) {
    const i = nav.segIdx + 1;
    done = [...route.coordinates.slice(0, i), pos];
    ahead = [pos, ...route.coordinates.slice(i)];
  }
  // Until the rider has moved, point the arrow along the route ahead.
  const shownHeading = heading ?? (ahead && ahead.length > 1 && pos ? bearing(pos, ahead.find((c) => distM(pos, c) > 5) || ahead[ahead.length - 1]) : 0);
  const arrival = nav ? new Date(Date.now() + nav.remainingS * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;

  const runAction = async () => {
    setBusy(true);
    try { await arrivedAction.run(); } finally { setBusy(false); }
  };

  return (
    <div className="nav-screen" role="dialog" aria-label="Navigation" data-testid="nav-screen">
      {/* Next maneuver */}
      <div className={`nav-banner ${nav?.arrived ? 'arrived' : ''}`} data-testid="nav-banner">
        {!pos ? (
          <div className="nav-wait">
            <b>Waiting for GPS…</b>
            {!sharing && <button className="btn sm" onClick={onStartGps} data-testid="nav-start-gps">Turn on GPS</button>}
          </div>
        ) : status === 'rerouting' ? (
          <div className="nav-wait" data-testid="nav-rerouting"><span className="spinner light" /><b>Rerouting…</b></div>
        ) : !nav ? (
          <div className="nav-wait"><span className="spinner light" /><b>{status === 'error' ? 'Could not load the route' : 'Finding the best route…'}</b></div>
        ) : nav.arrived ? (
          <div className="nav-main"><span className="nav-arrow"><Arrow step={{ type: 'arrive' }} /></span>
            <div><div className="nav-dist">Arrived</div><div className="nav-instr" data-testid="nav-instruction">{destination.label}</div></div></div>
        ) : (
          <>
            <div className="nav-main">
              <span className="nav-arrow"><Arrow step={nav.step} /></span>
              <div className="grow">
                <div className="nav-dist" data-testid="nav-distance">{nav.toStepM < 25 ? 'Now' : fmtDistance(nav.toStepM)}</div>
                <div className="nav-instr" data-testid="nav-instruction">{nav.step.instruction}</div>
              </div>
            </div>
            {nav.nextStep && nav.step.type !== 'arrive' && (
              <div className="nav-then"><span>Then</span><Arrow step={nav.nextStep} size={18} /><span className="truncate">{nav.nextStep.instruction}</span></div>
            )}
          </>
        )}
      </div>

      {/* Map that follows the rider */}
      <div className="nav-map">
        <MapContainer center={pos || [destination.lat, destination.lng]} zoom={17} zoomControl={false} style={{ height: '100%', width: '100%' }}>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {done && <Polyline positions={done} pathOptions={{ color: '#9aa1ae', weight: 7, opacity: 0.8 }} />}
          {ahead && <Polyline positions={ahead} pathOptions={{ color: '#ffffff', weight: 11, opacity: 0.95 }} />}
          {ahead && <Polyline positions={ahead} pathOptions={{ color: '#178a56', weight: 7, dashArray: route?.approximate ? '10 10' : null }} />}
          <Marker position={[destination.lat, destination.lng]} icon={destination.kind === 'pickup' ? ICONS.restaurant : ICONS.home} />
          {pos && <Marker position={pos} icon={riderIcon(shownHeading)} zIndexOffset={1000} />}
          <Follow pos={pos} following={following} onUserMove={() => setFollowing(false)} />
        </MapContainer>
        {!following && pos && <button className="nav-recenter" onClick={() => setFollowing(true)} data-testid="nav-recenter">Re-centre</button>}
        <button className={`nav-voice ${voice ? 'on' : ''}`} onClick={toggleVoice} aria-label={voice ? 'Mute voice guidance' : 'Turn on voice guidance'} title="Voice guidance">
          {voice ? '🔊' : '🔇'}
        </button>
      </div>

      {/* Trip summary / arrival */}
      <div className="nav-bottom">
        {nav?.arrived ? (
          <div className="nav-arrived" data-testid="nav-arrived">
            <div><b>You've arrived</b><small>{destination.label}</small></div>
            <div className="row">
              <button className="btn ghost" onClick={onExit}>Close</button>
              {arrivedAction && <button className="btn success lg" disabled={busy} onClick={runAction} data-testid="nav-arrived-action">{busy ? '…' : arrivedAction.label}</button>}
            </div>
          </div>
        ) : (
          <div className="nav-summary">
            <div className="grow">
              <div className="nav-eta" data-testid="nav-remaining">{nav ? `${fmtEta(nav.remainingS)} · ${fmtDistance(nav.remainingM)}` : '—'}</div>
              <small className="truncate">{nav ? `Arrive ${arrival} · ` : ''}{destination.label}</small>
            </div>
            <a className="btn ghost sm" href={navigateUrl(destination)} target="_blank" rel="noreferrer" title="Open in Google Maps">Google Maps</a>
            <button className="btn danger-solid sm" onClick={onExit} data-testid="nav-exit">Exit</button>
          </div>
        )}
      </div>
    </div>
  );
}