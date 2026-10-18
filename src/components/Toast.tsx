import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

type Toast = {
  id: number;
  message: string;
  persistent: boolean;
  variant: 'error' | 'success';
  actionLabel?: string;
  onAction?: () => void;
};
type ToastContextValue = {
  notifyError: (message: string, persistent?: boolean) => void;
  notifySuccess: (
    message: string,
    action?: { label: string; onClick: () => void },
  ) => void;
};
const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const recentMessages = useRef(new Map<string, number>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const notify = useCallback(
    (
      message: string,
      persistent: boolean,
      variant: Toast['variant'],
      action?: { label: string; onClick: () => void },
    ) => {
      const text = message.trim();
      if (!text) return;
      const now = Date.now();
      if ((recentMessages.current.get(text) ?? 0) > now - 3000) return;
      recentMessages.current.set(text, now);
      const id = ++nextId.current;
      setToasts((current) => {
        const next = [
          ...current,
          {
            id,
            message: text,
            persistent,
            variant,
            actionLabel: action?.label,
            onAction: action?.onClick,
          },
        ];
        const removed = next.length > 3 ? next.shift()! : null;
        if (removed) {
          const oldTimer = timers.current.get(removed.id);
          if (oldTimer) clearTimeout(oldTimer);
          timers.current.delete(removed.id);
        }
        return next;
      });
      if (!persistent) {
        const timer = setTimeout(() => {
          timers.current.delete(id);
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }, 7000);
        timers.current.set(id, timer);
      }
    },
    [],
  );
  const notifyError = useCallback(
    (message: string, persistent = false) =>
      notify(message, persistent, 'error'),
    [notify],
  );
  const notifySuccess = useCallback(
    (message: string, action?: { label: string; onClick: () => void }) =>
      notify(message, false, 'success', action),
    [notify],
  );
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ notifyError, notifySuccess }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[1200] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
        aria-relevant="additions"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.variant === 'error' ? 'alert' : 'status'}
            className={`app-popup-surface pointer-events-auto flex min-w-0 items-start gap-3 border-l-2 ${toast.variant === 'error' ? 'border-l-red-300/70' : 'border-l-emerald-300/70'} px-3 py-2.5 text-[13px] leading-5 text-white/90`}
          >
            <span className="min-w-0 flex-1 break-words">{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
              <button
                type="button"
                onClick={toast.onAction}
                className="app-button shrink-0 px-1 text-white/80"
              >
                {toast.actionLabel}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
              className="app-button shrink-0 px-1 text-white/55"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
