/**
 * Gateway URL guard gates (the Mimosa acceptance surface): https only,
 * and localhost / loopback / private / reserved hosts are refused — the
 * URL arrives from an on-chain oracle account and is never trusted blind.
 */

import { expect } from "chai";
import { assertSafeGatewayUrl } from "../src/urlguard";

describe("gateway url guard", () => {
  it("accepts public https gateway urls", () => {
    expect(() => assertSafeGatewayUrl("https://oracle.switchboard.example/v1")).to.not.throw();
  });

  it("refuses non-https schemes", () => {
    expect(() => assertSafeGatewayUrl("http://oracle.example")).to.throw(/https/);
    expect(() => assertSafeGatewayUrl("ftp://oracle.example")).to.throw(/https/);
  });

  it("refuses localhost and loopback", () => {
    expect(() => assertSafeGatewayUrl("https://localhost/v1")).to.throw(/private\/reserved/);
    expect(() => assertSafeGatewayUrl("https://127.0.0.1:8080/v1")).to.throw(/private\/reserved/);
    expect(() => assertSafeGatewayUrl("https://0.1.2.3/v1")).to.throw(/private\/reserved/);
  });

  it("refuses RFC1918 and link-local ranges", () => {
    expect(() => assertSafeGatewayUrl("https://10.0.0.5/v1")).to.throw(/private\/reserved/);
    expect(() => assertSafeGatewayUrl("https://192.168.1.10/v1")).to.throw(/private\/reserved/);
    expect(() => assertSafeGatewayUrl("https://172.16.0.1/v1")).to.throw(/private\/reserved/);
    expect(() => assertSafeGatewayUrl("https://172.31.255.255/v1")).to.throw(/private\/reserved/);
    expect(() => assertSafeGatewayUrl("https://169.254.1.1/v1")).to.throw(/private\/reserved/);
  });

  it("permits public 172.x space outside 16–31", () => {
    expect(() => assertSafeGatewayUrl("https://172.1.2.3/v1")).to.not.throw();
    expect(() => assertSafeGatewayUrl("https://172.32.0.1/v1")).to.not.throw();
  });

  it("refuses .local and .internal suffixes", () => {
    expect(() => assertSafeGatewayUrl("https://oracle.local/v1")).to.throw(/private\/reserved/);
    expect(() => assertSafeGatewayUrl("https://oracle.internal/v1")).to.throw(/private\/reserved/);
  });
});
