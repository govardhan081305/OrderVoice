import { useCallback, useEffect, useState } from 'react';
import { api, fmtDuration, STATUS_LABEL, timeAgo } from '../../lib/api';
import { useSocketEvent } from '../../lib/socket';
import Icon from '../../components/Icon';
import { Empty, PageHeader, Skeleton, Stat } from '../../components/Layout';

const fmt = (v, unit = '', d = 1) => (v == null ? '—' : `${Number(v).toFixed(d)}${unit}`);
const PATH = { relay: 'Relay', direct: 'P2P' };

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [calls, setCalls] = useState(null);
  const [rates, setRates] = useState({ pstnRate: '', egressPerGb: '' });
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (rates.pstnRate !== '') q.set('pstnRate', rates.pstnRate);
    if (rates.egressPerGb !== '') q.set('egressPerGb', rates.egressPerGb);
    api.get(`/admin/stats?${q}`).then((d) => {
      setStats(d);
      setRates((r) => ({
        pstnRate: r.pstnRate === '' ? String(d.cost.assumptions.pstnRatePerMin) : r.pstnRate,
        egressPerGb: r.egressPerGb === '' ? String(d.cost.assumptions.egressPerGb) : r.egressPerGb,
      }));
    }).catch((e) => setError(e.message));
    api.get('/admin/calls').then((d) => setCalls(d.calls)).catch(() => setCalls([]));
  }, [rates.pstnRate, rates.egressPerGb]);

  useEffect(load, [load]);
  useSocketEvent('admin:calls-changed', load);
  useSocketEvent('order:update', load);

  if (error) return <div className="alert">{error}</div>;
  if (!stats) return <div><PageHeader title="Dashboard" /><Skeleton rows={4} height={90} /></div>;
  const c = stats.calls;
  const totalOrders = Object.values(stats.orders).reduce((a, b) => a + b, 0);
  const totalCalls = Object.values(c.byStatus).reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader
        title="OrderVoice dashboard"
        subtitle="Measured from real calls made in the app. Updates live."
        actions={<span className={`badge ${c.live ? 's-out_for_delivery' : 's-delivered'}`}>{c.live} live call{c.live === 1 ? '' : 's'}</span>}
      />

      <h2 className="section-title">Activity</h2>
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <Stat icon="phoneOut" tone="b" label="Calls attempted" value={totalCalls} sub={`${c.connected} connected`} />
        <Stat icon="clock" tone="g" label="Talk time" value={fmt(c.totalMinutes, ' min', 1)} sub="Across connected calls" />
        <Stat icon="signal" tone="a" label="Calls via relay" value={fmt(c.relayCallPct, '%', 1)} sub="Rest went peer-to-peer" />
        <Stat icon="orders" label="Orders" value={totalOrders} sub={`${stats.orders.delivered || 0} delivered`} testId="kpi-orders" />
      </div>

      <h2 className="section-title">When internet is off</h2>
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <Stat icon="signal" tone="a" label="Internet-off events" value={c.internetOff} sub="Calls ended: other side offline" testId="kpi-internet-off" />
        <Stat icon="phoneOut" tone="b" label="Normal call requests" value={c.maskedRequests} sub="Would go via masking provider" testId="kpi-masked" />
        <Stat icon="wallet" tone="g" label="Free internet calls" value={c.connected} sub="Connected over the internet" />
        <Stat icon="info" label="Masking provider" value="Not connected" sub="Prototype (e.g. Exotel in production)" />
      </div>

      <h2 className="section-title">Call quality <span className="muted small" style={{ fontWeight: 500 }}>(average of connected calls)</span></h2>
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <Stat label="Round-trip time" value={fmt(c.avgRttMs, ' ms', 0)} sub="Lower is better · < 150 ms good" />
        <Stat label="Jitter" value={fmt(c.avgJitterMs, ' ms', 1)} sub="< 30 ms good" />
        <Stat label="Packet loss" value={fmt(c.avgPacketLossPct, '%', 2)} sub="< 1% good" />
        <Stat label="Audio bitrate" value={fmt(c.avgBitrateKbps, ' kbps', 0)} sub="Opus voice codec" />
      </div>

      <div className="two" style={{ marginBottom: 24 }}>
        <section className="card">
          <div className="card-title"><h3>Who starts calls</h3></div>
          <p className="muted small" style={{ marginBottom: 14 }}>Two-way calling in practice. Masked-number systems are often agent-to-customer only.</p>
          <div className="bars">
            {[['customer', 'Customer → Agent', ''], ['agent', 'Agent → Customer', 'b']].map(([r, label, tone]) => {
              const n = c.byCallerRole[r] || 0;
              return <div key={r} className="bar-row"><span>{label}</span><div className={`bar ${tone}`}><i style={{ width: `${totalCalls ? (n / totalCalls) * 100 : 0}%` }} /></div><b className="num">{n}</b></div>;
            })}
          </div>
          <div className="card-title" style={{ marginTop: 22 }}><h3>Call outcomes</h3></div>
          <div className="pill-row">
            {Object.keys(c.byStatus).length === 0 && <span className="muted small">No calls yet.</span>}
            {Object.entries(c.byStatus).map(([k, v]) => <span key={k} className={`badge c-${k}`}>{k} · {v}</span>)}
          </div>
        </section>

        <section className="card">
          <div className="card-title"><h3>Cost model</h3><span className="tag">Estimate</span></div>
          <p className="muted small">Variable cost of these internet calls vs the same minutes as masked phone calls. Rates are assumptions. Replace them with a real vendor quote and your cloud egress price. Normal (masked) calls would be billed per minute by the provider.</p>
          <div className="rate-inputs">
            <label>Masked call ₹/min<input type="number" step="0.01" min="0" value={rates.pstnRate} onChange={(e) => setRates({ ...rates, pstnRate: e.target.value })} /></label>
            <label>Cloud egress ₹/GB<input type="number" step="0.1" min="0" value={rates.egressPerGb} onChange={(e) => setRates({ ...rates, egressPerGb: e.target.value })} /></label>
          </div>
          <div className="totals">
            <div><span>As masked calls ({fmt(c.totalMinutes, ' min', 1)})</span><span>₹{stats.cost.pstnCost.toFixed(2)}</span></div>
            <div><span>OrderVoice internet relay ({fmt(c.relayMinutes, ' min', 1)})</span><span>₹{stats.cost.internetCost.toFixed(4)}</span></div>
            <div className="grand"><span>Variable cost saving</span><span style={{ color: 'var(--green-d)' }}>{stats.cost.savingPct == null ? '—' : `${stats.cost.savingPct}%`}</span></div>
          </div>
          <p className="muted xs" style={{ marginTop: 10 }}>Bitrate {stats.cost.assumptions.bitrateKbpsUsed} kbps ({stats.cost.assumptions.bitrateMeasured ? 'measured' : 'assumed'}). Excludes fixed server cost.</p>
        </section>
      </div>

      <h2 className="section-title">Recent calls {calls && <span className="count">{calls.length}</span>}</h2>
      {!calls && <Skeleton rows={3} height={56} />}
      {calls && calls.length === 0 && <Empty icon="phoneOut" title="No calls yet" text="Calls between customers and delivery partners will appear here." />}
      {calls && calls.length > 0 && (
        <>
          {/* Laptop/tablet: table */}
          <div className="card flush table-wrap desktop-table">
            <table className="table" data-testid="admin-calls">
              <thead><tr><th>When</th><th>Order</th><th>Channel</th><th>From → To</th><th>Status</th><th className="num">Duration</th><th>Path</th><th className="num">RTT ms</th><th className="num">Jitter</th><th className="num">Loss</th><th className="num">kbps</th></tr></thead>
              <tbody>
                {calls.map((x) => (
                  <tr key={x.id}>
                    <td>{timeAgo(x.created_at)}</td>
                    <td className="mono">{x.order_id}</td>
                    <td><span className="tag">{x.channel === 'masked' ? 'Normal' : 'Internet'}</span></td>
                    <td>{x.caller_name} <span className="faint">→</span> {x.callee_name}</td>
                    <td><span className={`badge c-${x.status}`}>{x.status}</span></td>
                    <td className="num">{x.duration_sec ? fmtDuration(x.duration_sec) : '—'}</td>
                    <td>{x.connection_type ? <span className="tag">{PATH[x.connection_type] || x.connection_type}</span> : '—'}</td>
                    <td className="num">{fmt(x.avg_rtt_ms, '', 0)}</td>
                    <td className="num">{fmt(x.jitter_ms, '', 1)}</td>
                    <td className="num">{fmt(x.packet_loss_pct, '%', 1)}</td>
                    <td className="num">{fmt(x.bitrate_kbps, '', 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Phone: cards */}
          <div className="card flush mobile-calls">
            {calls.map((x) => (
              <div key={x.id} className="call-item">
                <div className="row between">
                  <b className="truncate">{x.caller_name} <span className="faint">→</span> {x.callee_name}</b>
                  <span className={`badge c-${x.status}`}>{x.status}</span>
                </div>
                <div className="row between muted small"><span className="mono">{x.order_id}</span><span>{timeAgo(x.created_at)}</span></div>
                {x.duration_sec > 0 && (
                  <div className="metrics">
                    <span className="metric"><Icon name="clock" size={11} /> {fmtDuration(x.duration_sec)}</span>
                    <span className="metric">{x.channel === 'masked' ? 'Normal' : 'Internet'}</span>
                    {x.connection_type && <span className="metric">{PATH[x.connection_type]}</span>}
                    {x.avg_rtt_ms != null && <span className="metric">RTT {fmt(x.avg_rtt_ms, ' ms', 0)}</span>}
                    {x.jitter_ms != null && <span className="metric">Jitter {fmt(x.jitter_ms, ' ms', 1)}</span>}
                    {x.packet_loss_pct != null && <span className="metric">Loss {fmt(x.packet_loss_pct, '%', 1)}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <p className="muted xs" style={{ marginTop: 14 }}>Orders by status: {Object.entries(stats.orders).map(([k, v]) => `${STATUS_LABEL[k] || k} ${v}`).join(' · ') || 'none'}</p>
    </div>
  );
}