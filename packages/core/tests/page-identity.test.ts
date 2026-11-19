import { describe, it, expect } from "vitest";
import fixtures from "./fixtures/page-identity-v1.json";
import { canonicalPageUrl } from "../src/page-identity";
describe("page identity v1 shared consensus corpus", () => {
  for (const { input, expected } of fixtures.cases) {
    it(JSON.stringify(input), () => {
      if (expected === null) expect(() => canonicalPageUrl(input)).toThrow();
      else {
        expect(canonicalPageUrl(input)).toBe(expected);
        expect(canonicalPageUrl(expected)).toBe(expected);
      }
    });
  }
});
