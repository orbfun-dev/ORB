/**
 * `?ref=` capture → localStorage → bind on first wallet connect.
 *
 * The three steps are deliberately separated in time, because the
 * person who clicks a referral link usually has no wallet connected
 * yet. Losing the referrer between the click and the connect is losing
 * the referral, so the code holds it across both.
 *
 * Attribution is FIRST TOUCH and the server makes it immutable — a
 * second link, later, changes nothing. That is the whole anti-abuse
 * property, so this module never overwrites a stored referrer it has
 * not yet managed to bind.
 *
 * The capture reads the query string, not the hash: `?ref=` survives
 * the hash router, and a link shared as `orb.xyz/?ref=ABC` lands on the
 * play page with the hash untouched.
 */

import { useEffect, useRef } from "react";
import { bindReferral } from "./api";

const PENDING_KEY = "orb.raffle.ref.pending";
const BOUND_KEY = "orb.raffle.ref.bound.";

/** Base58, 32–44 chars — the same shape the server will insist on. */
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode — the referral is lost, the page is not */
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* as above */
  }
}

/**
 * Step 1 — lift `?ref=` out of the URL and keep it.
 *
 * Called once at startup, before any wallet exists. The parameter is
 * stripped from the address bar afterwards: it has been banked, and
 * leaving it there means every subsequent share of that URL carries
 * the first visitor's referrer.
 */
export function captureReferralFromUrl(): void {
  let ref: string | null = null;
  try {
    ref = new URLSearchParams(window.location.search).get("ref");
  } catch {
    return;
  }
  if (ref === null || !PUBKEY_RE.test(ref)) return;

  // First touch wins locally too: an existing unbound referrer is not
  // replaced by a newer link.
  if (safeGet(PENDING_KEY) === null) safeSet(PENDING_KEY, ref);

  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("ref");
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* leaving the parameter in place is cosmetic, not a failure */
  }
}

/** Has this wallet already been through a successful bind attempt? */
function alreadyBound(wallet: string): boolean {
  return safeGet(BOUND_KEY + wallet) !== null;
}

/**
 * Step 2 — bind on first connect.
 *
 * Fires once per wallet per browser. The server is the real guard
 * (first touch, immutable, self- and sybil-checked); the local flag
 * only stops the page re-POSTing on every render.
 */
export function useReferralCapture(
  wallet: string | null,
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined,
): void {
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (wallet === null) return;
    // A wallet that cannot sign messages cannot prove consent (AUDIT R-3);
    // keep the referral pending for a wallet that can.
    if (signMessage === undefined) return;
    const ref = safeGet(PENDING_KEY);
    if (ref === null) return;
    if (ref === wallet) {
      // Clicked your own link. The server would refuse it anyway; drop
      // it here so it cannot sit in the way of a real one.
      safeRemove(PENDING_KEY);
      return;
    }
    if (alreadyBound(wallet) || attempted.current.has(wallet)) return;
    attempted.current.add(wallet);

    let cancelled = false;
    void (async () => {
      try {
        const result = await bindReferral(wallet, ref, signMessage);
        if (cancelled) return;
        // Every terminal answer — bound, already bound, or refused —
        // means stop asking. Only a network failure is worth a retry,
        // and that throws rather than returning.
        safeSet(BOUND_KEY + wallet, result);
        safeRemove(PENDING_KEY);
      } catch (err) {
        // The user declined the signature prompt: that is an answer — stop
        // asking. Anything else (offline, function down) retries on the
        // next connect.
        if (err instanceof Error && /reject|declin|denied|cancel/i.test(`${err.name} ${err.message}`)) {
          safeSet(BOUND_KEY + wallet, "declined");
          safeRemove(PENDING_KEY);
          return;
        }
        attempted.current.delete(wallet);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wallet, signMessage]);
}

/** The referrer waiting to be bound, for the page to acknowledge. */
export function pendingReferrer(): string | null {
  return safeGet(PENDING_KEY);
}

/** This wallet's share link. */
export function referralLink(wallet: string): string {
  try {
    const url = new URL(window.location.origin);
    url.searchParams.set("ref", wallet);
    return url.toString();
  } catch {
    return `?ref=${wallet}`;
  }
}
