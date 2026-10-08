/**
 * @orbit-jackpot/sdk — the client mirror of the Orbit Jackpot program.
 *
 * - `math/wheel`: BigInt wheel geometry (`theta_target`, slices, the
 *   integer-only winner lookup) — pure, testable, no network.
 * - `pda`: every seed derivation, little-endian, mirroring `constants.rs`.
 * - `codec`: the shared borsh reader for raw-account/event decoding.
 * - `accounts`: offset-pinned decoders for the four client-relevant
 *   accounts, byte-verified against the Rust layout fixture.
 * - `events`: all 12 on-chain events — wire decoding plus the `emit_cpi!`
 *   subscription transport anchor 0.32's listener cannot provide.
 * - `idl`: the committed canonical IDL (tooling; decoders don't need it).
 * - `client`: account fetchers, transaction builders (raw web3.js
 *   instructions with committed sighash discriminators), and event
 *   subscriptions.
 */

export * from "./math/wheel";
export * from "./math/economics";
export * from "./pda";
export * from "./codec";
export * from "./accounts";
export * from "./events";
export * from "./idl";
export * from "./client";
