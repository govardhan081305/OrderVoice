import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, rupees, STATUS_LABEL } from '../../lib/api';
import { useSocket, useSocketEvent } from '../../lib/socket';
import StatusSteps from '../../components/StatusSteps';
import CallPanel from '../../components/CallPanel';
import TrackMap from '../../components/TrackMap';
import ConfirmDialog from '../../components/ConfirmDialog';
import Icon from '../../components/Icon';
import { PageHeader, Skeleton } from '../../components/Layout';
import { hue } from './Restaurants';
import RouteInfo from '../../components/RouteInfo';
import PushPrompt from '../../components/PushPrompt';
import { ago, distanceM, fmtDistance, fmtEta, useNow, useRoute } from '../../lib/geo';

const LIVE = ['accepted', 'picked_up', 'out_for_delivery'];

export default function OrderTrack() {
  const { id } = useParams();
  const { socket } = useSocket();
  const [order, setOrder] = useState(null);
  const [agentLoc, setAgentLoc] = useState(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const now = useNow(5000);

  const load = useCallback(() => { api.get(`/orders/${id}`).then((d) => setOrder(d.order)).catch((e) => setError(e.message)); }, [id]);
  useEffect(load, [load]);
  useSocketEvent('order:update', useCallback((p) => { if (p.orderId === id) load(); }, [id, load]));
  useSocketEvent('agent:location', useCallback((p) => { if (p.orderId === id) setAgentLoc(p); }, [id]));
  useEffect(() => {
    if (socket) socket.emit('order:last-location', { orderId: id }, (r) => { if (r?.ok && r.location) setAgentLoc(r.location); });
  }, [socket, id]);

  const cancel = async () => {
    setConfirm(false);
    try { setOrder((await api.post(`/orders/${id}/cancel`)).order); } catch (e) { setError(e.message); }
  };

  const live = order ? LIVE.includes(order.status) : false;
  const delivery = order && order.deliveryLat != null ? { lat: order.deliveryLat, lng: order.deliveryLng } : null;
  const agentPos = live && agentLoc ? { lat: agentLoc.lat, lng: agentLoc.lng } : null;
  // Route: partner -> restaurant -> you (before pickup), partner -> you (after pickup), or restaurant -> you.
  const routePoints = !order || !delivery ? []
    : agentPos ? (order.status === 'accepted' ? [agentPos, order.restaurant, delivery] : [agentPos, delivery])
      : (live || order.status === 'placed') ? [order.restaurant, delivery] : [];
  const route = useRoute(routePoints);

  if (error && !order) return <div className="alert">{error}</div>;
  if (!order) return <Skeleton rows={3} height={140} />;
  const showMap = live || order.status === 'placed';
  const agentName = order.agent?.name?.split(' ')[0] || 'Your partner';
  const km = route ? route.distanceM : (agentPos && delivery ? distanceM(agentPos, delivery) * 1.3 : null);
  const eta = route?.durationS;
  const seen = agentLoc ? ago(agentLoc.at, now) : null;
  const stale = agentLoc && now - agentLoc.at > 60_000;
  let routeInfo = null;
  if (agentPos && order.status === 'accepted') routeInfo = <RouteInfo icon="store" title={`${agentName} is heading to the restaurant`} sub={`${fmtDistance(km)} to you via ${order.restaurant.name}${eta ? ` · arriving in ~${fmtEta(eta + 600)}` : ''} · updated ${seen}`} />;
  else if (agentPos) routeInfo = <RouteInfo title={`${agentName} is ${fmtDistance(km)} away`} sub={`${eta ? `Arriving in ~${fmtEta(eta)}` : 'On the way'} · location ${stale ? `last seen ${seen}` : `updated ${seen}`}`} muted={stale} />;
  else if (live) routeInfo = <RouteInfo icon="pin" muted title={`Waiting for ${agentName}'s live location`} sub="The map updates as soon as they share it" />;
  else if (order.status === 'placed' && route) routeInfo = <RouteInfo icon="store" muted title={`${order.restaurant.name} is ${fmtDistance(route.distanceM)} from you`} sub={`About ${fmtEta(route.durationS)} by road`} />;
  const times = { placed: order.createdAt, accepted: order.acceptedAt, delivered: order.deliveredAt };

  return (
    <div>
      <PageHeader back={['/orders', 'Your orders']} title="" />
      {live && <PushPrompt role="customer" />}
      <div className={`track-grid ${showMap ? '' : 'no-map'}`}>
          <section className="card track-status ta-status">
            <div className="eyebrow">Order <span className="mono">{order.id}</span></div>
            <h1 data-testid="order-status">{STATUS_LABEL[order.status]}</h1>
            <p className="muted">
              {order.agent ? <>Delivery partner: <b style={{ color: 'var(--ink)' }}>{order.agent.name}</b></> : `From ${order.restaurant.name}`}
            </p>
            <StatusSteps status={order.status} times={times} />
            {order.status === 'placed' && <div className="searching"><span className="spinner" />Looking for a delivery partner nearby…</div>}
            {routeInfo}
          </section>

          <div className="ta-call"><CallPanel order={order} /></div>

          {showMap && (
            <div className="ta-map"><TrackMap
              restaurant={order.restaurant}
              delivery={delivery}
              agent={agentPos}
              route={route}
              fitKey={`${order.status}-${!!agentPos}-${!!route}`}
            /></div>
          )}

        <aside className="stack ta-summary">
          <section className="card">
            <div className="card-title">
              <h3><span className={`thumb ${hue(order.restaurant.id)}`} style={{ width: 36, height: 36, fontSize: '1.1rem', borderRadius: 10 }}>{order.restaurant.emoji}</span>{order.restaurant.name}</h3>
            </div>
            <ul className="lines">
              {order.items.map((i, k) => <li key={k}><span className="line-name">{i.qty} × {i.name}</span><span className="amt">{rupees(i.qty * i.price)}</span></li>)}
            </ul>
            <div className="totals">
              <div><span>Delivery fee</span><span>{rupees(30)}</span></div>
              <div className="grand"><span>Total</span><span>{rupees(order.total)}</span></div>
            </div>
            <div className="addr" style={{ marginTop: 16 }}>
              <span className="addr-icon drop"><Icon name="pin" size={18} /></span>
              <div><div className="eyebrow">Deliver to</div><div className="small">{order.address}</div></div>
            </div>
          </section>
          {error && <div className="alert">{error}</div>}
          {['placed', 'accepted'].includes(order.status) && (
            <button className="btn ghost danger block" onClick={() => setConfirm(true)}>Cancel order</button>
          )}
        </aside>
      </div>
      <ConfirmDialog open={confirm} title="Cancel this order?" text="The restaurant and delivery partner will be notified." confirmLabel="Yes, cancel" danger onConfirm={cancel} onCancel={() => setConfirm(false)} />
    </div>
  );
}