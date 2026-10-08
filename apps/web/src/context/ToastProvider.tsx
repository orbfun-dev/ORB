/**
 * Minimal toast stack (roadmap 7.4 — "toast notifications").
 *
 * Custom instead of a dependency: four kinds, auto-dismiss, dismiss button
 * — everything the tx hooks need to surface pending/success/failure
 * without pulling a library. Errors persist longer than successes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";

export type ToastKind = "info" | "success" | "error" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastApi {
  push: (kind: ToastKind, title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * One colour per meaning. Previously success wore the refund blue while
 * error and warning BOTH wore gold — so a failed transaction and a
 * stretched deadline looked identical, and nothing in the stack could be
 * triaged by colour alone. Now: cyan informs, green confirms, brass warns,
 * red fails.
 */
const KIND_STYLE: Record<ToastKind, string> = {
  info: "border-orbit-cyan/40 text-orbit-cyan",
  success: "border-orbit-green/45 text-orbit-green",
  warning: "border-orbit-gold/50 text-orbit-gold",
  error: "border-orbit-red/50 text-orbit-red-bright",
};

/** The accent rail colour for each kind (CSS colour, for the inline bar). */
const KIND_TONE: Record<ToastKind, string> = {
  info: "#3bd9cb",
  success: "#3ecf78",
  warning: "#f2b544",
  error: "#ff5c46",
};

const KIND_ICON: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
};

const TTL_MS: Record<ToastKind, number> = {
  info: 5_000,
  success: 6_000,
  warning: 8_000,
  error: 9_000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, detail?: string) => {
      const id = seq.current++;
      setToasts((current) => [...current.slice(-4), { id, kind, title, detail }]);
      window.setTimeout(() => dismiss(id), TTL_MS[kind]);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((toast) => {
          const Icon = KIND_ICON[toast.kind];
          return (
            <div
              key={toast.id}
              role="status"
              className={`animate-toast-in pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-xl border bg-orbit-panel/95 py-2.5 pl-4 pr-3 shadow-[0_22px_50px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl ${KIND_STYLE[toast.kind]}`}
            >
              {/* The accent rail: kind is readable from the edge of vision,
                  before any text has been parsed. */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{
                  backgroundColor: KIND_TONE[toast.kind],
                  boxShadow: `0 0 12px ${KIND_TONE[toast.kind]}`,
                }}
              />
              <Icon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-orbit-text">{toast.title}</div>
                {toast.detail !== undefined && (
                  <div className="num mt-0.5 break-words text-[11px] leading-relaxed text-orbit-muted">
                    {toast.detail}
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label="dismiss"
                onClick={() => dismiss(toast.id)}
                className="pressable -mr-1 mt-px rounded-md p-1 text-orbit-muted hover:bg-orbit-panel-3 hover:text-orbit-text"
              >
                <X className="size-3.5" />
              </button>
              {/* The toast's own lifetime, draining — so a message that is
                  about to vanish says so instead of just vanishing. */}
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-px origin-left"
                style={{
                  backgroundColor: KIND_TONE[toast.kind],
                  opacity: 0.45,
                  animation: `toast-life ${TTL_MS[toast.kind]}ms linear forwards`,
                }}
              />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToast requires <ToastProvider>");
  }
  return ctx;
}
