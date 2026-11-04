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
  leaving?: boolean;
};
const TOAST_DURATION_MS = 7000;
const TOAST_EXIT_MS = 200;
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
    // Mark as leaving so the exit animation plays, then unmount.
    setToasts((current) =>
      current.map((toast) =>
        toast.id === id ? { ...toast, leaving: true } : toast,
      ),
    );
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, TOAST_EXIT_MS),
    );
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
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), TOAST_DURATION_MS),
        );
      }
    },
    [dismiss],
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
            className={`app-popup-surface app-toast pointer-events-auto relative flex min-w-0 items-center gap-2.5 overflow-hidden py-2.5 pl-3 pr-2 text-[13px] leading-5 text-white/90 ${toast.leaving ? 'app-toast-leaving' : ''}`}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${toast.variant === 'error' ? 'bg-red-300' : 'bg-emerald-300'}`}
            />
            <span className="min-w-0 flex-1 break-words">{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
              <button
                type="button"
                onClick={toast.onAction}
                className="app-button shrink-0 rounded px-1.5 text-white/85"
              >
                {toast.actionLabel}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
              className="app-button flex size-5 shrink-0 items-center justify-center rounded text-[15px] leading-none text-white/50 hover:text-white/85"
            >
              ×
            </button>
            {!toast.persistent && (
              <span
                aria-hidden="true"
                className="app-toast-progress"
                style={{ animationDuration: `${TOAST_DURATION_MS}ms` }}
              />
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
