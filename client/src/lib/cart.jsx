import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { storage } from './api';

const CartCtx = createContext(null);
const KEY = 'ov.cart';

// Cart holds items from a single restaurant (like real delivery apps).
export function CartProvider({ children }) {
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(storage.get(KEY)) || { restaurant: null, items: {} }; } catch { return { restaurant: null, items: {} }; }
  });
  useEffect(() => { storage.set(KEY, JSON.stringify(cart)); }, [cart]);

  const value = useMemo(() => {
    const lines = Object.values(cart.items);
    const count = lines.reduce((s, l) => s + l.qty, 0);
    const subtotal = lines.reduce((s, l) => s + l.qty * l.item.price, 0);
    return {
      cart, lines, count, subtotal, deliveryFee: lines.length ? 30 : 0,
      qtyOf: (id) => cart.items[id]?.qty || 0,
      add(restaurant, item) {
        setCart((c) => {
          const base = c.restaurant && c.restaurant.id !== restaurant.id ? { restaurant, items: {} } : { ...c, restaurant };
          const cur = base.items[item.id]?.qty || 0;
          return { ...base, items: { ...base.items, [item.id]: { item, qty: Math.min(20, cur + 1) } } };
        });
      },
      remove(item) {
        setCart((c) => {
          const cur = c.items[item.id]?.qty || 0;
          const items = { ...c.items };
          if (cur <= 1) delete items[item.id]; else items[item.id] = { item, qty: cur - 1 };
          return { restaurant: Object.keys(items).length ? c.restaurant : null, items };
        });
      },
      clear: () => setCart({ restaurant: null, items: {} }),
    };
  }, [cart]);

  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}

export const useCart = () => useContext(CartCtx);
