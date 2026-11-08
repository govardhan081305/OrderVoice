import { useEffect, useState } from 'react';
import { storage } from '../lib/api';
import { enablePush, pushStatus } from '../lib/push';
import Icon from './Icon';

// "Ring my phone when the app is closed" banner, shown until enabled or dismissed.
export default function PushPrompt({ role }) {
  const [st, setSt] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(storage.get('ov.pushPromptHidden') === '1');
  useEffect(() => { pushStatus().then(setSt); }, []);

  if (hidden || !st || st.subscribed || (!st.supported && !st.ios)) return null;
  const turnOn = async () => {
    setBusy(true); setMsg('');
    try { await enablePush(); setSt({ ...st, subscribed: true }); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="push-prompt" data-testid="push-prompt">
      <span className="pp-icon"><Icon name="bell" size={20} /></span>
      <div className="grow">
        <b>Don't miss calls</b>
        <small>{st.supported
          ? `Ring this phone for incoming calls${role === 'agent' ? ' and new orders' : ''} even when the app is closed.`
          : st.reason}</small>
        {msg && <small className="pp-err">{msg}</small>}
      </div>
      {st.supported && <button className="btn primary sm" onClick={turnOn} disabled={busy} data-testid="enable-push">{busy ? '…' : 'Turn on'}</button>}
      <button className="icon-btn" aria-label="Dismiss" onClick={() => { storage.set('ov.pushPromptHidden', '1'); setHidden(true); }}><Icon name="x" size={16} /></button>
    </div>
  );
}