import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useCart } from '../lib/cart';
import { useSocket } from '../lib/socket';
import Icon from './Icon';

export const ROLE_LABEL = { customer: 'Customer', agent: 'Delivery partner', admin: 'Admin' };

const NAV = {
  customer: [['/', 'Home', 'home'], ['/orders', 'Orders', 'orders'], ['/cart', 'Cart', 'cart'], ['/account', 'Account', 'user']],
  agent: [['/agent', 'Deliveries', 'bike'], ['/account', 'Account', 'user']],
  admin: [['/admin', 'Dashboard', 'chart'], ['/account', 'Account', 'user']],
};

export const initials = (name = '') => name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';

// Laptop (>=1024px): left sidebar. Phone/tablet: top bar + bottom tab bar.
export default function Layout() {
  const { user, logout } = useAuth();
  const { connected } = useSocket();
  const cart = useCart();
  const nav = useNavigate();
  const items = NAV[user.role] || [];
  const badge = (to) => (to === '/cart' && cart.count > 0 ? <span className="nav-badge">{cart.count}</span> : null);
  const doLogout = () => { logout(); nav('/login'); };

  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/" className="logo"><img src="/favicon.svg" alt="" width="32" height="32" /><span>Order<b>Voice</b></span></Link>
        <nav className="side-nav" aria-label="Main">
          {items.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <Icon name={icon} /><span>{label}</span>{badge(to)}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <div className={`presence ${connected ? 'on' : ''}`}>
            <span className="dot" />{connected ? 'Online: can receive calls' : 'Reconnecting…'}
          </div>
          <div className="user-chip">
            <span className="avatar-sm">{initials(user.name)}</span>
            <div className="grow">
              <div className="uc-name">{user.name}</div>
              <div className="uc-role">{ROLE_LABEL[user.role]}</div>
            </div>
            <button className="icon-btn" onClick={doLogout} title="Log out" aria-label="Log out"><Icon name="logout" /></button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Link to="/" className="logo"><img src="/favicon.svg" alt="" width="28" height="28" /><span>Order<b>Voice</b></span></Link>
          <div className="topbar-right">
            <span className={`presence compact ${connected ? 'on' : ''}`} title={connected ? 'Online: can receive calls' : 'Reconnecting…'}><span className="dot" />{connected ? 'Online' : 'Offline'}</span>
            <Link to="/account" className="avatar-sm" aria-label="Account">{initials(user.name)}</Link>
          </div>
        </header>
        <main className="content"><Outlet /></main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {items.map(([to, label, icon]) => (
          <NavLink key={to} to={to} end={to === '/'}>
            <span className="tab-icon"><Icon name={icon} size={22} />{badge(to)}</span>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({ title, subtitle, back, actions, eyebrow }) {
  return (
    <div className="page-header">
      <div className="grow">
        {back && <Link to={back[0]} className="back-link"><Icon name="back" size={18} />{back[1]}</Link>}
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        {title && <h1>{title}</h1>}
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, text, action }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={30} /></div>
      <h3>{title}</h3>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 3, height = 76 }) {
  return <div className="skeleton-list">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ height }} />)}</div>;
}

export function Stat({ icon, tone = '', label, value, sub, testId }) {
  return (
    <div className="stat">
      <div className="stat-top"><span>{label}</span>{icon && <span className={`stat-icon ${tone}`}><Icon name={icon} size={16} /></span>}</div>
      <div className="stat-value" data-testid={testId}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}