import { X } from 'lucide-react';

/**
 * Reusable modal dialog. Click outside (overlay) or × to close.
 * @param {string} title    - modal heading
 * @param {node} children   - body content
 * @param {node} [footer]   - optional footer actions
 * @param {function} onClose - called when the modal should close
 */
export default function Modal({ title, children, footer, onClose }) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}