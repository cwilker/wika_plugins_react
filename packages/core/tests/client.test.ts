import { describe, expect, it, vi } from "vitest";
import { ApiPromise } from "@polkadot/api";
import { TypeRegistry } from "@polkadot/types";
import {
  WikaClient,
  decodePage,
  formatAmount,
  validateUrl,
  type Signer,
} from "../src";

const url = "https://example.org/a?q=one,two#section";
const account = { address: "alice", source: "test" };
const signer = {} as Signer;
function fixture() {
  let handler: ((result: unknown) => void) | undefined;
  let resolveStop: ((stop: () => void) => void) | undefined;
  const stop = vi.fn();
  const tx = {
    hash: { toHex: () => "0xtx" },
    paymentInfo: vi.fn(async () => ({ partialFee: 15n })),
    signAndSend: vi.fn((_address, _options, cb) => {
      handler = cb;
      return new Promise<() => void>((resolve) => {
        resolveStop = resolve;
      });
    }),
  };
  const api = {
    genesisHash: { toHex: () => "0xgenesis" },
    registry: {
      chainDecimals: [12],
      chainTokens: ["WIKA"],
      findMetaError: () => ({
        section: "likes",
        name: "AlreadyInQueue",
        docs: ["Already liked."],
      }),
    },
    rpc: { system: { chain: async () => "Test chain" } },
    consts: { balances: { existentialDeposit: 10n } },
    query: {
      system: {
        account: vi.fn(async () => ({ data: { free: 1000n, frozen: 20n } })),
      },
      likes: {
        urls: vi.fn(async () => [5n, "a", "b"]),
        likes: vi.fn(async () => null),
        likePrice: vi.fn(async () => 100n),
        maxLikes: vi.fn(async () => 100),
      },
      owners: { owners: vi.fn(async () => null) },
    },
    tx: { likes: { like: vi.fn(() => tx) } },
    queryMulti: vi.fn(async (_entries, cb) => {
      cb([[5n, "a", "b"], null, null]);
      return stop;
    }),
    disconnect: vi.fn(),
  };
  return {
    api,
    tx,
    stop,
    client: WikaClient.fromApi(api as unknown as ApiPromise),
    emit: (result: unknown) => handler!(result),
    resolveStop: () => resolveStop!(stop),
  };
}
const success = { section: "system", method: "ExtrinsicSuccess", data: [] };
function result(
  status: Record<string, unknown>,
  events: unknown[] = [{ event: success }],
  dispatchError?: unknown,
) {
  return { status, events, dispatchError };
}
async function submitted(f: ReturnType<typeof fixture>, options = {}) {
  const promise = f.client.submitLike(
    account,
    signer,
    { url, count: 2 },
    options,
  );
  // Immediately attach a rejection handler to prevent unhandled rejection diagnostics in failure tests.
  void promise.catch(() => {});
  await vi.waitFor(() => expect(f.tx.signAndSend).toHaveBeenCalledOnce());
  return { promise };
}

