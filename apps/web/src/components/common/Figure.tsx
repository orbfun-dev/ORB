/**
 * Live-figure primitives.
 *
 * This is a surface whose whole point is numbers that move — pots,
 * countdowns, entry counts — and a number that silently swaps from 4.2 to
 * 6.8 between two paint frames is information the player never receives.
 * `Figure` flashes the glyphs when the underlying value changes, so a
 * deposit landing in the pot is *felt*.
 *
 * The flash is driven by restarting a CSS animation on the DOM node, not
 * by React state: the value changes on the provider's 3 s poll (and on
 * every websocket event), and re-rendering a subtree to animate it would
 * put paint work on the data path. `prefers-reduced-motion` collapses the
 * keyframes to nothing in styles.css, so the figure still updates — it
 * just does not draw attention to itself.
 */

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Restarts the `flash` keyframes whenever `value` changes identity.
 * `value` is compared with `===`, which is exactly right for the bigints
 * and strings every figure here is derived from.
 */
export function useFlashOnChange<T>(value: T): (node: HTMLElement | null) => void {
  const nodeRef = useRef<HTMLElement | null>(null);
  const previous = useRef<T>(value);
  const mounted = useRef(false);

  useEffect(() => {
    // Never flash on first paint — the page load animation owns that
    // moment, and a wall of flashing figures on arrival reads as an error
    // state rather than as liveness.
    if (!mounted.current) {
      mounted.current = true;
      previous.current = value;
      return;
    }
    if (previous.current === value) return;
    previous.current = value;
    const node = nodeRef.current;
    if (node === null) return;
    node.classList.remove("animate-flash");
    void node.offsetWidth; // reflow: without it the re-added class is a no-op
    node.classList.add("animate-flash");
  }, [value]);

  return (node: HTMLElement | null): void => {
    nodeRef.current = node;
  };
}

interface FigureProps {
  /** The value whose change triggers the flash (bigint, number, string). */
  value: unknown;
  className?: string;
  children: ReactNode;
}

/** A figure that announces its own changes. */
export function Figure({ value, className, children }: FigureProps) {
  const attach = useFlashOnChange(value);
  return (
    <span ref={attach} className={className}>
      {children}
    </span>
  );
}

interface LiveDotProps {
  /** Hex or CSS colour for the dot and its halo. */
  tone: string;
  /** Pulsing halo — reserved for genuinely live streams. */
  pulse?: boolean;
  className?: string;
}

/**
 * The liveness indicator: a dot with a halo that expands and fades. Used
 * for feed health, where "is this page actually connected" is the single
 * most important thing the chrome communicates.
 */
export function LiveDot({ tone, pulse = false, className = "" }: LiveDotProps) {
  return (
    <span className={`relative flex size-2 shrink-0 items-center justify-center ${className}`}>
      {pulse && (
        <span
          className="absolute inset-0 animate-ping-ring rounded-full"
          style={{ backgroundColor: tone }}
          aria-hidden
        />
      )}
      <span
        className="relative size-2 rounded-full"
        style={{ backgroundColor: tone, boxShadow: `0 0 8px ${tone}` }}
        aria-hidden
      />
    </span>
  );
}
