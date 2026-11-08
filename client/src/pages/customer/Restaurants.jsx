import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, STATUS_LABEL } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import Icon from '../../components/Icon';
import { Empty, Skeleton } from '../../components/Layout';
import { distanceM, fmtDistance, loadSavedAddress } from '../../lib/geo';

export const hue = (id) => `hue-${Number(id) % 6}`;
const ACTIVE = ['placed', 'accepted', 'picked_up', 'out_for_delivery'];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function Restaurants() {
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [active, setActive] = useState(null);
  const [q, setQ] = useState('');
  const [cuisine, setCuisine] = useState('All');
  const [error, setError] = useState('');
  const home = useMemo(() => { const a = loadSavedAddress(); return a.lat != null ? { lat: a.lat, lng: a.lng } : null; }, []);

  useEffect(() => {
    api.get('/restaurants').then((d) => setList(d.restaurants)).catch((e) => setError(e.message));
    api.get('/orders').then((d) => setActive(d.orders.find((o) => ACTIVE.includes(o.status)) || null)).catch(() => {});
  }, []);

  const cuisines = useMemo(() => ['All', ...new Set((list || []).map((r) => r.cuisine))], [list]);
  const shown = (list || []).filter((r) => (cuisine === 'All' || r.cuisine === cuisine)
    && `${r.name} ${r.cuisine} ${r.address}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div>
      <div className="page-header hello">
        <div className="grow">
          <div className="eyebrow">{greeting()}, {user.name.split(' ')[0]}</div>
          <h1>What would you like to eat?</h1>
        </div>
        <div className="search-box">
          <Icon name="search" size={18} />
          <input placeholder="Search restaurants or dishes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search restaurants" />
        </div>
      </div>

      {active && (
        <Link to={`/orders/${active.id}`} className="active-banner" data-testid="active-order-banner">
          <span className="ab-icon"><Icon name="bike" size={22} /></span>
          <span className="grow">
            <b>{STATUS_LABEL[active.status]}</b>
            <div className="ab-sub truncate">{active.restaurant.name} · {active.id}</div>
          </span>
          <span className="btn sm">Track</span>
        </Link>
      )}

      <div className="chips" role="tablist" aria-label="Cuisine">
        {cuisines.map((c) => <button key={c} className={`chip-btn ${cuisine === c ? 'on' : ''}`} onClick={() => setCuisine(c)}>{c}</button>)}
      </div>

      {error && <div className="alert">{error}</div>}
      {!list && !error && <Skeleton rows={4} height={210} />}
      {list && shown.length === 0 && <Empty icon="search" title="No matches" text="Try a different search or cuisine." />}

      <div className="grid-cards three">
        {shown.map((r) => (
          <Link to={`/r/${r.id}`} key={r.id} className="card rest-card" data-testid="restaurant-card">
            <div className={`rest-banner ${hue(r.id)}`}>
              <span>{r.emoji}</span>
              <span className="eta-pill"><Icon name="clock" size={13} />{r.eta_mins} min{home && ` · ${fmtDistance(distanceM(home, r) * 1.3)}`}</span>
            </div>
            <div className="rest-info">
              <div className="row"><h3 className="truncate">{r.name}</h3><span className="rating">★ {r.rating.toFixed(1)}</span></div>
              <div className="muted small truncate">{r.cuisine} · {r.address}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}