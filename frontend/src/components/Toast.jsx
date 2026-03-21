import { useEffect } from "react";

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  return (
    <div className={`toast ${toast.type}`} role="status" aria-live="polite">
      <strong>{toast.title}</strong>
      <p>{toast.message}</p>
    </div>
  );
}

export default Toast;
