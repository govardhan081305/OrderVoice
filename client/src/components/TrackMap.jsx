import { useEffect, useRef } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const pin = (emoji, cls = '') => L.divIcon({ className: `map-pin ${cls}`, html: `<span>${emoji}</span>`, iconSize: [38, 38], iconAnchor: [19, 19] });
export const ICONS = { restaurant: pin('🍳'), home: pin('🏠', 'home'), agent: pin('🛵', 'agent') };
const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '&copy; OpenStreetMap contributors';

// Fits the map to the important points once per `fitKey` (not on every GPS update,
// so the map doesn't jump while the user is looking at it).
function fitTo(map, points, animate = false) {
  map.invalidateSize({ animate: false }); // the container may have been resized by the page layout
  // No animation for automatic fits: several can happen in quick succession (status,
  // live location, route) and overlapping zoom animations leave the map mis-zoomed.
  if (points.length === 1) map.setView(points[0], 15, { animate });
  else map.fitBounds(points, { padding: [36, 36], maxZoom: 16, animate });
}

function Fit({ points, fitKey }) {
  const map = useMap();
  const done = useRef(null);
  const latest = useRef(points);
  latest.current = points;
  useEffect(() => {
    if (done.current === fitKey || !points.length) return;
    done.current = fitKey;
    fitTo(map, points);
  }, [fitKey, points, map]);
  // Re-measure (and re-fit) when the map's box changes size, e.g. layout switches phone <-> laptop.
  useEffect(() => {
    const el = map.getContainer();
    let w = el.clientWidth; let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - w) < 2 && Math.abs(el.clientHeight - h) < 2) return;
      w = el.clientWidth; h = el.clientHeight;
      if (latest.current.length) fitTo(map, latest.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

// "Show all" button: zoom back out to see the whole route.
function FitButton({ points }) {
  const map = useMap();
  return (
    <button type="button" className="map-fit-btn" onClick={() => fitTo(map, points, true)} title="Show whole route" aria-label="Show whole route">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
    </button>
  );
}

// Live delivery map: restaurant, delivery address, delivery partner, and the road route.
export default function TrackMap({ restaurant, delivery, agent, route, fitKey = 'default', height }) {
  const pts = [restaurant && [restaurant.lat, restaurant.lng], delivery && [delivery.lat, delivery.lng], agent && [agent.lat, agent.lng]].filter(Boolean);
  if (!pts.length) return null;
  const line = route?.coordinates?.length ? route.coordinates : null;
  return (
    <div className="map-wrap" style={height ? { height } : undefined} data-testid="track-map">
      <MapContainer center={pts[0]} zoom={14} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution={ATTR} url={TILES} />
        {line && <Polyline positions={line} pathOptions={{ color: '#ffffff', weight: 9, opacity: 0.9 }} />}
        {line && <Polyline positions={line} pathOptions={{ color: '#178a56', weight: 5, opacity: 0.95, dashArray: route.approximate ? '8 8' : null }} />}
        {!line && restaurant && delivery && <Polyline positions={[[restaurant.lat, restaurant.lng], [delivery.lat, delivery.lng]]} pathOptions={{ color: '#14213d', weight: 3, dashArray: '6 8', opacity: 0.5 }} />}
        {restaurant && <Marker position={[restaurant.lat, restaurant.lng]} icon={ICONS.restaurant}><Tooltip>{restaurant.name || 'Restaurant'}</Tooltip></Marker>}
        {delivery && <Marker position={[delivery.lat, delivery.lng]} icon={ICONS.home}><Tooltip>Delivery address</Tooltip></Marker>}
        {agent && <Marker position={[agent.lat, agent.lng]} icon={ICONS.agent} zIndexOffset={1000}><Tooltip>Delivery partner</Tooltip></Marker>}
        <Fit points={line ? [...pts, ...line] : pts} fitKey={fitKey} />
        {pts.length > 1 && <FitButton points={line ? [...pts, ...line] : pts} />}
      </MapContainer>
    </div>
  );
}

function PickHandler({ onPick }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }, 'map') });
  return null;
}
function Recenter({ value, token }) {
  const map = useMap();
  useEffect(() => { if (value) map.setView([value.lat, value.lng], Math.max(map.getZoom(), 16)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);
  return null;
}

// Checkout map: tap the map or drag the pin to set the exact delivery spot.
export function LocationPicker({ value, center, restaurant, onPick, recenterToken }) {
  const start = value || center;
  return (
    <div className="map-wrap picker" data-testid="location-picker">
      <MapContainer center={[start.lat, start.lng]} zoom={value ? 16 : 13} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution={ATTR} url={TILES} />
        {restaurant && <Marker position={[restaurant.lat, restaurant.lng]} icon={ICONS.restaurant}><Tooltip>{restaurant.name}</Tooltip></Marker>}
        {value && (
          <Marker position={[value.lat, value.lng]} icon={ICONS.home} draggable zIndexOffset={1000}
            eventHandlers={{ dragend: (e) => { const p = e.target.getLatLng(); onPick({ lat: p.lat, lng: p.lng }, 'drag'); } }}>
            <Tooltip direction="top" offset={[0, -16]} permanent>Deliver here</Tooltip>
          </Marker>
        )}
        <PickHandler onPick={onPick} />
        <Recenter value={value} token={recenterToken} />
      </MapContainer>
      {!value && <div className="picker-hint">Tap the map to drop your delivery pin</div>}
    </div>
  );
}