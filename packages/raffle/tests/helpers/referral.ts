/** Real ed25519 wallets for referral tests (AUDIT R-3: bindings must be signed). */

import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { referralConsentMessage } from "../../../sdk/src/index";

const secrets = new Map<string, ReturnType<typeof generateKeyPairSync>["privateKey"]>();

/** A wallet whose private key the test holds; returns its base58 pubkey. */
export function signerWallet(): string {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const pubkey = bs58.encode(raw);
  secrets.set(pubkey, privateKey);
  return pubkey;
}

/** Signs the referral consent as `wallet` (must come from signerWallet). */
export function consent(wallet: string, ref: string, issuedAt = new Date().toISOString(), signAs = wallet) {
  const key = secrets.get(signAs);
  if (key === undefined) throw new Error(`no test key for ${signAs}`);
  const signature = sign(null, Buffer.from(referralConsentMessage(wallet, ref, issuedAt), "utf8"), key).toString("base64");
  return { wallet, ref, issuedAt, signature };
}
