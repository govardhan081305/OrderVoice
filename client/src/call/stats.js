// Reads call quality from RTCPeerConnection.getStats().
// These are the MEASURED numbers used in the project report (RTT, jitter, loss,
// bitrate, and whether the call went peer-to-peer or through the TURN relay).

export async function readStats(pc, prev) {
  const report = await pc.getStats();
  let pair = null;
  let inbound = null;
  const byId = new Map();
  report.forEach((s) => {
    byId.set(s.id, s);
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = s.selectedCandidatePairId;
  });
  let selected = pair ? byId.get(pair) : null;
  report.forEach((s) => {
    if (!selected && s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) selected = s;
    if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) inbound = s;
  });

  let connectionType = 'unknown';
  let rttMs = null;
  let candidateTypes = null;
  if (selected) {
    const local = byId.get(selected.localCandidateId);
    const remote = byId.get(selected.remoteCandidateId);
    candidateTypes = { local: local?.candidateType, remote: remote?.candidateType };
    connectionType = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
    if (selected.currentRoundTripTime != null) rttMs = selected.currentRoundTripTime * 1000;
  }

  let jitterMs = null;
  let lossPct = null;
  let bitrateKbps = null;
  let bytesReceived = prev?.bytesReceived ?? 0;
  const t = Date.now();
  if (inbound) {
    if (inbound.jitter != null) jitterMs = inbound.jitter * 1000;
    const lost = Math.max(0, inbound.packetsLost || 0);
    const recv = inbound.packetsReceived || 0;
    if (lost + recv > 0) lossPct = (lost / (lost + recv)) * 100;
    bytesReceived = inbound.bytesReceived || 0;
    if (prev?.t && bytesReceived >= prev.bytesReceived) {
      const secs = (t - prev.t) / 1000;
      if (secs > 0) bitrateKbps = ((bytesReceived - prev.bytesReceived) * 8) / 1000 / secs;
    }
  }
  return { connectionType, candidateTypes, rttMs, jitterMs, lossPct, bitrateKbps, bytesReceived, t };
}
