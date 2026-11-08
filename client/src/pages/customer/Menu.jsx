import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, rupees } from '../../lib/api';
import { useCart } from '../../lib/cart';
import Icon from '../../components/Icon';
import { PageHeader, Skeleton } from '../../components/Layout';
import { hue } from './Restaurants';

function QtyControl({ qty, onAdd, onRemove }) {
  if (!qty) return <button className="btn add" onClick={onAdd} data-testid="add-item">ADD</button>;
  return (
    <div className="stepper">
      <button onClick={onRemove} aria-label="Remove one"><Icon name="minus" size={16} stroke={2.5} /></button>
      <span>{qty}</span>
      <button onClick={onAdd} aria-label="Add one"><Icon name="plus" size={16} stroke={2.5} /></button>
    </div>
  );
}

export default function Menu() {
  const { id } = useParams();
  const cart = useCart();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/restaurants/${id}`).then(setData).catch((e) => setError(e.message)); }, [id]);

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <Skeleton rows={4} />;
  const { restaurant, menu } = data;
  const sameCart = cart.cart.restaurant?.id === restaurant.id;
  const otherCart = cart.cart.restaurant && !sameCart;
  const hasItems = sameCart && cart.count > 0;

  return (
    <div>
      <PageHeader back={['/', 'Restaurants']} title="" />
      <div className="split">
        <div className="stack">
          <div className="card rest-hero">
            <div className={`rest-emoji ${hue(restaurant.id)}`}>{restaurant.emoji}</div>
            <div className="grow">
              <h1>{restaurant.name}</h1>
              <div className="muted">{restaurant.cuisine}</div>
              <div className="meta-row">
                <span className="rating">★ {restaurant.rating.toFixed(1)}</span>
                <span><Icon name="clock" size={15} />{restaurant.eta_mins} min</span>
                <span><Icon name="pin" size={15} />{restaurant.address}</span>
              </div>
            </div>
          </div>

          {otherCart && <div className="alert info"><Icon name="info" size={18} />Adding items here will replace your cart from {cart.cart.restaurant.name}.</div>}

          <section className="card flush">
            <div className="menu-list">
              <div className="card-title" style={{ margin: '16px 0 0' }}><h3>Menu</h3><span className="muted small">{menu.length} items</span></div>
              {menu.map((m) => (
                <div key={m.id} className="menu-item">
                  <div className="grow">
                    <div className="item-name"><span className={`veg ${m.veg ? 'y' : 'n'}`} title={m.veg ? 'Veg' : 'Non-veg'} />{m.name}</div>
                    <div className="item-desc">{m.description}</div>
                    <div className="price">{rupees(m.price)}</div>
                  </div>
                  <QtyControl qty={sameCart ? cart.qtyOf(m.id) : 0} onAdd={() => cart.add(restaurant, m)} onRemove={() => cart.remove(m)} />
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Laptop: cart summary beside the menu */}
        <aside className="card sticky-side cart-side desktop-only">
          <div className="card-title"><h3><Icon name="cart" size={18} />Your cart</h3>{hasItems && <span className="muted small">{cart.count} items</span>}</div>
          {!hasItems ? (
            <p className="muted small">Your cart is empty. Add dishes from the menu to get started.</p>
          ) : (
            <>
              <ul className="lines">
                {cart.lines.map((l) => (
                  <li key={l.item.id}>
                    <span className="line-name">{l.item.name}<small>{rupees(l.item.price)}</small></span>
                    <div className="stepper sm">
                      <button onClick={() => cart.remove(l.item)} aria-label="Remove one"><Icon name="minus" size={14} stroke={2.5} /></button>
                      <span>{l.qty}</span>
                      <button onClick={() => cart.add(restaurant, l.item)} aria-label="Add one"><Icon name="plus" size={14} stroke={2.5} /></button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="totals"><div className="grand"><span>Subtotal</span><span>{rupees(cart.subtotal)}</span></div></div>
              <Link to="/cart" className="btn success block lg" style={{ marginTop: 14 }} data-testid="view-cart-side">Checkout <Icon name="next" size={18} /></Link>
            </>
          )}
        </aside>
      </div>

      {hasItems && (
        <Link to="/cart" className="mobile-cart-bar" data-testid="view-cart">
          <span>{cart.count} item{cart.count > 1 ? 's' : ''} · {rupees(cart.subtotal)}</span>
          <b>View cart <Icon name="next" size={18} /></b>
        </Link>
      )}
    </div>
  );
}