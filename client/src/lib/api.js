// Small fetch wrapper that adds the JWT and turns errors into exceptions.
const TOKEN_KEY = 'ov.token';

export const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

export const getToken = () => storage.get(TOKEN_KEY);
export const setToken = (t) => (t ? storage.set(TOKEN_KEY, t) : storage.remove(TOKEN_KEY));

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('ov:logout'));
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b || {}),
};

export const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

export const STATUS_LABEL = {
  placed: 'Finding a delivery partner',
  accepted: 'Partner assigned',
  picked_up: 'Picked up',
  out_for_delivery: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const REASON_TEXT = {
  not_a_participant: 'Only the customer and assigned partner can call.',
  order_cancelled: 'Order cancelled: calling closed.',
  order_delivered: 'Order delivered: calling closed.',
  no_agent_assigned: 'Calling opens once a partner accepts.',
  room_closed: 'The call window for this order has closed.',
};

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export const fmtDuration = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;