describe("Wika core", () => {
  it("decodes actual SCALE optional tuples, including None and large integers", () => {
    const registry = new TypeRegistry();
    const page = registry.createType("Option<(u64,u32,u32)>", [
      18446744073709551615n.toString(),
      0,
      0,
    ]);
    const mine = registry.createType(
      "Option<(u64,u32,u32,u32)>",
      [9, 2, 20, 0],
    );
    expect(decodePage(url, page, null, mine)).toMatchObject({
      likes: 18446744073709551615n,
      mine: { likesBefore: 9n, count: 2, remaining: 20 },
    });
    expect(
      decodePage(url, registry.createType("Option<u32>"), null, null),
    ).toMatchObject({ likes: 0n, owner: null, mine: null });
  });
  it("preserves exact URL identity and enforces UTF-8 limits", () => {
    expect(validateUrl(url)).toBe(url);
    expect(() => validateUrl("javascript:alert(1)")).toThrow();
    expect(() => validateUrl("https://user:secret@example.org")).toThrow();
    expect(() => validateUrl("https://x.org/" + "é".repeat(121))).toThrow(
      "255",
    );
  });
  it("formats exact amounts beyond Number precision", () => {
    expect(formatAmount(9007199254740993123456n)).toBe(
      "9007199254.740993123456 WIKA",
    );
    expect(formatAmount(-123n, 2, "")).toBe("-1.23");
  });
  it("quotes chain price, fees, freezes and the account reserve", async () => {
    const f = fixture();
    expect(await f.client.quoteLike("alice", { url, count: 2 })).toMatchObject({
      price: 100n,
      cost: 200n,
      estimatedFee: 15n,
      total: 215n,
      affordable: true,
      balance: { spendable: 980n },
    });
    expect(f.api.tx.likes.like).toHaveBeenCalledWith(url, "", 2);
    expect(
      (await f.client.quoteLike("alice", { url, count: 10 })).affordable,
    ).toBe(false);
  });
  it("reserves the existential deposit and enforces positive counts and the chain maximum", async () => {
    const f = fixture();
    f.api.query.system.account.mockResolvedValue({
      data: { free: 1000n, frozen: 0n },
    });
    expect((await f.client.getBalance("alice")).spendable).toBe(990n);
    await expect(
      f.client.quoteLike("alice", { url, count: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_COUNT" });
    await expect(
      f.client.quoteLike("alice", { url, count: 101 }),
    ).rejects.toMatchObject({ code: "INVALID_COUNT" });
  });
  it("rejects accounts already in the reward queue", async () => {
    const f = fixture();
    f.api.query.likes.likes.mockResolvedValue([0, 2, 20, "pot"] as never);
    await expect(
      f.client.quoteLike("alice", { url, count: 1 }),
    ).rejects.toMatchObject({ code: "ALREADY_LIKED" });
  });
  it("checks account genesis before signing", async () => {
    const f = fixture();
    await expect(
      f.client.submitLike({ ...account, genesisHash: "0xother" }, signer, {
        url,
        count: 1,
      }),
    ).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(f.tx.signAndSend).not.toHaveBeenCalled();
  });
  it("rechecks affordability before signing", async () => {
    const f = fixture();
    f.api.query.system.account.mockResolvedValue({
      data: { free: 20n, frozen: 20n },
    });
    await expect(
      f.client.submitLike(account, signer, { url, count: 1 }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(f.tx.signAndSend).not.toHaveBeenCalled();
  });
  it("waits for finalized success and cleans up even when the unsubscribe arrives late", async () => {
    const f = fixture(),
      onStatus = vi.fn();
    const { promise } = await submitted(f, { onStatus });
    f.emit(result({ isInBlock: true }));
    expect(onStatus).toHaveBeenLastCalledWith("inBlock");
    f.emit(
      result({ isFinalized: true, asFinalized: { toHex: () => "0xblock" } }),
    );
    await expect(promise).resolves.toEqual({
      txHash: "0xtx",
      blockHash: "0xblock",
    });
    f.resolveStop();
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
  });
  it("decodes finalized dispatch errors, including ExtrinsicFailed events", async () => {
    const f = fixture(), onFinalizedFailure=vi.fn();
    const { promise } = await submitted(f,{onFinalizedFailure});
    f.emit(
      result({ isFinalized: true, asFinalized:{toHex:()=>"0xfailedblock"} }, [
        {
          event: {
            section: "system",
            method: "ExtrinsicFailed",
            data: [{ isModule: true, asModule: {} }],
          },
        },
      ]),
    );
    await expect(promise).rejects.toThrow("likes.AlreadyInQueue");
    expect(onFinalizedFailure).toHaveBeenCalledWith({txHash:"0xtx",blockHash:"0xfailedblock"});
    f.resolveStop();
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
  });
  it("does not declare success without an execution success event", async () => {
    const f = fixture();
    const { promise } = await submitted(f);
    f.emit(result({ isFinalized: true }, []));
    await expect(promise).rejects.toThrow("successful execution");
    f.resolveStop();
  });
  it("continues watching after a retraction", async () => {
    const f = fixture(),
      onStatus = vi.fn();
    const { promise } = await submitted(f, { onStatus });
    f.emit(result({ isInBlock: true }, [], { isModule: true }));
    f.emit(result({ isRetracted: true }));
    expect(onStatus).toHaveBeenLastCalledWith("retracted");
    f.emit(
      result({ isFinalized: true, asFinalized: { toHex: () => "0xnew" } }),
    );
    await expect(promise).resolves.toHaveProperty("blockHash", "0xnew");
    f.resolveStop();
  });
  it("stops monitoring on abort without claiming to cancel the chain transaction", async () => {
    const f = fixture(),
      controller = new AbortController();
    const { promise } = await submitted(f, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    f.resolveStop();
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
  });
  it("times out and cleans up monitoring", async () => {
    const f = fixture();
    const { promise } = await submitted(f, { timeoutMs: 100 });
    f.resolveStop();
    await expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it("propagates signer rejection and terminal pool states", async () => {
    const f = fixture();
    f.tx.signAndSend.mockImplementationOnce(() =>
      Promise.reject(new Error("User rejected")),
    );
    await expect(
      f.client.submitLike(account, signer, { url, count: 1 }),
    ).rejects.toThrow("User rejected");
    const other = fixture();
    const { promise } = await submitted(other);
    other.emit(result({ isDropped: true, type: "Dropped" }));
    await expect(promise).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    other.resolveStop();
  });
  it("unsubscribes page reads and leaves caller-owned APIs open", async () => {
    const f = fixture(),
      callback = vi.fn();
    const stop = await f.client.subscribePage(url, "alice", callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ likes: 5n }),
    );
    stop();
    stop();
    expect(f.stop).toHaveBeenCalledOnce();
    await f.client.disconnect();
    expect(f.api.disconnect).not.toHaveBeenCalled();
  });
});

it('does not request a signature when durable recovery storage fails',async()=>{
  const f=fixture(),onSigningRejected=vi.fn();
  await expect(f.client.submitLike(account,signer,{url,count:1},{beforeSign:()=>{throw new Error('storage unavailable');},onSigningRejected})).rejects.toThrow('storage unavailable');
  expect(f.tx.signAndSend).not.toHaveBeenCalled();expect(onSigningRejected).toHaveBeenCalledOnce();
});
it('records the actual signing payload and distinguishes a wallet cancellation before broadcasting',async()=>{
  const f=fixture(),order:string[]=[],onSigningRejected=vi.fn();
  f.tx.signAndSend.mockImplementation(async(_address,options)=>{
    await (options as {signer:Signer}).signer.signPayload!({blockNumber:'0x01',era:'0x1500'} as never);
    return ()=>{};
  });
  const cancelSigner:Signer={signPayload:async()=>{order.push('wallet');throw new Error('Signing rejected');}};
  await expect(f.client.submitLike(account,cancelSigner,{url,count:1},{beforeSign:()=>{order.push('saved');},onSigningPayload:()=>{order.push('payload');},onSigningRejected})).rejects.toThrow('Signing rejected');
  expect(order).toEqual(['saved','payload','wallet']);expect(onSigningRejected).toHaveBeenCalledOnce();
});
it('requires fresh review when economics activates between quote and submit',async()=>{
 const f=fixture();const quote=await f.client.quoteLike(account.address,{url,count:1});expect(quote.request.economicsVersion).toBe(1);
 (f.api.query.likes as unknown as Record<string,unknown>).economicsActive=async()=>({toString:()=>'true'});
 await expect(f.client.submitLike(account,signer,quote.request)).rejects.toThrow(/TermsChanged: economic activation changed/);
 expect(f.tx.signAndSend).not.toHaveBeenCalled();
});
