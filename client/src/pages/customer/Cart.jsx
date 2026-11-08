import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, rupees } from '../../lib/api';
import { useCart } from '../../lib/cart';
import { DELIVERY_RADIUS_KM, distanceM, fmtDistance, getCurrentPosition, loadSavedAddress, saveAddress } from '../../lib/geo';
import Icon from '../../components/Icon';
import { Empty, PageHeader } from '../../components/Layout';
import { LocationPicker } from '../../components/TrackMap';
import { hue } from './Restaurants';

export default function Cart() {
  const cart = useCart();
  const nav = useNavigate();
  const saved = useRef(loadSavedAddress()).current;
  const [pin, setPin] = useState(saved.lat != null ? { lat: saved.lat, lng: saved.lng } : null);
  const [area, setArea] = useState(saved.area);
  const [flat, setFlat] = useState(saved.flat);
  const [landmark, setLandmark] = useState(saved.landmark || '');
  const [locMsg, setLocMsg] = useState({ text: '', tone: '' });
  const [locating, setLocating] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [recenter, setRecenter] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lookupId = useRef(0);

  if (!cart.count) {
    return (
      <div>
        <PageHeader title="Cart" />
        <Empty icon="cart" title="Your cart is empty" text="Browse restaurants and add something tasty." action={<Link to="/" className="btn primary">Browse restaurants</Link>} />
      </div>
    );
  }

  const r = cart.cart.restaurant;
  const total = cart.subtotal + cart.deliveryFee;
  const dist = pin ? distanceM(pin, r) : null;
  const tooFar = dist != null && dist / 1000 > DELIVERY_RADIUS_KM;
  const fullAddress = [flat.trim(), area.trim(), landmark.trim() && `Landmark: ${landmark.trim()}`].filter(Boolean).join(', ');
  const canPlace = !!pin && area.trim().length >= 5 && !tooFar && !busy;

  // Pin moved (GPS, tap, drag or search) -> look up the street address for it.
  const setPinAndLookup = async (p, source) => {
    setPin(p);
    setResults(null);
    if (source === 'search') return; // address already known
    const id = ++lookupId.current;
    setLocMsg({ text: 'Finding the address for this spot…', tone: '' });
    try {
      const a = await api.get(`/geo/reverse?lat=${p.lat}&lng=${p.lng}`);
      if (id !== lookupId.current) return;
      setArea(a.address);
      setLocMsg({ text: source === 'gps' ? 'Address filled from your current location. Add your flat / house number below.' : 'Address updated from the map pin.', tone: 'ok' });
    } catch (e) {
      if (id !== lookupId.current) return;
      setLocMsg({ text: `${e.message} The pin is saved.`, tone: 'warn' });
    }
  };

  const useMyLocation = async () => {
    setLocating(true);
    setLocMsg({ text: 'Getting your location…', tone: '' });
    try {
      const p = await getCurrentPosition();
      setRecenter((x) => x + 1);
      await setPinAndLookup({ lat: p.lat, lng: p.lng }, 'gps');
    } catch (e) {
      setLocMsg({ text: e.message, tone: 'warn' });
    } finally { setLocating(false); }
  };

  const search = async (e) => {
    e.preventDefault();
    if (query.trim().length < 3) return;
    setSearching(true); setResults(null);
    try {
      const d = await api.get(`/geo/search?${new URLSearchParams({ q: query, near: `${r.lat},${r.lng}` })}`);
      setResults(d.results);
    } catch (err) { setResults([]); setLocMsg({ text: err.message, tone: 'warn' }); } finally { setSearching(false); }
  };

  const pickResult = (res) => {
    setArea(res.label);
    setQuery('');
    setRecenter((x) => x + 1);
    setPinAndLookup({ lat: res.lat, lng: res.lng }, 'search');
    setLocMsg({ text: 'Location set. Drag the pin to your exact building if needed.', tone: 'ok' });
  };

  const place = async () => {
    setBusy(true); setError('');
    try {
      saveAddress({ flat: flat.trim(), landmark: landmark.trim(), area: area.trim(), lat: pin.lat, lng: pin.lng });
      const { order } = await api.post('/orders', {
        restaurantId: r.id, items: cart.lines.map((l) => ({ menuItemId: l.item.id, qty: l.qty })),
        address: fullAddress, lat: pin.lat, lng: pin.lng,
      });
      cart.clear();
      nav(`/orders/${order.id}`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="Checkout" subtitle="Review your order and set your delivery location" />
      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-title">
              <h3><span className={`thumb ${hue(r.id)}`} style={{ width: 36, height: 36, fontSize: '1.1rem', borderRadius: 10 }}>{r.emoji}</span>{r.name}</h3>
              <Link to={`/r/${r.id}`} className="btn ghost sm">Add more</Link>
            </div>
            <ul className="lines">
              {cart.lines.map((l) => (
                <li key={l.item.id}>
                  <span className={`veg ${l.item.veg ? 'y' : 'n'}`} />
                  <span className="line-name">{l.item.name}<small>{rupees(l.item.price)} each</small></span>
                  <div className="stepper sm">
                    <button onClick={() => cart.remove(l.item)} aria-label="Remove one"><Icon name="minus" size={14} stroke={2.5} /></button>
                    <span>{l.qty}</span>
                    <button onClick={() => cart.add(r, l.item)} aria-label="Add one"><Icon name="plus" size={14} stroke={2.5} /></button>
                  </div>
                  <span className="amt">{rupees(l.item.price * l.qty)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <div className="card-title"><h3><Icon name="pin" size={18} />Delivery location</h3>
              {dist != null && <span className={`badge ${tooFar ? 's-cancelled' : 's-accepted'}`} data-testid="distance">{fmtDistance(dist)} from {r.name}</span>}
            </div>

            <div className="loc-actions">
              <button className="btn primary" type="button" onClick={useMyLocation} disabled={locating} data-testid="use-location">
                <Icon name="pin" size={17} />{locating ? 'Locating…' : 'Use my current location'}
              </button>
              <form className="loc-search" onSubmit={search}>
                <Icon name="search" size={17} />
                <input placeholder="Search area, street or landmark" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="address-search" />
                <button className="btn ghost sm" disabled={searching || query.trim().length < 3}>{searching ? '…' : 'Search'}</button>
              </form>
            </div>
            {results && (
              <ul className="search-results" data-testid="search-results">
                {results.length === 0 && <li className="muted small">No places found. Try a nearby landmark, or tap the map.</li>}
                {results.map((res, i) => (
                  <li key={i}><button type="button" onClick={() => pickResult(res)}><Icon name="pin" size={15} /><span><b>{res.label.split(',')[0]}</b><small>{res.label}</small></span></button></li>
                ))}
              </ul>
            )}

            <LocationPicker value={pin} center={r} restaurant={r} onPick={setPinAndLookup} recenterToken={recenter} />
            {locMsg.text && <p className={`loc-msg ${locMsg.tone}`} data-testid="loc-msg">{locMsg.text}</p>}
            {tooFar && <div className="alert" style={{ marginTop: 10 }}><Icon name="info" size={18} />This spot is {fmtDistance(dist)} away. {r.name} delivers within {DELIVERY_RADIUS_KM} km.</div>}

            <div className="two" style={{ marginTop: 14 }}>
              <label>Flat / house no. / floor
                <input value={flat} onChange={(e) => setFlat(e.target.value)} placeholder="e.g. Flat 302, 3rd floor" data-testid="flat" />
              </label>
              <label>Landmark (optional)
                <input placeholder="e.g. Near HSR BDA complex" value={landmark} onChange={(e) => setLandmark(e.target.value)} maxLength={80} />
              </label>
            </div>
            <label style={{ marginTop: 12 }}>Street &amp; area
              <textarea rows={2} placeholder="Filled automatically from the map, or type it" value={area} onChange={(e) => setArea(e.target.value)} data-testid="address" />
            </label>
          </section>
        </div>

        <aside className="card sticky-side">
          <div className="card-title"><h3>Bill summary</h3></div>
          <div className="totals" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
            <div><span>Item total</span><span>{rupees(cart.subtotal)}</span></div>
            <div><span>Delivery fee</span><span>{rupees(cart.deliveryFee)}</span></div>
            <div className="grand"><span>To pay</span><span>{rupees(total)}</span></div>
          </div>
          {fullAddress && pin && (
            <div className="addr" style={{ marginTop: 14 }}>
              <span className="addr-icon drop"><Icon name="pin" size={18} /></span>
              <div><div className="eyebrow">Deliver to</div><div className="small" data-testid="deliver-to">{fullAddress}</div></div>
            </div>
          )}
          <div className="note" style={{ margin: '16px 0' }}><Icon name="shield" size={18} /><span>Your delivery partner will reach you through <b>OrderVoice</b> in-app calls. Your phone number is never shared.</span></div>
          {error && <div className="alert" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn success block lg" disabled={!canPlace} onClick={place} data-testid="place-order">
            {busy ? 'Placing order…' : `Place order · ${rupees(total)}`}
          </button>
          <p className="muted xs center" style={{ marginTop: 8 }}>
            {!pin ? 'Set your delivery location on the map to continue' : area.trim().length < 5 ? 'Add your street & area to continue' : tooFar ? 'Choose a location within the delivery area' : 'Payment: cash on delivery'}
          </p>
        </aside>
      </div>
    </div>
  );
}