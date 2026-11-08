// OrderVoice call engine (browser side).
//
// Flow (caller = whoever taps "Call"; customer OR agent):
//   caller: getUserMedia -> fetch ICE config -> emit call:start ------------> server rings callee
//   callee: sees incoming screen -> Accept -> getUserMedia + ICE -> emit call:accept
//   caller: on call:accepted -> create offer -> signal(offer) ------------> callee
//   callee: on offer -> create answer -> signal(answer) -----------------> caller
//   both:   exchange ICE candidates via signal(candidate)
//   audio then flows browser-to-browser (or via TURN relay if direct fails).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, storage } from '../lib/api';
import { closeCallNotification } from '../lib/push';
import { useSocket } from '../lib/socket';
import { readStats } from './stats';
import { startRingback, startRingtone, stopTones } from './tones';
import CallScreen from './CallScreen';

const CallCtx = createContext(null);

const END_TEXT = {
  declined: 'Call declined',
  no_answer: 'No answer',
  caller_cancelled: 'Missed call',
  hangup: 'Call ended',
  disconnected: 'Connection lost',
  room_closed: 'Calling closed: order delivered or cancelled',
  connection_failed: 'Could not connect: network blocked a direct connection',
  mic_denied: 'Microphone permission is needed to call',
  busy: 'The other person is on another call',
  offline: 'The other person is offline right now',
  callee_offline: 'Their internet went off',
  peer_offline: 'Internet connection lost on the other side',
};

// The other side's internet is off (or dropped): end the internet call and offer a normal (masked) call.
const INTERNET_OFF = new Set(['offline', 'callee_offline', 'peer_offline', 'disconnected', 'connection_failed', 'push_no_answer']);
const firstName = (n) => (n || '').replace(/\(.*\)/, '').trim().split(/\s+/)[0] || 'They';
function internetOffText(reason, peer) {
  const n = firstName(peer?.name);
  if (reason === 'offline') return `${n}'s internet is off`;
  if (reason === 'callee_offline') return `${n}'s internet went off while ringing`;
  if (reason === 'push_no_answer') return `${n} didn't pick up. Their app is closed or they're offline`;
  return `Internet connection lost on ${n}'s side`;
}

