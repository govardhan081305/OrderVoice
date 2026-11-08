import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { AuthHero, homeFor, ROLES, RolePicker } from './Login';

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const initialRole = ROLES.some(([r]) => r === params.get('role')) ? params.get('role') : 'customer';
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', role: initialRole, adminCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError('Passwords do not match');
    setBusy(true); setError('');
    try {
      const { confirm, ...body } = form; // eslint-disable-line no-unused-vars
      if (body.role !== 'admin') delete body.adminCode;
      nav(homeFor((await register(body)).role));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
    return undefined;
  };

  return (
    <div className="auth">
      <AuthHero />
      <div className="auth-main">
      <form className="auth-card" onSubmit={submit}>
        <div><h2>Create your account</h2><p className="muted small">Choose how you'll use OrderVoice</p></div>
        <RolePicker value={form.role} onChange={(role) => { setForm({ ...form, role }); setError(''); }} />
        <label>Full name<input value={form.name} onChange={set('name')} required maxLength={60} autoComplete="name" data-testid="name" /></label>
        <label>Email<input type="email" value={form.email} onChange={set('email')} required autoComplete="email" data-testid="email" /></label>
        <label>Password<input type="password" value={form.password} onChange={set('password')} required minLength={6} autoComplete="new-password" data-testid="password" /></label>
        <label>Confirm password<input type="password" value={form.confirm} onChange={set('confirm')} required minLength={6} autoComplete="new-password" data-testid="confirm" /></label>
        {form.role === 'admin' && (
          <label>Admin code<input value={form.adminCode} onChange={set('adminCode')} required autoComplete="off" data-testid="admin-code" />
            <span className="muted small" style={{ fontWeight: 400 }}>Set as ADMIN_SIGNUP_CODE on the server (shown in the server console in development).</span>
          </label>
        )}
        <p className="muted small">No phone number needed. Calls happen inside the app, tied to your Order ID.</p>
        {error && <div className="alert" data-testid="auth-error">{error}</div>}
        <button className="btn primary block" disabled={busy} data-testid="submit">{busy ? 'Creating…' : 'Create account'}</button>
        <p className="muted small center">Have an account? <Link to="/login">Log in</Link></p>
      </form>
      </div>
    </div>
  );
}