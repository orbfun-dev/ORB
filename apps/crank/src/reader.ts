/**
 * Batched chain reads through the RPC gateway. Everything the monitor
 * refreshes arrives via `getMultipleAccounts` (≤100 keys per call, one
 * paced call per refresh) — the polite shape for public devnet RPCs, and
 * zero `getProgramAccounts` anywhere (the phase-8 lesson).
 *
 * Decoding uses the SDK's offset-pinned decoders; sizes are exact-match so
 * an on-chain layout change fails loudly instead of misreading.
 */

import {
  configKey,
  decodeGlobalConfig,
  decodePlayerEntry,
  decodeRound,
  entryKey,
  roundKey,
  type GlobalConfigData,
  type PlayerEntryAccountData,
  type RoundData,
  decodeEntropyChain,
  entropyChainKey,
  type EntropyChainData,
} from "@orbit-jackpot/sdk";
import { PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { decodeRandomnessView, type RandomnessView } from "./randomness";
import type { RpcGateway } from "./rpc";

const CHUNK = 100; // getMultipleAccounts protocol cap

export class ChainReader {
  private readonly rpc: RpcGateway;

  constructor(rpc: RpcGateway) {
    this.rpc = rpc;
  }

  /** Raw account data by base58 key; missing accounts map to `null`. */
  async accounts(keys: PublicKey[]): Promise<Map<string, Buffer | null>> {
    const out = new Map<string, Buffer | null>();
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const infos = await this.rpc.call("getMultipleAccounts", () =>
        this.rpc.connection.getMultipleAccountsInfo(chunk, "confirmed"),
      );
      chunk.forEach((key, j) => out.set(key.toBase58(), infos[j]?.data ?? null));
    }
    return out;
  }

  /**
   * Data AND lamports by base58 key — the escrow path needs both: the
   * decoded terms from the data, the spendable balance from the lamports
   * (the escrow has no balance field by design).
   */
  async accountsWithLamports(
    keys: PublicKey[],
  ): Promise<Map<string, { lamports: bigint; data: Buffer } | null>> {
    const out = new Map<string, { lamports: bigint; data: Buffer } | null>();
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const infos = await this.rpc.call("getMultipleAccounts", () =>
        this.rpc.connection.getMultipleAccountsInfo(chunk, "confirmed"),
      );
      chunk.forEach((key, j) => {
        const info = infos[j];
        out.set(
          key.toBase58(),
          info === undefined || info === null ? null : { lamports: BigInt(info.lamports), data: info.data },
        );
      });
    }
    return out;
  }

  async config(): Promise<GlobalConfigData | null> {
    const info = await this.rpc.call("getConfig", () =>
      this.rpc.connection.getAccountInfo(configKey(), "confirmed"),
    );
    return info === null ? null : decodeGlobalConfig(info.data);
  }

  async round(roundId: bigint): Promise<RoundData | null> {
    const info = await this.rpc.call("getRound", () =>
      this.rpc.connection.getAccountInfo(roundKey(roundId), "confirmed"),
    );
    return info === null ? null : decodeRound(info.data);
  }

  /** Rounds `fromId - count + 1 … fromId` (descending ids passed in). */
  async roundRange(fromId: bigint, count: number): Promise<Map<bigint, RoundData | null>> {
    const ids: bigint[] = [];
    for (let i = 0n; i < BigInt(count) && fromId - i >= 0n; i += 1n) ids.push(fromId - i);
    const batch = await this.accounts(ids.map((id) => roundKey(id)));
    const out = new Map<bigint, RoundData | null>();
    ids.forEach((id) => {
      const data = batch.get(roundKey(id).toBase58()) ?? null;
      out.set(id, data === null ? null : decodeRound(data));
    });
    return out;
  }

  async randomness(key: PublicKey): Promise<RandomnessView | null> {
    const info = await this.rpc.call("getRandomness", () =>
      this.rpc.connection.getAccountInfo(key, "confirmed"),
    );
    return info === null ? null : decodeRandomnessView(info.data);
  }

  async entropyChain(): Promise<EntropyChainData | null> {
    const info = await this.rpc.call("getEntropyChain", () =>
      this.rpc.connection.getAccountInfo(entropyChainKey(), "confirmed"),
    );
    return info === null ? null : decodeEntropyChain(info.data);
  }

  async slotHashes(): Promise<Buffer | null> {
    const info = await this.rpc.call("getSlotHashes", () =>
      this.rpc.connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, "confirmed"),
    );
    return info === null ? null : Buffer.from(info.data);
  }

  /** Phase 13: a lookup table's deactivation slot, or null when closed. */
  async lookupTable(key: PublicKey): Promise<{ deactivationSlot: bigint } | null> {
    const res = await this.rpc.call("getLookupTable", () =>
      this.rpc.connection.getAddressLookupTable(key, { commitment: "confirmed" }),
    );
    return res.value === null ? null : { deactivationSlot: BigInt(res.value.state.deactivationSlot) };
  }

  /**
   * The round's still-existing entries, index-ordered (closed entries are
   * simply absent from chain). Chunked over derived entry PDAs — dense and
   * count-bounded, no GPA.
   */
  async entries(roundId: bigint, entryCount: number): Promise<PlayerEntryAccountData[]> {
    if (entryCount === 0) return [];
    const indices = Array.from({ length: entryCount }, (_, i) => i);
    const out: PlayerEntryAccountData[] = [];
    for (let i = 0; i < indices.length; i += CHUNK) {
      const chunk = indices.slice(i, i + CHUNK);
      const batch = await this.accounts(chunk.map((idx) => entryKey(roundId, idx)));
      for (const idx of chunk) {
        const data = batch.get(entryKey(roundId, idx).toBase58()) ?? null;
        if (data !== null) out.push(decodePlayerEntry(data));
      }
    }
    return out.sort((a, b) => a.entryIndex - b.entryIndex);
  }
}
