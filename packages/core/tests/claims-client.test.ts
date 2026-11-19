import { describe, it, expect, vi } from "vitest";
import type { ApiPromise } from "@polkadot/api";
import { WikaClaimsClient } from "../src/claims-client";
const address = "0x" + "01".repeat(32),
  other = "0x" + "02".repeat(32),
  url = "https://example.com/post";
const scalar = (value: unknown) => ({
  toString: () => String(value),
  toJSON: () => value,
});
const some = (value: unknown) => ({ isNone: false, unwrap: () => value });
const none = {
  isNone: true,
  unwrap: () => {
    throw new Error("none");
  },
};
function fixture() {
  const period = {
    owner: scalar(address),
    startedAt: scalar(100),
    endedAt: none,
    balance: scalar(2n ** 80n),
    proof: { toJSON: () => "0x746167" },
    verifiedAt: some(scalar(900)),
  };
  const owners = {
    currentPeriod: vi.fn(async () => some(scalar(1))),
    periods: vi.fn(async () => some(period)),
    pendingReplacements: vi.fn(async () => none as unknown),
    claimChecks: vi.fn(async () => none),
    retryCredits: vi.fn(async () => none as unknown),
    unclaimedRewards: vi.fn(async () => scalar(0)),
    requestPrice: vi.fn(async () => scalar(5)),
    replacementBond: vi.fn(async () => scalar(3)),
  };
  const tx = {
    paymentInfo: vi.fn(async () => ({ partialFee: scalar(2) })),
    signAndSend: vi.fn(),
  };
  const query = {
    owners,
    timestamp: { now: vi.fn(async () => scalar(1000)) },
    system: {
      account: vi.fn(async () => ({
        data: { free: scalar(1000), frozen: scalar(0) },
      })),
    },
  };
  const api = {
    query,
    tx: {
      owners: {
        claimPage: () => tx,
        verifyWithdrawal: () => tx,
        withdrawRewards: () => tx,
        retryVerification: () => tx,
        approveReplacement: () => tx,
        finalizeReplacement: () => tx,
        cancelReplacement: () => tx,
        objectReplacement: () => tx,
        expireReplacement: () => tx,
      },
    },
    rpc: {
      chain: { getHeader: async () => ({ hash: { toHex: () => "0xblock" }, number:{toString:()=>"42"} }) },
    },
    at: vi.fn(async () => ({ query })),
    consts: { balances: { existentialDeposit: scalar(1) } },
  };
  return {
    client: new WikaClaimsClient(api as unknown as ApiPromise),
    owners,
    period,
    query,
    tx,
  };
}
const pending = () => ({
  id: scalar("0xid"),
  candidate: scalar(other),
  previousPeriod: scalar(1),
  openedAt: scalar(500),
  earliestActivation: scalar(2000),
  deadline: scalar(3000),
  bond: scalar(3),
  ownerApproved: scalar(false),
  candidateApproved: scalar(false),
  objection: scalar(false),
});
describe("claim state and monetary quotes", () => {
  it("keeps base units exact and freezes current/historical earnings during a replacement", async () => {
    const f = fixture();
    expect((await f.client.getPage(url)).current?.withdrawable).toBe(2n ** 80n);
    f.owners.pendingReplacements.mockResolvedValue(some(pending()));
    expect((await f.client.getPage(url)).current?.withdrawable).toBe(0n);
    f.period.endedAt = some(scalar(600)) as typeof none;
    f.period.verifiedAt = none as ReturnType<typeof some>;
    expect((await f.client.getPeriod(url, 1n))?.withdrawable).toBe(0n);
    f.owners.pendingReplacements.mockResolvedValue(none);
    expect((await f.client.getPeriod(url, 1n))?.withdrawable).toBe(2n ** 80n);
  });
  it("quotes network fee and returned challenger bond separately for a no-quorum retry", async () => {
    const f = fixture();
    f.owners.retryCredits.mockResolvedValue(
      some({
        account: scalar(address),
        check: {
          purpose: scalar("ReplacementInitial"),
          retriesRemaining: scalar(2),
          expiresAt: scalar(2000),
        },
      }),
    );
    expect(await f.client.quote(address, { kind: "retry", url })).toMatchObject(
      {
        networkFee: 2n,
        verificationFee: 0n,
        refundableBond: 3n,
        totalRequired: 5n,
        affordable: true,
      },
    );
    await expect(f.client.quote(other, { kind: "retry", url })).rejects.toThrow(
      "No no-quorum retry",
    );
  });
  it("rejects stale authorization, pending freezes and an unrelated wallet before signing", async () => {
    const f = fixture();
    await expect(
      f.client.quote(other, { kind: "withdraw", url, period: 1n, amount: 1n }),
    ).rejects.toThrow("does not own");
    f.owners.pendingReplacements.mockResolvedValue(some(pending()));
    await expect(
      f.client.quote(address, {
        kind: "withdraw",
        url,
        period: 1n,
        amount: 1n,
      }),
    ).rejects.toThrow("freezes");
    f.owners.pendingReplacements.mockResolvedValue(none);
    f.period.verifiedAt = none as ReturnType<typeof some>;
    await expect(
      f.client.quote(address, {
        kind: "withdraw",
        url,
        period: 1n,
        amount: 1n,
      }),
    ).rejects.toThrow("fresh successful verification");
    expect(f.tx.signAndSend).not.toHaveBeenCalled();
  });
  it("does not permit a one-wallet expedited replacement or stale replacement ID", async () => {
    const f = fixture(),
      p = pending();
    f.owners.pendingReplacements.mockResolvedValue(some(p));
    await expect(
      f.client.quote(other, { kind: "finalize", url, id: "0xid" }),
    ).rejects.toThrow("transfer window");
    await expect(
      f.client.quote(other, { kind: "finalize", url, id: "wrong" }),
    ).rejects.toThrow("replacement changed");
    p.ownerApproved = scalar(true);
    p.candidateApproved = scalar(true);
    expect(
      await f.client.quote(other, { kind: "finalize", url, id: "0xid" }),
    ).toMatchObject({
      networkFee: 2n,
      verificationFee: 5n,
      refundableBond: 0n,
    });
  });
});
it('keeps pending economic intent distinct from active ownership across reload reads',async()=>{
 const f=fixture();Object.assign(f.owners,{policyIntents:vi.fn(async()=>some({attempt:scalar('9007199254740993'),account:scalar(address),selection:{ownerBps:scalar(2500),supporterBps:scalar(6000),referralBps:scalar(1400)}}))});
 const page=await f.client.getPage('https://example.com/post');
 expect(page.pendingPolicy).toEqual({attempt:'9007199254740993',account:address,ownerBps:2500,supporterBps:6000,referralBps:1400});
 expect(page.current?.owner).toBe(address);expect(page.policyOutcome).toBeNull();
});
