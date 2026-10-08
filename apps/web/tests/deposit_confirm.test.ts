import { describe, expect, it } from "vitest";
import { afterConfirmFailure } from "../src/hooks/useDeposit";

describe("AUDIT W-1 — a confirmation timeout never triggers a blind second deposit", () => {
  it("our own entry at the index means the deposit landed", () => {
    expect(afterConfirmFailure("Me111", "Me111")).toBe("landed");
  });
  it("another player's entry means ours cannot land — retry is safe", () => {
    expect(afterConfirmFailure("Other1", "Me111")).toBe("taken");
  });
  it("no entry yet means it may still land — never retry", () => {
    expect(afterConfirmFailure(null, "Me111")).toBe("unknown");
  });
});
