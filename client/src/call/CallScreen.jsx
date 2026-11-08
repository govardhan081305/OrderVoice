import { useEffect, useState } from 'react';
import { fmtDuration } from '../lib/api';

const ROLE = { customer: 'Customer', agent: 'Delivery partner' };

function Timer({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  return <span data-testid="call-timer">{fmtDuration(Math.max(0, Math.floor((Date.now() - since) / 1000)))}</span>;
}

const Icon = {
  phone: <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/></svg>,
  mic: <svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg>,
  micOff: <svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M19 11h-2c0 .7-.2 1.4-.4 2l1.5 1.5c.6-1 .9-2.2.9-3.5zM15 11.2V5a3 3 0 0 0-5.9-.7zM4.3 3 3 4.3l6 6V11a3 3 0 0 0 4.5 2.6l1.6 1.6A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.9V21h2v-3.1c1-.1 1.9-.5 2.7-1L19.7 21 21 19.7z"/></svg>,
  wifiOff: <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.3-1.6M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 11 5M12 20h.01" /></svg>,
};

const endButton = (onHangup) => (
  <button className="round-btn red big" onClick={onHangup} aria-label="End call" data-testid="end-call">
    <span style={{ transform: 'rotate(135deg)', display: 'flex' }}>{Icon.phone}</span>
  </button>
);

// How a normal (masked) call is connected by a provider such as Exotel — the
// same "one-click call" model Swiggy/Zomato use. Shown instead of placing a call.
function MaskedExplainer({ call, onClose }) {
  const name = call.peer?.name?.replace(/\(.*\)/, '').trim() || 'the other person';
  const steps = call.selfOffline ? [
    ['You dial the OrderVoice helpline', 'From your normal phone dialer: no internet needed.'],
    ['Provider recognises your number', `It finds your active order ${call.orderId}.`],
    [`It rings ${name}`, 'They see only the helpline / virtual number.'],
    ['You talk over the phone network', 'Neither of you sees the other\'s real number.'],
  ] : [
    ['OrderVoice asks the masking provider', `"Connect the customer and partner of order ${call.orderId}."`],
    ['Provider rings your phone', 'From a virtual number, e.g. +91 80 XXXX XXXX.'],
    [`Then it rings ${name}`, 'They see the same virtual number, not yours. Works without internet on their side.'],
    ['You talk over the normal phone network', 'Billed per minute by the provider: only for these calls.'],
  ];
  return (
    <div className="masked" data-testid="masked-explainer">
      <div className="masked-badge">{call.selfOffline ? 'You are offline' : 'Normal call'} · masked number</div>
      <h2>{call.selfOffline ? 'Call through the helpline' : `Call ${name} on their phone`}</h2>
      <p className="masked-sub">
        {call.selfOffline
          ? 'Your internet is off, so the in-app call can\'t start.'
          : `${name.split(' ')[0]}'s internet is off, so the free internet call can't connect.`}
        {' '}A number-masking provider connects you instead, like Swiggy and Zomato do.
      </p>
      <ol className="masked-steps">
        {steps.map(([t, d], i) => (
          <li key={t}><span className="ms-num">{i + 1}</span><span><b>{t}</b><small>{d}</small></span></li>
        ))}
      </ol>
      <div className="masked-note">Prototype: the masking provider (e.g. Exotel) is not connected, so no call is placed.</div>
      <button className="btn ghost light lg" onClick={onClose} data-testid="masked-close">Close</button>
    </div>
  );
}

export default function CallScreen({ call, onAccept, onDecline, onHangup, onMute, onNormalCall }) {
  const { phase, peer, orderId, quality, muted, connectedAt } = call;
  const name = peer?.name || 'Connecting…';
  const initials = name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  if (phase === 'masked') {
    return (
      <div className="call-screen phase-masked" role="dialog" aria-label="Normal call" data-testid="call-screen">
        <MaskedExplainer call={call} onClose={onHangup} />
      </div>
    );
  }

  const statusText = {
    outgoing: call.notified === 'push' ? 'Ringing their phone… (app closed)' : 'Ringing…',
    incoming: 'Incoming OrderVoice call',
    connecting: 'Connecting securely…',
    connected: null,
    ended: call.message,
  }[phase];

  const type = quality?.connectionType || call.connectionType;

  return (
    <div className={`call-screen phase-${phase}`} role="dialog" aria-label="OrderVoice call" data-testid="call-screen">
      <div className="call-top">
        <div className="call-brand">OrderVoice · Order <b>{orderId}</b></div>
        <div className="call-privacy">🔒 Internet call · numbers never shared</div>
      </div>

      <div className="call-center">
        <div className={`avatar-ring ${phase === 'incoming' || phase === 'outgoing' ? 'pulse' : ''}`}>
          <div className={`avatar ${call.internetOff ? 'off' : ''}`}>{initials || '?'}</div>
        </div>
        <h2 className="call-name" data-testid="call-peer">{name}</h2>
        <div className="call-role">{ROLE[peer?.role] || ''}{call.restaurant ? ` · ${call.restaurant}` : ''}</div>
        <div className={`call-status ${call.internetOff ? 'off' : ''}`} data-testid="call-status">
          {call.internetOff && Icon.wifiOff}
          {phase === 'connected' ? <>Connected · <Timer since={connectedAt} /></> : statusText}
        </div>

        {phase === 'connected' && (
          <div className="quality" data-testid="call-quality">
            <span className={`chip ${type === 'relay' ? 'chip-amber' : 'chip-green'}`} data-testid="conn-type">
              {type === 'relay' ? 'Via relay (TURN)' : type === 'direct' ? 'Direct peer-to-peer' : 'Measuring…'}
            </span>
            {quality?.rttMs != null && <span className="chip">RTT {Math.round(quality.rttMs)} ms</span>}
            {quality?.jitterMs != null && <span className="chip">Jitter {quality.jitterMs.toFixed(1)} ms</span>}
            {quality?.lossPct != null && <span className="chip">Loss {quality.lossPct.toFixed(1)}%</span>}
            {quality?.bitrateKbps != null && <span className="chip" data-testid="bitrate">{Math.round(quality.bitrateKbps)} kbps</span>}
          </div>
        )}

        {phase === 'ended' && call.internetOff && (
          <div className="fallback-offer" data-testid="internet-off">
            <p>The internet call has ended. You can still reach them with a <b>normal call</b>: it goes over the phone network, with both numbers hidden.</p>
          </div>
        )}
      </div>

      <div className="call-actions">
        {phase === 'incoming' ? (
          <>
            <button className="round-btn red" onClick={onDecline} aria-label="Decline" data-testid="decline-call">
              <span style={{ transform: 'rotate(135deg)', display: 'flex' }}>{Icon.phone}</span>
            </button>
            <button className="round-btn green big" onClick={onAccept} aria-label="Accept" data-testid="accept-call">{Icon.phone}</button>
          </>
        ) : phase === 'ended' && call.internetOff ? (
          <div className="fallback-actions">
            <button className="btn ghost light lg" onClick={onHangup}>Close</button>
            <button className="btn success lg" onClick={onNormalCall} data-testid="normal-call">📞 Normal call</button>
          </div>
        ) : phase === 'ended' ? (
          <button className="btn ghost light" onClick={onHangup}>Close</button>
        ) : (
          <>
            <button className={`round-btn ${muted ? 'white' : 'dim'}`} onClick={onMute} disabled={phase !== 'connected'} aria-label={muted ? 'Unmute' : 'Mute'} data-testid="mute-call">
              {muted ? Icon.micOff : Icon.mic}
            </button>
            {endButton(onHangup)}
          </>
        )}
      </div>
    </div>
  );
}