import { useEffect, useRef } from 'react';

// Accessible in-app confirm dialog (replaces the browser's window.confirm).
export default function ConfirmDialog({ open, title, text, confirmLabel = 'Confirm', cancelLabel = 'Keep it', danger, onConfirm, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    ref.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="cd-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="cd-title">{title}</h3>
        {text && <p className="muted">{text}</p>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>{cancelLabel}</button>
          <button ref={ref} className={`btn ${danger ? 'danger-solid' : 'primary'}`} onClick={onConfirm} data-testid="confirm-yes">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}