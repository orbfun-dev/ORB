import type { Connection } from "@solana/web3.js";

/**
 * Confirms a signature at `confirmed` commitment with a hard timeout —
 * web3.js v1's poller can hang past the blockhash validity window, which
 * would leave the UI stuck in "pending" long after the outcome is knowable.
 * A timeout here does NOT mean the transaction failed: it means
 * confirmation is unknown ("sent, watch the explorer / account").
 */

export class ConfirmationTimeoutError extends Error {
  constructor(readonly signature: string) {
    super(`confirmation timed out for ${signature}`);
  }
}

export async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 45_000,
): Promise<void> {
  // The losing side of the race must die with it: an uncleared timer keeps
  // the rejection (and the handle) alive after a fast confirmation.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      connection.confirmTransaction(signature, "confirmed"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConfirmationTimeoutError(signature)), timeoutMs);
      }),
    ]);
    if (outcome.value.err !== null) {
      throw new Error(
        `transaction failed on-chain: ${JSON.stringify(outcome.value.err)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** First ~60 chars of a signature — enough to recognize, never to copy. */
export function shortSignature(signature: string): string {
  return `${signature.slice(0, 8)}…${signature.slice(-4)}`;
}
