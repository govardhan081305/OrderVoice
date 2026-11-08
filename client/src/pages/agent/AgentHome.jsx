import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, rupees, STATUS_LABEL, timeAgo } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useSocket, useSocketEvent } from '../../lib/socket';
import Icon from '../../components/Icon';
import { Empty, PageHeader, Skeleton, Stat } from '../../components/Layout';
import { hue } from '../customer/Restaurants';
import PushPrompt from '../../components/PushPrompt';

const ACTIVE = ['accepted', 'picked_up', 'out_for_delivery'];
const DELIVERY_FEE = 30;
const isToday = (ms) => ms && new Date(ms).toDateString() === new Date().toDateString();


export default function AgentHome() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { connected } = useSocket();
  const [available, setAvailable] = useState(null);
  const [mine, setMine] = useState([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    api.get('/orders/available').then((d) => setAvailable(d.orders)).catch((e) => setError(e.message));
    api.get('/orders').then((d) => setMine(d.orders)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useSocketEvent('orders:available-changed', load);
  useSocketEvent('order:update', load);

  const active = mine.filter((o) => ACTIVE.includes(o.status));
  const past = mine.filter((o) => !ACTIVE.includes(o.status));
  const today = mine.filter((o) => o.status === 'delivered' && isToday(o.deliveredAt));

  const accept = async (id) => {
    setBusyId(id); setError('');
    try { await api.post(`/orders/${id}/accept`); nav(`/agent/orders/${id}`); } catch (e) { setError(e.message); load(); } finally { setBusyId(null); }
  };

  return (
    <div>
      <PageHeader
        eyebrow={`Hi, ${user.name.split(' ')[0]}`}
        title="Deliveries"
        actions={<span className={`badge ${connected ? 's-delivered' : 's-placed'}`}>{connected ? 'Online · receiving orders' : 'Reconnecting…'}</span>}
      />

      <PushPrompt role="agent" />
      <div className="stat-grid">
        <Stat icon="bike" tone="b" label="Active" value={active.length} sub={active.length ? 'In progress' : 'Free for a new order'} />
        <Stat icon="check" tone="g" label="Delivered today" value={today.length} sub={`${mine.filter((o) => o.status === 'delivered').length} all time`} />
        <Stat icon="wallet" tone="a" label="Fees earned today" value={rupees(today.length * DELIVERY_FEE)} sub={`${rupees(DELIVERY_FEE)} per delivery`} />
        <Stat icon="orders" label="Cash collected today" value={rupees(today.reduce((s, o) => s + o.total, 0))} sub="Cash on delivery" />
      </div>

      {error && <div className="alert" style={{ marginBottom: 16 }}>{error}</div>}

      {active.length > 0 && (
        <section style={{ marginBottom: 26 }}>
          <h2 className="section-title"><span className="live-dot" />Current delivery</h2>
          {active.map((o) => (
            <Link key={o.id} to={`/agent/orders/${o.id}`} className="card job-card current-job" data-testid="active-delivery">
              <div className="job-head">
                <div className={`thumb ${hue(o.restaurant.id)}`}>{o.restaurant.emoji}</div>
                <div className="grow"><h3 className="truncate">{o.restaurant.name}</h3><div className="muted small mono">{o.id}</div></div>
                <span className={`badge s-${o.status}`}>{STATUS_LABEL[o.status]}</span>
              </div>
              <div className="job-route">
                <div><Icon name="store" size={16} /><span>{o.restaurant.address}</span></div>
                <div><Icon name="pin" size={16} /><span><b style={{ color: 'var(--ink)' }}>{o.customer?.name}</b> · {o.address}</span></div>
              </div>
              <div className="job-foot"><span className="job-amt">Collect {rupees(o.total)}</span><span className="btn primary sm">Open <Icon name="next" size={16} /></span></div>
            </Link>
          ))}
        </section>
      )}

      <section style={{ marginBottom: 26 }}>
        <h2 className="section-title">New orders near you {available && <span className="count">{available.length}</span>}</h2>
        {!available && <Skeleton rows={2} height={170} />}
        {available && available.length === 0 && <Empty icon="bike" title="No orders waiting" text="New orders appear here instantly. Keep this screen open." />}
        <div className="grid-cards three">
          {(available || []).map((o) => (
            <div key={o.id} className="card job-card" data-testid="available-order">
              <div className="job-head">
                <div className={`thumb ${hue(o.restaurant.id)}`}>{o.restaurant.emoji}</div>
                <div className="grow"><h3 className="truncate">{o.restaurant.name}</h3><div className="muted xs">{timeAgo(o.createdAt)}</div></div>
              </div>
              <div className="job-route">
                <div><Icon name="store" size={16} /><span>Pickup · {o.restaurant.address}</span></div>
                <div><Icon name="pin" size={16} /><span>Drop · {o.address}</span></div>
              </div>
              <div className="job-foot">
                <span><span className="job-amt">{rupees(o.total)}</span> <span className="muted small">· {o.items.reduce((s, i) => s + i.qty, 0)} items</span></span>
                <button className="btn success sm" disabled={busyId === o.id || active.length > 0} onClick={() => accept(o.id)} data-testid="accept-order"
                  title={active.length > 0 ? 'Finish your current delivery first' : ''}>
                  {busyId === o.id ? 'Accepting…' : 'Accept'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="section-title">History <span className="count">{past.length}</span></h2>
          <div className="card flush">
            <ul className="lines" style={{ padding: '0 18px' }}>
              {past.slice(0, 10).map((o) => (
                <li key={o.id}>
                  <Link to={`/agent/orders/${o.id}`} className="row grow" style={{ gap: 12 }}>
                    <span className={`thumb ${hue(o.restaurant.id)}`} style={{ width: 38, height: 38, fontSize: '1.1rem', borderRadius: 10 }}>{o.restaurant.emoji}</span>
                    <span className="line-name truncate">{o.restaurant.name}<small className="mono">{o.id} · {timeAgo(o.deliveredAt || o.createdAt)}</small></span>
                  </Link>
                  <span className="amt desktop-only">{rupees(o.total)}</span>
                  <span className={`badge s-${o.status}`}>{STATUS_LABEL[o.status]}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}