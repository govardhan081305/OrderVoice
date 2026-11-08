import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import Icon from '../components/Icon';

export const homeFor = (role) => ({ customer: '/', agent: '/agent', admin: '/admin' }[role] || '/');

export const ROLES = [
  ['customer', '🍽️', 'Customer'],
  ['agent', '🛵', 'Delivery partner'],
  ['admin', '🛡️', 'Admin'],
];

export function RolePicker({ value, onChange }) {
  return (
    <div className="segmented three" role="radiogroup" aria-label="Account type">
      {ROLES.map(([r, icon, label]) => (
        <button type="button" key={r} role="radio" aria-checked={value === r} className={value === r ? 'on' : ''} onClick={() => onChange(r)} data-testid={`role-${r}`}>
          <span className="seg-icon">{icon}</span>{label}
        </button>
      ))}
    </div>
  );
}

export function AuthHero() {
  return (
    <div className="auth-hero">
      <div className="logo big"><img src="/favicon.svg" alt="" width="44" height="44" /><span>Order<b>Voice</b></span></div>
      <h1>Call your delivery partner.<br /><em>No numbers shared.</em></h1>
      <ul className="hero-points">
        <li><span className="hp-icon"><Icon name="wallet" size={18} /></span><span><b>Free calls.</b> Internet calling, no per-minute telecom bill.</span></li>
        <li><span className="hp-icon"><Icon name="phoneIn" size={18} /></span><span><b>Two-way.</b> Customer or delivery partner can start the call.</span></li>
        <li><span className="hp-icon"><Icon name="shield" size={18} /></span><span><b>Private.</b> Tied to your Order ID; closes the moment it's delivered.</span></li>
      </ul>
    </div>
  );
}

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [role, setRole] = useState('customer');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const u = await login(email, password, role);
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      nav(homeFor(u.role));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="auth">
      <AuthHero />
      <div className="auth-main">
      <form className="auth-card" onSubmit={submit}>
        <div><h2>Welcome back</h2><p className="muted small">Log in to continue to OrderVoice</p></div>
        <RolePicker value={role} onChange={(r) => { setRole(r); setError(''); }} />
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" name="email" data-testid="email" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" name="password" data-testid="password" /></label>
        {error && <div className="alert" data-testid="auth-error">{error}</div>}
        <button className="btn primary block" disabled={busy} data-testid="submit">
          {busy ? 'Logging in…' : `Log in as ${ROLES.find(([r]) => r === role)[2]}`}
        </button>
        <p className="muted small center">New here? <Link to={`/register?role=${role}`} data-testid="go-register">Create an account</Link></p>
      </form>
      </div>
    </div>
  );
}