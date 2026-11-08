import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupees, STATUS_LABEL, timeAgo } from '../../lib/api';
import { useSocketEvent } from '../../lib/socket';
import { Empty, PageHeader, Skeleton } from '../../components/Layout';
import { hue } from './Restaurants';

const ACTIVE = ['placed', 'accepted', 'picked_up', 'out_for_delivery'];

function OrderCard({ o }) {
  return (
    <Link to={`/orders/${o.id}`} className="card order-card" data-testid="order-card">
      <div className={`thumb ${hue(o.restaurant.id)}`}>{o.restaurant.emoji}</div>
      <div className="grow">
        <div className="oc-top">
          <h3 className="truncate">{o.restaurant.name}</h3>
          <span className={`badge s-${o.status}`}>{STATUS_LABEL[o.status]}</span>
        </div>
        <div className="oc-items truncate">{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</div>
        <div className="oc-foot">
          <span className="mono muted">{o.id}</span>
          <span><b>{rupees(o.total)}</b> <span className="faint">· {timeAgo(o.createdAt)}</span></span>
        </div>
      </div>
    </Link>
  );
}

export default function Orders() {
  const [orders, setOrders] = useState(null);
  const load = useCallback(() => { api.get('/orders').then((d) => setOrders(d.orders)).catch(() => setOrders([])); }, []);
  useEffect(load, [load]);
  useSocketEvent('order:update', load);

  if (!orders) return <div><PageHeader title="Your orders" /><Skeleton rows={3} height={110} /></div>;
  const active = orders.filter((o) => ACTIVE.includes(o.status));
  const past = orders.filter((o) => !ACTIVE.includes(o.status));

  return (
    <div>
      <PageHeader title="Your orders" subtitle="Track live orders and see your history" />
      {!orders.length && <Empty icon="orders" title="No orders yet" text="Your orders will show up here." action={<Link className="btn primary" to="/">Order something</Link>} />}
      {active.length > 0 && (
        <section style={{ marginBottom: 26 }}>
          <h2 className="section-title"><span className="live-dot" />Active <span className="count">{active.length}</span></h2>
          <div className="grid-cards">{active.map((o) => <OrderCard key={o.id} o={o} />)}</div>
        </section>
      )}
      {past.length > 0 && (
        <section>
          <h2 className="section-title">Past orders <span className="count">{past.length}</span></h2>
          <div className="grid-cards">{past.map((o) => <OrderCard key={o.id} o={o} />)}</div>
        </section>
      )}
    </div>
  );
}