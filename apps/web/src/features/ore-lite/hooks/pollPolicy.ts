/**
 * Shared react-query poll policy for the ORE Lite hooks (the 2026-10-07
 * rate-limit incident: every poll ran at its full cadence — getSlot every
 * 2 s, snapshot + balance every 5 s — while the endpoint answered every
 * call with 429, so a single open erroring page burned ~1 req/s at the
 * key's budget forever).
 *
 *  - success → the hook's base cadence, never faster than 5 s
 *  - error   → the refetch interval doubles per consecutive failure,
 *              capped at 60 s, and snaps back to base on the first success
 *  - 429     → never retried within a cycle — backing off is the only
 *              correct answer to a rate limit; retrying it is what turns
 *              a spike into a flood
 */

export const ORE_POLL_BASE_MS = 5_000;
export const ORE_POLL_CAP_MS = 60_000;
/** Floor between a failed fetch and its single retry. */
export const ORE_RETRY_DELAY_MS = 3_000;

export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate\s?limit|too many requests/i.test(message);
}

/**
 * One retry for genuine failures, none for rate limits. The `Error`
 * parameter type is load-bearing: react-query infers the query's TError
 * from this callback, and `unknown` here would widen every hook's
 * `UseQueryResult<_, Error>` to `UseQueryResult<_, unknown>`.
 */
export function oreRetry(failureCount: number, error: Error): boolean {
  if (isRateLimitError(error)) return false;
  return failureCount < 1;
}

export function oreRetryDelay(): number {
  return ORE_RETRY_DELAY_MS;
}

/**
 * `refetchInterval` as a function: the query's own consecutive-fetch-
 * failure count (`state.fetchFailureCount`, reset on success) drives the
 * backoff, so no extra state is needed and the cadence snaps back to
 * base the moment a fetch succeeds.
 */
export function orePollInterval(baseMs: number = ORE_POLL_BASE_MS) {
  return (query: { state: { status: string; fetchFailureCount: number } }): number =>
    query.state.status === "error"
      ? Math.min(baseMs * 2 ** Math.min(query.state.fetchFailureCount, 4), ORE_POLL_CAP_MS)
      : baseMs;
}
