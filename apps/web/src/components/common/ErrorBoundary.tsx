import { Component, type ErrorInfo, type ReactNode } from "react";
import { Orbit, RotateCw } from "lucide-react";

/**
 * The root visual safety net (roadmap 7.6): an unexpected render error
 * replaces the tree with a branded recovery card instead of a white
 * screen. Chain state is never at risk — everything of consequence lives
 * on-chain; reload re-syncs from RPC.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[orbit-jackpot] render error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      // A crash screen is the one surface where reassurance IS the design:
      // the headline must land before the stack trace does, and "nothing is
      // lost" is the sentence the player needs. So the mark gets the brass
      // halo, the message gets the serif, and the trace is demoted to the
      // bottom in a sunken well.
      <div className="animate-rise flex min-h-full flex-col items-center justify-center gap-4 px-6 py-10 text-center">
        <span className="relative grid size-14 place-items-center rounded-full border border-orbit-gold/35 bg-orbit-panel">
          <span
            aria-hidden
            className="absolute -inset-3 animate-breathe rounded-full bg-orbit-gold/15 blur-xl"
          />
          <Orbit className="relative size-7 text-orbit-gold" />
        </span>
        <div>
          <h1 className="font-hero text-3xl leading-tight text-orbit-text sm:text-4xl">
            Something slipped out of orbit
          </h1>
          <p className="mx-auto mt-2.5 max-w-sm text-sm leading-relaxed text-orbit-text-mid">
            The interface hit an unexpected error.{" "}
            <span className="font-semibold text-orbit-text">
              Your funds live on-chain — nothing is lost.
            </span>{" "}
            Reload to re-sync from the network.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="pressable flex items-center gap-2 rounded-xl bg-gradient-to-b from-orbit-gold-bright via-orbit-gold to-[#c88f24] px-6 py-2.5 text-sm font-bold text-orbit-void shadow-[inset_0_1px_0_0_rgba(255,255,255,0.42),0_14px_32px_-14px_rgba(242,181,68,0.6)] hover:brightness-[1.07]"
        >
          <RotateCw className="size-4" /> Reload
        </button>
        <pre className="num mt-2 max-w-lg overflow-x-auto rounded-xl border border-orbit-line bg-orbit-void/60 px-4 py-3 text-left text-[11px] leading-relaxed text-orbit-muted shadow-[inset_0_2px_6px_rgba(0,0,0,0.5)]">
          {error.name}: {error.message}
        </pre>
      </div>
    );
  }
}
