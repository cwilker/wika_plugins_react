import { describe, it, expect } from "vitest";
import { TypeRegistry } from "@polkadot/types/create";
import {
  policySelection,
  parsePercentage,
  hashEconomicTerms,
  hashPagePolicy,
  type PageEconomics,
} from "../src/economics";
import fixture from "./fixtures/economic-terms-v2.json";
const registry = new TypeRegistry();
const api = { registry } as Parameters<typeof hashEconomicTerms>[0];
const state: PageEconomics = {
  active: true,
  legacy: false,
  lockedAt: null,
  price: "1000000000000",
  policyHash: "0x" + "01".repeat(32),
  policy: {
    ruleset: 1,
    revision: "7",
    model: 1,
    ownerBps: 4500,
    supporterBps: 4500,
    referralBps: 900,
    protocolBps: 100,
    rounds: 4,
    treasury: "0x" + "04".repeat(32),
    configurator: null,
    ownerPeriod: null,
  },
  rules: {
    version: 1,
    ownerMin: 0,
    ownerMax: 9800,
    supporterMin: 100,
    supporterMax: 9800,
    referralMin: 100,
    referralMax: 9800,
    protocolBps: 100,
    minimumPrice: "100",
    treasury: "0x" + "04".repeat(32),
  },
};
describe("page economics commitments", () => {
  it("uses exact basis points and rejects misleading precision or ambiguous numbers", () => {
    expect(parsePercentage("14.01")).toBe(1401);
    for (const v of ["1e1", "-1", "0.001", "101", "NaN", " 9", "09", "9."])
      expect(() => parsePercentage(v)).toThrow();
  });
  it("validates chain bounds, positive referral, sum, activation and lock state", () => {
    expect(policySelection(state, 2500, 6000, 1400, true)).toMatchObject({
      expectedRevision: "7",
      expectedHash: state.policyHash,
      inheritIfChanged: true,
    });
    for (const values of [
      [4500, 4500, 0],
      [4500, 4500, 901],
      [4499.5, 4500.5, 900],
      [9899, 0, 1],
    ])
      expect(() =>
        policySelection(state, ...(values as [number, number, number]), true)
      ).toThrow();
    expect(() =>
      policySelection({ ...state, lockedAt: "42" }, 2500, 6000, 1400, true)
    ).toThrow(/fixed/);
    expect(() =>
      policySelection({ ...state, active: false }, 2500, 6000, 1400, true)
    ).toThrow(/not active/);
  });
  it("matches runtime SCALE fixtures and commits the policy, routing and account", () => {
    expect(
      hashPagePolicy(api, fixture.terms.target, fixture.terms.policy)
    ).toBe(fixture.terms.policyHash);
    expect(hashEconomicTerms(api, fixture.terms)).toBe(fixture.termsHash);
    expect(
      hashEconomicTerms(api, { ...fixture.terms, cost: "1000000000001" })
    ).not.toBe(fixture.termsHash);
    expect(
      hashEconomicTerms(api, { ...fixture.terms, referralToTarget: true })
    ).not.toBe(fixture.termsHash);
    expect(
      hashPagePolicy(api, fixture.terms.target, {
        ...fixture.terms.policy,
        revision: "2",
      })
    ).not.toBe(fixture.terms.policyHash);
  });
});
