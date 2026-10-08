/**
 * Entropy mirror gates: the TS twin of `entropy.rs` must split the 32-byte
 * value into LE halves and reduce the ticket half modulo the pot — the
 * crank's post-settle verification depends on exact agreement with the
 * chain.
 */

import { expect } from "chai";
import { megaTriggered, splitEntropy, ticketFromEntropy } from "../src/mirror";

describe("entropy mirror", () => {
  it("reads the halves as little-endian u128s", () => {
    const value = new Uint8Array(32).fill(0);
    value[0] = 0x2a; // ticket low byte → 0x2a
    value[15] = 0x01; // ticket high byte → 2^120
    value[16] = 0xff; // mega low byte
    const halves = splitEntropy(value);
    expect(halves.ticket).to.equal((1n << 120n) + 0x2an);
    expect(halves.mega).to.equal(0xffn);
  });

  it("reduces the ticket half modulo the pot total", () => {
    expect(ticketFromEntropy(10n, 4n)).to.equal(2n);
    expect(ticketFromEntropy(7n, 7n)).to.equal(0n);
    const big = (1n << 127n) + 123n;
    expect(ticketFromEntropy(big, 1_000_000n)).to.equal(big % 1_000_000n);
  });

  it("fires the mega trigger only on multiples of 625 (Phase 11, decision D2)", () => {
    expect(megaTriggered(625n)).to.equal(true);
    expect(megaTriggered(625n * 42n)).to.equal(true);
    expect(megaTriggered(624n)).to.equal(false);
    expect(megaTriggered(6_767n)).to.equal(false, "the old v1 modulus no longer fires");
    expect(megaTriggered(0n)).to.equal(true);
  });
});
