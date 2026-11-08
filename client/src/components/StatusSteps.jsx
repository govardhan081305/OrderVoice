import Icon from './Icon';

const STEPS = [
  ['placed', 'Order placed', 'orders'],
  ['accepted', 'Partner assigned', 'user'],
  ['picked_up', 'Picked up', 'store'],
  ['out_for_delivery', 'On the way', 'bike'],
  ['delivered', 'Delivered', 'check'],
];

// Horizontal tracker on laptop, compact vertical timeline on phone (CSS decides).
export default function StatusSteps({ status, times = {} }) {
  if (status === 'cancelled') {
    return <div className="alert"><Icon name="x" size={18} /> This order was cancelled.</div>;
  }
  const idx = STEPS.findIndex(([s]) => s === status);
  const fmt = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null);
  return (
    <ol className="steps" data-testid="status-steps">
      {STEPS.map(([s, label, icon], i) => {
        const state = i < idx || status === 'delivered' ? 'done' : i === idx ? 'current' : 'todo';
        return (
          <li key={s} className={state}>
            <span className="step-dot"><Icon name={state === 'done' ? 'check' : icon} size={14} stroke={2.5} /></span>
            <span className="step-text">
              <span className="step-label">{label}</span>
              {fmt(times[s]) && <span className="step-time">{fmt(times[s])}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}