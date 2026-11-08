import { useCallback, useEffect, useState } from 'react';
import { api, fmtDuration, REASON_TEXT, timeAgo } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSocket, useSocketEvent } from '../lib/socket';
import { useCall } from '../call/CallProvider';
import Icon, { PhoneGlyph } from './Icon';

const STATUS_TEXT = {
  completed: 'Call', missed: 'Missed call', declined: 'Declined', busy: 'Busy', failed: 'Failed',
  ringing: 'Ringing', answered: 'Connecting', connected: 'In progress', requested: 'Normal call requested',
};
const OFF_REASONS = new Set(['offline', 'callee_offline', 'peer_offline', 'disconnected', 'connection_failed']);
const BAD = ['missed', 'declined', 'busy', 'failed'];

// "Call" button + call history, shown on both the customer and agent order screens.
export default function CallPanel({ order }) {
  const { user } = useAuth();
  const { connected } = useSocket();
  const { call, startCall, showNormalCall } = useCall();
  const [calls, setCalls] = useState([]);
  const [, tick] = useState(0);

  const peer = user.role === 'customer' ? order.agent && { ...order.agent, role: 'agent' } : order.customer && { ...order.customer, role: 'customer' };
  const load = useCallback(() => { api.get(`/orders/${order.id}/calls`).then((d) => setCalls(d.calls)).catch(() => {}); }, [order.id]);
  useEffect(load, [load, order.status]);
  useEffect(() => { if (!call) load(); }, [call, load]);
  useSocketEvent('call:ended', load);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);

  const allowed = order.call.allowed && (!order.call.closesAt || order.call.closesAt > Date.now());
  const minsLeft = order.call.closesAt ? Math.max(0, Math.ceil((order.call.closesAt - Date.now()) / 60000)) : null;
  const peerLabel = user.role === 'customer' ? 'Delivery partner' : 'Customer';
  // Own internet is off: the in-app call can't start, so show the normal-call (helpline) option.
  const selfOffline = allowed && !connected;
  const onCall = () => (selfOffline ? showNormalCall(order.id, peer, 'self_offline') : startCall(order.id, peer));

  return (
    <section className={`call-card ${allowed ? '' : 'closed'}`}>
      <div className="call-card-head">
        <div className="grow">
          <div className="eyebrow light"><Icon name="shield" size={13} /> OrderVoice call</div>
          <h3>{peer ? peer.name : 'Waiting for a partner'}</h3>
          <p className="cc-sub" data-testid="call-sub">
            {!allowed ? (REASON_TEXT[order.call.reason] || 'Calling is not available right now.')
              : selfOffline ? 'You\'re offline. Tap to see the normal call option.'
                : <>{peerLabel} · free internet call, number hidden{minsLeft != null && <> · closes in {minsLeft} min</>}</>}
          </p>
        </div>
        <button className="call-fab" disabled={!allowed || !!call} onClick={onCall} data-testid="start-call" aria-label={peer ? `Call ${peer.name}` : 'Call'}>
          <PhoneGlyph size={24} />
        </button>
      </div>
      {calls.length > 0 && (
        <ul className="call-log" data-testid="call-log">
          {calls.slice(0, 5).map((c) => {
            const mine = c.caller_role === user.role;
            const masked = c.channel === 'masked';
            return (
              <li key={c.id}>
                <span className={`cl-icon ${BAD.includes(c.status) ? 'bad' : ''}`}><Icon name={mine ? 'phoneOut' : 'phoneIn'} size={15} /></span>
                <span className="grow">
                  {STATUS_TEXT[c.status] || c.status}{c.duration_sec > 0 && ` · ${fmtDuration(c.duration_sec)}`}
                  {!masked && OFF_REASONS.has(c.end_reason) && <span className="cl-why"> · internet off</span>}
                </span>
                {masked ? <span className="tag">Normal</span>
                  : c.connection_type && <span className="tag">{c.connection_type === 'relay' ? 'Relay' : 'P2P'}</span>}
                <span className="cl-time">{timeAgo(c.created_at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}