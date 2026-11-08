import Icon from './Icon';

// Small banner: "Ravi is 1.8 km away · arriving in ~7 min".
export default function RouteInfo({ icon = 'bike', title, sub, muted, testId = 'route-info' }) {
  return (
    <div className={`route-info ${muted ? 'muted-bg' : ''}`} data-testid={testId}>
      <span className="ri-icon"><Icon name={icon} size={19} /></span>
      <div className="grow"><b>{title}</b>{sub && <small>{sub}</small>}</div>
    </div>
  );
}