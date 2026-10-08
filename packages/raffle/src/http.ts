/**
 * Server-side request guards for the raffle endpoints (R1/R2 posture).
 *
 * The browser's only contact with this system is these HTTPS endpoints
 * (R1): they never accept a client-supplied amount, wallet balance, or
 * entry count — a body carrying `amount` or `entries` at ANY depth is
 * rejected outright (P1 gate), so a hostile client cannot even suggest
 * the numbers the server derives from the chain (R2).
 */

import bs58 from "bs58";
import { createHash, timingSafeEqual } from "node:crypto";

/** Structural shapes of the Vercel Node function signatures we use. */
export interface RaffleRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

export interface RaffleResponse {
  status(code: number): { json(payload: unknown): void };
}

export interface JsonResponse {
  status: number;
  payload: unknown;
}

export function json(status: number, payload: unknown): JsonResponse {
  return { status, payload };
}

/** Thrown by guards; converted to a JSON error response at the boundary. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * R1/P1: no endpoint accepts a body that carries `amount` or `entries`
 * at any depth — those are server-derived facts (R2). The scan walks
 * plain objects and arrays only; anything else is opaque and fine.
 */
const FORBIDDEN_BODY_KEYS = new Set(["amount", "entries"]);

export function assertNoForbiddenBodyFields(body: unknown, depth = 0): void {
  if (depth > 16) return; // hostile nesting; stop, nothing this deep is trusted anyway
  if (Array.isArray(body)) {
    for (const item of body) assertNoForbiddenBodyFields(item, depth + 1);
    return;
  }
  if (body !== null && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (FORBIDDEN_BODY_KEYS.has(key.toLowerCase())) {
        throw new HttpError(
          400,
          "forbidden_body_field",
          `request body must not carry "${key}" — the server derives every amount from the chain`,
        );
      }
      assertNoForbiddenBodyFields(value, depth + 1);
    }
  }
}

/** Validated body: a plain JSON object (never an array/primitive). */
export function requireJsonObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new HttpError(400, "invalid_field", `${field} must be a short string`);
  }
  return value;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * True when `value` is base58 that decodes to exactly `bytes` bytes.
 * AUDIT R-13: the length regex alone let 31- and 33-byte strings through,
 * which persisted and later threw deep inside a lookup.
 */
export function isBase58Of(value: string, bytes: number): boolean {
  if (!BASE58.test(value)) return false;
  try {
    return bs58.decode(value).length === bytes;
  } catch {
    return false;
  }
}

/** Base58-checked 32-byte Solana public key (wallet addresses). */
export function requirePubkeyString(body: Record<string, unknown>, field: string): string {
  const value = requireString(body, field);
  if (value.length > 44 || !isBase58Of(value, 32)) {
    throw new HttpError(400, "invalid_field", `${field} is not a base58 pubkey`);
  }
  return value;
}

/** Base58 64-byte transaction signature. */
export function requireSignatureString(body: Record<string, unknown>, field = "signature"): string {
  const value = requireString(body, field);
  if (value.length > 88 || !isBase58Of(value, 64)) {
    throw new HttpError(400, "invalid_field", `${field} is not a transaction signature`);
  }
  return value;
}

/** Shared entry point: method gate + forbidden-field gate. */
export function guardRequest(
  req: RaffleRequest,
  opts: { method?: string } = {},
): void {
  const method = opts.method ?? "POST";
  if ((req.method ?? "GET").toUpperCase() !== method) {
    throw new HttpError(405, "method_not_allowed", `use ${method}`);
  }
  assertNoForbiddenBodyFields(req.body);
}

/** Converts a guard/orchestration failure into the JSON error response. */
export function handleError(err: unknown): JsonResponse {
  if (err instanceof HttpError) {
    return json(err.status, { error: err.code, message: err.message });
  }
  // AUDIT R-6: never echo internal error text to the caller — RPC
  // client errors embed the endpoint URL (API key included) and database
  // errors name functions and constraints. Log it server-side instead.
  const detail = (err instanceof Error ? err.message : String(err)).replace(
    /([?&](api-key|apikey|token|key)=)[^&\s"']+/gi,
    "$1***",
  );
  console.error(`raffle internal error: ${detail}`);
  return json(500, { error: "internal_error", message: "internal error" });
}

/**
 * The Vercel adapter: every /api/raffle/*.ts file is three lines calling
 * this with its orchestrator, so the guards above run on every endpoint.
 */
export async function serveRaffle(
  req: RaffleRequest,
  res: RaffleResponse,
  handler: (req: RaffleRequest) => Promise<JsonResponse>,
): Promise<void> {
  let response: JsonResponse;
  try {
    response = await handler(req);
  } catch (err) {
    response = handleError(err);
  }
  res.status(response.status).json(response.payload);
}

/**
 * The caller's IP as Vercel reports it (x-real-ip, else the first
 * x-forwarded-for hop); "unknown" when absent, which then shares one
 * bucket — strict, never open.
 */
export function clientIp(req: RaffleRequest): string {
  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const real = header("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

/** AUDIT R-9 — answers false when any bucket is over its limit. */
export interface RateLimiter {
  allow(buckets: Array<{ key: string; max: number }>): Promise<boolean>;
}

/** Per-minute limits. A purchase report repeats every 4 s while pending (15/min). */
export const RATE_LIMITS = {
  perIpPerMinute: 60,
  perWalletPerMinute: 30,
  referralPerWalletPerMinute: 6,
} as const;

/**
 * Throws 429 when over the limit. A limiter that itself fails is logged
 * and lets the request through: the limiter guards cost, it must never be
 * the reason a real user's credit fails.
 */
export async function enforceRateLimit(
  limiter: RateLimiter | undefined,
  buckets: Array<{ key: string; max: number }>,
): Promise<void> {
  if (limiter === undefined) return;
  let allowed: boolean;
  try {
    allowed = await limiter.allow(buckets);
  } catch (err) {
    console.error(`raffle rate limiter unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!allowed) {
    throw new HttpError(429, "rate_limited", "too many requests — try again in a minute");
  }
}

/**
 * Constant-time secret comparison (AUDIT R-13). Hashing first makes the
 * inputs equal-length; an unset expected secret never matches.
 */
export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || provided === undefined) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
