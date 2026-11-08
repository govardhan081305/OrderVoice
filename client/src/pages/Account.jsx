import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { storage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSocket } from '../lib/socket';
import Icon from '../components/Icon';
import { enablePush, pushStatus, sendTestPush } from '../lib/push';
import { initials, PageHeader, ROLE_LABEL } from '../components/Layout';

export default function Account() {
  const { user, logout } = useAuth();
  const { connected } = useSocket();
  const nav = useNavigate();
  const [push, setPush] = useState(null);
  const [pushMsg, setPushMsg] = useState('');
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => { pushStatus().then(setPush); }, []);
  const turnOnPush = async () => {
    setPushBusy(true); setPushMsg('');
    try { await enablePush(); setPush(await pushStatus()); setPushMsg('Call alerts are on for this device.'); } catch (e) { setPushMsg(e.message); } finally { setPushBusy(false); }
  };
  const testPush = async () => {
    setPushMsg('');
    try { await sendTestPush(); setPushMsg('Test sent. You should see a notification in a few seconds.'); } catch (e) { setPushMsg(e.message); }
  };
  const [relay, setRelay] = useState(storage.get('ov.forceRelay') === '1');

  const toggleRelay = () => { const v = !relay; storage.set('ov.forceRelay', v ? '1' : '0'); setRelay(v); };

  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="Account" subtitle="Your profile and call settings" />
      <div className="stack">
        <section className="card profile">
          <span className="avatar-lg">{initials(user.name)}</span>
          <div className="grow">
            <h2 className="truncate">{user.name}</h2>
            <div className="muted small truncate">{user.email}</div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="badge s-accepted">{ROLE_LABEL[user.role]}</span>
              <span className={`badge ${connected ? 's-delivered' : 's-placed'}`}>{connected ? 'Online' : 'Reconnecting'}</span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-title"><h3>Call settings</h3></div>
          <ul className="settings">
            <li>
              <span className="set-icon"><Icon name="bell" size={18} /></span>
              <div className="grow">
                <b>Ring my phone when the app is closed</b>
                <div className="muted small">{push && !push.supported ? push.reason : 'Incoming calls (and order updates) show as a ringing notification with Answer / Decline, even when OrderVoice is closed.'}</div>
                {pushMsg && <div className="small" style={{ marginTop: 4, color: pushMsg.includes('on for') || pushMsg.includes('Test sent') ? 'var(--green-d)' : '#9a6200' }} data-testid="push-msg">{pushMsg}</div>}
              </div>
              {!push ? null : !push.supported ? <span className="badge">Not available</span>
                : push.subscribed ? <div className="row"><span className="badge s-delivered" data-testid="push-on">On</span><button className="btn ghost sm" onClick={testPush}>Test</button></div>
                  : <button className="btn primary sm" onClick={turnOnPush} disabled={pushBusy} data-testid="account-enable-push">{pushBusy ? '…' : 'Turn on'}</button>}
            </li>
            <li>
              <span className="set-icon"><Icon name="signal" size={18} /></span>
              <div className="grow"><b>Always use relay server</b><div className="muted small">For testing TURN: forces every call through the relay instead of peer-to-peer.</div></div>
              <button className={`switch ${relay ? 'on' : ''}`} role="switch" aria-checked={relay} aria-label="Always use relay server" onClick={toggleRelay} />
            </li>
          </ul>
        </section>

        <section className="card">
          <div className="card-title"><h3>Privacy</h3></div>
          <ul className="settings">
            <li><span className="set-icon"><Icon name="shield" size={18} /></span><div className="grow"><b>Your number is never shared</b><div className="muted small">Calls run inside the app over the internet, tied to the Order ID.</div></div></li>
            <li><span className="set-icon"><Icon name="check" size={18} /></span><div className="grow"><b>Calls close on delivery</b><div className="muted small">Once an order is delivered or cancelled, neither side can call.</div></div></li>
            <li><span className="set-icon"><Icon name="signal" size={18} /></span><div className="grow"><b>If internet is off</b><div className="muted small">The app tells you, ends the internet call and shows the normal (masked) call option.</div></div></li>
            <li><span className="set-icon"><Icon name="x" size={18} /></span><div className="grow"><b>No recordings</b><div className="muted small">Only call time and quality are logged, never audio.</div></div></li>
          </ul>
        </section>

        <button className="btn ghost danger block lg" onClick={() => { logout(); nav('/login'); }} data-testid="logout"><Icon name="logout" size={18} />Log out</button>
      </div>
    </div>
  );
}