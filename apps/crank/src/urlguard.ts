/**
 * Guard for outbound oracle-gateway requests (they carry chain-derived
 * data): https only, and never localhost / loopback / private / reserved
 * hosts. Ported verbatim from `scripts/devnet/common.ts` — the exact
 * semantics proven live in phase 8, since the gateway URL arrives from an
 * on-chain oracle account and must never be trusted blind.
 */

export function assertSafeGatewayUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`gateway url must be https, got ${raw}`);
  }
  const host = url.hostname;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (ip !== null &&
      (ip[1]! === "10" ||
        ip[1]! === "127" ||
        ip[1]! === "0" ||
        (ip[1]! === "172" && Number(ip[2]) >= 16 && Number(ip[2]) <= 31) ||
        (ip[1]! === "192" && ip[2]! === "168") ||
        (ip[1]! === "169" && ip[2]! === "254")))
  ) {
    throw new Error(`gateway host ${host} is private/reserved — refusing`);
  }
}
