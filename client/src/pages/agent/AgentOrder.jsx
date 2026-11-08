import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, rupees, STATUS_LABEL, storage } from '../../lib/api';
import { useSocket, useSocketEvent } from '../../lib/socket';
import StatusSteps from '../../components/StatusSteps';
import CallPanel from '../../components/CallPanel';
import TrackMap from '../../components/TrackMap';
import Icon from '../../components/Icon';
import { PageHeader, Skeleton } from '../../components/Layout';
import RouteInfo from '../../components/RouteInfo';
import NavigationView from '../../components/NavigationView';
import { distanceM, fmtDistance, fmtEta, geolocationGranted, navigateUrl, useRoute } from '../../lib/geo';

const NEXT = {
  accepted: ['picked_up', 'I\'ve picked up the order', 'store'],
  picked_up: ['out_for_delivery', 'Start delivery', 'bike'],
  out_for_delivery: ['delivered', 'Mark as delivered', 'check'],
};

export default function AgentOrder() {
  const { id } = useParams();
  const { socket } = useSocket();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState(null);
  const [sharing, setSharing] = useState(null); // 'gps' | 'sim' | null
  const [navOpen, setNavOpen] = useState(false);
  const [gpsWeak, setGpsWeak] = useState(false);
  const watchRef = useRef(null);
  const simRef = useRef(null);

  const load = useCallback(() => { api.get(`/orders/${id}`).then((d) => setOrder(d.order)).catch((e) => setError(e.message)); }, [id]);
  useEffect(load, [load]);
  useSocketEvent('order:update', useCallback((p) => { if (p.orderId === id) load(); }, [id, load]));

  const live = order && ['accepted', 'picked_up', 'out_for_delivery'].includes(order.status);

  const send = useCallback((lat, lng) => {
    setMe({ lat, lng });
    socket?.emit('agent:location', { orderId: id, lat, lng });
  }, [socket, id]);

  const stopSharing = useCallback(() => {
    if (watchRef.current != null) navigator.geolocation?.clearWatch(watchRef.current);
    clearInterval(simRef.current);
    watchRef.current = null; simRef.current = null;
    setSharing(null);
  }, []);
  useEffect(() => () => stopSharing(), [stopSharing]);
  useEffect(() => { if (order && !live) stopSharing(); }, [order, live, stopSharing]);

  const shareGps = () => {
    stopSharing();
    if (!window.isSecureContext) return setError('GPS needs a secure (https) page.');
    if (!navigator.geolocation) return setError('GPS is not available on this device');
    watchRef.current = navigator.geolocation.watchPosition(
      (p) => { setGpsWeak(false); send(p.coords.latitude, p.coords.longitude); },
      (e) => {
        // Only a permission denial is fatal. "Unavailable"/"timeout" happen briefly on real phones
        // (tunnels, indoors, GPS warming up): keep watching and show a soft warning.
        if (e.code === 1) { setError('Location permission is blocked. Allow it in the browser\'s site settings.'); stopSharing(); }
        else setGpsWeak(true);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    setSharing('gps');
    return undefined;
  };

  // Demo mode: drive the scooter to the NEXT stop (restaurant before pickup,
  // customer after) along the real road route, starting from the current
  // position (or ~1.5 km away if there is none yet). Navigation follows it.
  const simulate = async () => {
    stopSharing();
    const goingToRestaurant = order.status === 'accepted';
    const dest = goingToRestaurant ? order.restaurant : { lat: order.deliveryLat, lng: order.deliveryLng };
    const start = me || (goingToRestaurant ? { lat: dest.lat - 0.011, lng: dest.lng - 0.006 } : order.restaurant);
    let path = [[start.lat, start.lng], [dest.lat, dest.lng]];
    try {
      const r = await api.get(`/geo/route?from=${start.lat},${start.lng}&to=${dest.lat},${dest.lng}`);
      if (r.coordinates?.length >= 2) path = r.coordinates;
    } catch { /* straight line */ }
    const segs = [];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const d = distanceM({ lat: path[i - 1][0], lng: path[i - 1][1] }, { lat: path[i][0], lng: path[i][1] });
      segs.push({ from: path[i - 1], to: path[i], start: total, d });
      total += d;
    }
    const STEPS = 45;
    const at = (k) => {
      const target = (total * k) / STEPS;
      const sg = segs.find((x) => x.start + x.d >= target) || segs[segs.length - 1];
      const t = sg.d ? Math.min(1, (target - sg.start) / sg.d) : 1;
      return [sg.from[0] + (sg.to[0] - sg.from[0]) * t, sg.from[1] + (sg.to[1] - sg.from[1]) * t];
    };
    let step = 0;
    send(...at(0));
    const tick = storage.get('ov.simFast') === '1' ? 350 : 2000;
    simRef.current = setInterval(() => {
      step += 1;
      send(...at(Math.min(step, STEPS)));
      if (step >= STEPS) clearInterval(simRef.current);
    }, tick);
    setSharing('sim');
  };

  // Share GPS automatically if the browser already has location permission.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!live || autoTried.current) return;
    autoTried.current = true;
    geolocationGranted().then((ok) => { if (ok && !watchRef.current && !simRef.current) shareGps(); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const advance = async () => {
    setBusy(true); setError('');
    try { setOrder((await api.post(`/orders/${id}/status`, { status: NEXT[order.status][0] })).order); } catch (e) { setError(e.message); load(); } finally { setBusy(false); }
  };

  const delivery = order ? { lat: order.deliveryLat, lng: order.deliveryLng } : null;
  const goingToRestaurant = order?.status === 'accepted';
  const nextStop = !order ? null : goingToRestaurant ? { ...order.restaurant, label: `Pickup at ${order.restaurant.name}` } : { ...delivery, label: `Drop at ${order.customer?.name || 'customer'}` };
  const route = useRoute(!live ? [] : me ? [me, nextStop] : [order.restaurant, delivery]);

  if (error && !order) return <div className="alert">{error}</div>;
  if (!order) return <Skeleton rows={3} height={140} />;
  const next = NEXT[order.status];

  const setStatus = async (st) => setOrder((await api.post(`/orders/${id}/status`, { status: st })).order);
  // What to offer when the rider reaches the destination in navigation.
  const arrivedAction = order.status === 'accepted'
    ? { label: 'Picked up · start delivery', run: async () => { await setStatus('picked_up'); await setStatus('out_for_delivery'); } }
    : order.status === 'picked_up' ? { label: 'Start delivery', run: () => setStatus('out_for_delivery') }
      : order.status === 'out_for_delivery' ? { label: 'Mark as delivered', run: async () => { await setStatus('delivered'); setNavOpen(false); } }
        : null;
  const startNav = () => { if (!sharing) shareGps(); setNavOpen(true); };

  return (
    <div>
      <PageHeader back={['/agent', 'Deliveries']} title="" />
      <div className={`track-grid ${live ? '' : 'no-map'} ${next || error ? 'has-action' : ''}`}>
        <section className="card track-status ta-status">
          <div className="eyebrow">Order <span className="mono">{order.id}</span></div>
          <h1 data-testid="order-status">{STATUS_LABEL[order.status]}</h1>
          <StatusSteps status={order.status} times={{ placed: order.createdAt, accepted: order.acceptedAt, delivered: order.deliveredAt }} />
          <div style={{ marginTop: 18 }}>
            <div className="addr">
              <span className="addr-icon pick"><Icon name="store" size={18} /></span>
              <div className="grow"><div className="eyebrow">Pickup</div><b>{order.restaurant.name}</b><div className="muted small">{order.restaurant.address}</div></div>
            </div>
            <div className="addr">
              <span className="addr-icon drop"><Icon name="pin" size={18} /></span>
              <div className="grow"><div className="eyebrow">Drop</div><b>{order.customer?.name}</b><div className="muted small">{order.address}</div></div>
            </div>
          </div>
        </section>

        <div className="ta-call"><CallPanel order={order} /></div>

        {live && (
          <div className="ta-map stack">
            <section className="card">
              <div className="row between wrap">
                <div className="row">
                  <span className="set-icon"><Icon name="route" size={18} /></span>
                  <div>
                    <h3>Live location</h3>
                    <p className="muted small" data-testid="sharing-status">{sharing ? `Sharing with customer (${sharing === 'gps' ? 'GPS' : 'demo route'})` : 'Not sharing yet. The customer sees your position once you start.'}{sharing === 'gps' && gpsWeak && <span style={{ color: '#9a6200' }}> · weak GPS signal…</span>}</p>
                  </div>
                </div>
                <div className="row">
                  {sharing ? <button className="btn ghost sm" onClick={stopSharing}>Stop sharing</button> : (
                    <>
                      <button className="btn primary sm" onClick={shareGps} data-testid="share-gps"><Icon name="pin" size={16} />Share GPS</button>
                      <button className="btn ghost sm" onClick={simulate} data-testid="simulate-route"><Icon name="route" size={16} />Demo route</button>
                    </>
                  )}
                </div>
              </div>
              {me && route ? (
                <RouteInfo icon={goingToRestaurant ? 'store' : 'pin'} testId="agent-route"
                  title={`Next: ${nextStop.label}`}
                  sub={`${fmtDistance(route.distanceM)} · about ${fmtEta(route.durationS)} by road${route.approximate ? ' (approx.)' : ''}`} />
              ) : (
                <RouteInfo icon="route" muted testId="agent-route"
                  title={`Restaurant → customer: ${route ? fmtDistance(route.distanceM) : '…'}`}
                  sub={route ? `About ${fmtEta(route.durationS)} by road. Share your location to see your route.` : 'Loading route…'} />
              )}
              <div className="nav-buttons">
                <button className="btn success lg" onClick={startNav} data-testid="start-nav">
                  <Icon name="route" size={18} />Start navigation to {goingToRestaurant ? 'restaurant' : 'customer'}
                </button>
                <a className="btn ghost" href={navigateUrl(nextStop)} target="_blank" rel="noreferrer" data-testid="navigate">Google Maps</a>
              </div>
            </section>
            <TrackMap restaurant={order.restaurant} delivery={delivery} agent={me} route={route} fitKey={`${order.status}-${!!me}-${!!route}`} />
          </div>
        )}

        <section className="card ta-summary">
          <div className="card-title"><h3>Items</h3><span className="muted small">{order.items.reduce((s, i) => s + i.qty, 0)} items</span></div>
          <ul className="lines">{order.items.map((i, k) => <li key={k}><span className="line-name">{i.qty} × {i.name}</span><span className="amt">{rupees(i.qty * i.price)}</span></li>)}</ul>
          <div className="totals"><div className="grand"><span>Collect (cash)</span><span>{rupees(order.total)}</span></div></div>
        </section>

        {(next || error) && (
          <div className="ta-action stack">
            {error && <div className="alert">{error}</div>}
            {next && (
              <button className={`btn ${next[0] === 'delivered' ? 'success' : 'primary'} block lg`} disabled={busy} onClick={advance} data-testid="advance-status">
                <Icon name={next[2]} size={18} />{next[1]}
              </button>
            )}
          </div>
        )}
      </div>
      {navOpen && live && (
        <NavigationView
          destination={{ lat: nextStop.lat, lng: nextStop.lng, label: nextStop.label, kind: goingToRestaurant ? 'pickup' : 'drop' }}
          position={me}
          sharing={sharing}
          onStartGps={shareGps}
          arrivedAction={arrivedAction}
          onExit={() => setNavOpen(false)}
        />
      )}
    </div>
  );
}