export function CallProvider({ children }) {
  const { socket } = useSocket();
  const [call, setCall] = useState(null);
  const callRef = useRef(null);
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const pendingCandidates = useRef([]);
  const statsTimer = useRef(null);
  const closeTimer = useRef(null);
  const remoteAudio = useRef(null);
  const iceRef = useRef([]);
  const dropTimer = useRef(null);
  // Call to auto-answer: set when the user tapped "Answer" on the incoming-call notification.
  const pendingAnswer = useRef(null);

  const update = useCallback((patch) => {
    setCall((c) => {
      const next = c ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c;
      callRef.current = next;
      return next;
    });
  }, []);
  const set = useCallback((value) => { callRef.current = value; setCall(value); }, []);

  const cleanupMedia = useCallback(() => {
    stopTones();
    clearTimeout(dropTimer.current);
    clearInterval(statsTimer.current);
    statsTimer.current = null;
    if (pcRef.current) { try { pcRef.current.close(); } catch { /* closed */ } }
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    pendingCandidates.current = [];
    if (remoteAudio.current) remoteAudio.current.srcObject = null;
  }, []);

  // Show the "ended" state briefly, then close the screen.
  const showEnded = useCallback((reason, message) => {
    cleanupMedia();
    const base = callRef.current || { phase: 'ended' };
    set({ ...base, phase: 'ended', endReason: reason, message: message || END_TEXT[reason] || 'Call ended', internetOff: false });
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => set(null), 2500);
    // The other person's internet is off -> offer a normal (masked) call.
    if (INTERNET_OFF.has(reason) && base.orderId) {
      clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => set(null), 30_000);
      set({ ...base, phase: 'ended', endReason: reason, message: internetOffText(reason, base.peer), internetOff: true });
    }
  }, [cleanupMedia, set]);

  // ---- Normal (masked) call option ------------------------------------------
  // No call is placed here: the masking provider isn't connected in this
  // prototype. We show how the call would be connected and log the request.
  const showNormalCall = useCallback((orderId, peer, reason = 'offline') => {
    const prev = callRef.current;
    if (prev && prev.phase !== 'ended') return;
    cleanupMedia();
    clearTimeout(closeTimer.current);
    set({ phase: 'masked', orderId, peer: peer || prev?.peer, reason, selfOffline: reason === 'self_offline' });
    api.post('/calls/masked-request', { orderId, reason }).catch(() => {});
  }, [cleanupMedia, set]);

  const getMic = async () => {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      throw Object.assign(new Error('mic'), { reason: 'mic_denied' });
    }
  };

  const loadIce = async (orderId) => {
    const d = await api.get(`/calls/ice-config?orderId=${encodeURIComponent(orderId)}`);
    iceRef.current = d.iceServers;
  };

  const startStats = useCallback(() => {
    let prev = null;
    let tick = 0;
    clearInterval(statsTimer.current);
    statsTimer.current = setInterval(async () => {
      const pc = pcRef.current;
      const c = callRef.current;
      if (!pc || !c) return;
      try {
        const s = await readStats(pc, prev);
        prev = s;
        update({ quality: s });
        tick += 1;
        if (tick % 2 === 0) {
          socket?.emit('call:stats', {
            callId: c.callId,
            stats: { rttMs: s.rttMs, jitterMs: s.jitterMs, lossPct: s.lossPct, bitrateKbps: s.bitrateKbps, connectionType: s.connectionType },
          });
        }
      } catch { /* pc closed */ }
    }, 2000);
  }, [socket, update]);

  const createPeer = useCallback(() => {
    const forceRelay = storage.get('ov.forceRelay') === '1';
    const pc = new RTCPeerConnection({ iceServers: iceRef.current, iceTransportPolicy: forceRelay ? 'relay' : 'all' });
    pcRef.current = pc;
    streamRef.current.getTracks().forEach((t) => pc.addTrack(t, streamRef.current));
    pc.onicecandidate = (e) => {
      const c = callRef.current;
      if (e.candidate && c) socket.emit('signal', { callId: c.callId, data: { type: 'candidate', candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      if (remoteAudio.current) {
        remoteAudio.current.srcObject = e.streams[0] || new MediaStream([e.track]);
        remoteAudio.current.play().catch(() => {});
      }
    };
    pc.onconnectionstatechange = async () => {
      const c = callRef.current;
      if (!c || pcRef.current !== pc) return;
      if (pc.connectionState === 'connected') clearTimeout(dropTimer.current);
      if (pc.connectionState === 'connected' && c.phase !== 'connected') {
        stopTones();
        update({ phase: 'connected', connectedAt: Date.now() });
        let type = 'unknown';
        try { type = (await readStats(pc)).connectionType; } catch { /* ignore */ }
        socket.emit('call:connected', { callId: c.callId, connectionType: type });
        update({ connectionType: type });
        startStats();
      } else if (pc.connectionState === 'disconnected') {
        // Media stopped arriving (other side's internet dropped). Give it 6 s to recover.
        clearTimeout(dropTimer.current);
        dropTimer.current = setTimeout(() => {
          const cur = callRef.current;
          if (pcRef.current === pc && pc.connectionState !== 'connected' && cur?.callId) {
            socket.emit('call:end', { callId: cur.callId, reason: 'peer_offline' });
            showEnded('peer_offline');
          }
        }, 6000);
      } else if (pc.connectionState === 'failed') {
        clearTimeout(dropTimer.current);
        socket.emit('call:end', { callId: c.callId, reason: 'connection_failed' });
        showEnded('connection_failed');
      }
    };
    return pc;
  }, [socket, update, startStats, showEnded]);

  const flushCandidates = async (pc) => {
    for (const cand of pendingCandidates.current) { try { await pc.addIceCandidate(cand); } catch { /* stale */ } }
    pendingCandidates.current = [];
  };

  // ---- Public actions ------------------------------------------------------
  const startCall = useCallback(async (orderId, peer) => {
    if (!socket || callRef.current) return;
    clearTimeout(closeTimer.current);
    set({ phase: 'outgoing', direction: 'out', orderId, peer, muted: false, quality: null });
    try {
      streamRef.current = await getMic();
      await loadIce(orderId);
    } catch (e) {
      return showEnded(e.reason || 'error', e.reason ? undefined : e.message);
    }
    if (!callRef.current) { cleanupMedia(); return undefined; } // user hung up meanwhile
    socket.emit('call:start', { orderId }, (res) => {
      if (!res?.ok) return showEnded(res?.reason, res?.message);
      if (!callRef.current) { socket.emit('call:end', { callId: res.callId }); return cleanupMedia(); }
      update({ callId: res.callId, peer: res.callee || peer, notified: res.notified });
      startRingback();
      return undefined;
    });
    return undefined;
  }, [socket, set, update, showEnded, cleanupMedia]);

  const accept = useCallback(async () => {
    const c = callRef.current;
    if (!c || c.phase !== 'incoming') return;
    stopTones();
    closeCallNotification(c.callId);
    update({ phase: 'connecting' });
    try {
      streamRef.current = await getMic();
      await loadIce(c.orderId);
    } catch (e) {
      socket.emit('call:decline', { callId: c.callId });
      return showEnded(e.reason || 'error', e.reason ? undefined : e.message);
    }
    createPeer();
    socket.emit('call:accept', { callId: c.callId }, (res) => {
      if (!res?.ok) showEnded(res?.reason, res?.message || 'Call no longer available');
    });
    return undefined;
  }, [socket, update, createPeer, showEnded]);

  const acceptRef = useRef(null);
  acceptRef.current = accept;

  // Opened from a notification: ?answer=<callId> (Answer button) or ?ring=<callId> (tapped the notification).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get('answer');
    if (id) pendingAnswer.current = id;
    if (id || q.get('ring')) {
      q.delete('answer'); q.delete('ring');
      const rest = q.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    }
    // App already open in the background and the notification was tapped.
    const onMsg = (e) => {
      if (e.data?.type !== 'ov-open') return;
      if (e.data.answer) {
        const c = callRef.current;
        if (c?.phase === 'incoming' && c.callId === e.data.answer) acceptRef.current?.();
        else pendingAnswer.current = e.data.answer;
      }
      const path = new URL(e.data.url, window.location.origin).pathname;
      if (path !== window.location.pathname) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  const decline = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    socket.emit('call:decline', { callId: c.callId });
    stopTones();
    set(null);
  }, [socket, set]);

  const hangup = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    if (c.phase === 'ended') { set(null); return; }
    if (c.phase === 'masked') { set(null); return; }
    if (c.callId) socket.emit('call:end', { callId: c.callId, reason: 'hangup' });
    showEnded('hangup');
  }, [socket, set, showEnded]);

  const toggleMute = useCallback(() => {
    const c = callRef.current;
    if (!c || !streamRef.current) return;
    const muted = !c.muted;
    streamRef.current.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    update({ muted });
  }, [update]);

  // ---- Socket events -------------------------------------------------------
  useEffect(() => {
    if (!socket) return undefined;

    const onIncoming = (p) => {
      if (callRef.current && callRef.current.phase !== 'ended') {
        // Already on a call: the server prevents this, but be defensive.
        return;
      }
      clearTimeout(closeTimer.current);
      set({ phase: 'incoming', direction: 'in', callId: p.callId, orderId: p.orderId, restaurant: p.restaurant, peer: p.from, muted: false, quality: null });
      if (pendingAnswer.current === p.callId) {
        // Opened from the notification's "Answer" button: answer straight away.
        pendingAnswer.current = null;
        closeCallNotification(p.callId);
        setTimeout(() => acceptRef.current?.(), 150);
        return;
      }
      startRingtone();
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(`${p.from.name} is calling`, { body: `OrderVoice · Order ${p.orderId}`, tag: p.callId }); } catch { /* unsupported */ }
      }
    };

    const onAccepted = async ({ callId }) => {
      const c = callRef.current;
      if (!c || c.callId !== callId) return;
      stopTones();
      update({ phase: 'connecting' });
      const pc = createPeer();
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      socket.emit('signal', { callId, data: { type: 'offer', sdp: pc.localDescription.sdp } });
    };

    const onSignal = async ({ callId, data }) => {
      const c = callRef.current;
      const pc = pcRef.current;
      if (!c || c.callId !== callId || !pc) return;
      try {
        if (data.type === 'offer') {
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          await flushCandidates(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { callId, data: { type: 'answer', sdp: pc.localDescription.sdp } });
        } else if (data.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          await flushCandidates(pc);
        } else if (data.type === 'candidate' && data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
          else pendingCandidates.current.push(data.candidate);
        }
      } catch (e) {
        console.warn('[ordervoice] signal error', e);
      }
    };

    const onEnded = ({ callId, reason }) => {
      const c = callRef.current;
      if (!c || (c.callId && c.callId !== callId)) return;
      if (c.phase === 'incoming' && reason === 'caller_cancelled') return showEnded('caller_cancelled', `Missed call from ${c.peer?.name || 'caller'}`);
      return showEnded(reason);
    };

    const onTaken = ({ callId }) => {
      if (callRef.current?.callId === callId && callRef.current.phase === 'incoming') { stopTones(); set(null); }
    };

    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('signal', onSignal);
    socket.on('call:ended', onEnded);
    socket.on('call:taken', onTaken);
    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:accepted', onAccepted);
      socket.off('signal', onSignal);
      socket.off('call:ended', onEnded);
      socket.off('call:taken', onTaken);
    };
  }, [socket, set, update, createPeer, showEnded]);

  // Hang up cleanly if the tab is closed mid-call.
  useEffect(() => {
    const h = () => { const c = callRef.current; if (c?.callId && socket) socket.emit('call:end', { callId: c.callId, reason: 'hangup' }); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [socket]);

  return (
    <CallCtx.Provider value={{ call, startCall, showNormalCall, accept, decline, hangup, toggleMute }}>
      {children}
      <audio ref={remoteAudio} autoPlay playsInline data-testid="remote-audio" />
      {call && <CallScreen call={call} onAccept={accept} onDecline={decline} onHangup={hangup} onMute={toggleMute} onNormalCall={() => showNormalCall(call.orderId, call.peer, call.endReason)} />}
    </CallCtx.Provider>
  );
}

export const useCall = () => useContext(CallCtx);