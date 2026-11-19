// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInjectedWallet } from "../src";

afterEach(() => {
  delete (window as Window & { injectedWeb3?: unknown }).injectedWeb3;
});
function inject() {
  const signer = { signPayload: vi.fn() };
  const stop = vi.fn();
  const get = vi.fn(async () => [
    { address: "alice", name: "Alice", type: "sr25519" },
  ]);
  let listener: ((accounts: { address: string }[]) => void) | undefined;
  const subscribe = vi.fn((callback: typeof listener) => {
    listener = callback;
    return stop;
  });
  const enable = vi.fn(async () => ({ accounts: { get, subscribe }, signer }));
  Object.assign(window, {
    injectedWeb3: { wika: { enable }, other: { enable: vi.fn() } },
  });
  return { signer, enable, get, stop, update: () => listener!([]) };
}
describe("injected wallet adapter", () => {
  it("uses the Wika injected protocol and preserves wallet provenance", async () => {
    const f = inject(),
      wallet = createInjectedWallet();
    const accounts = await wallet.connect("Example publisher");
    expect(f.enable).toHaveBeenCalledWith("Example publisher");
    expect(accounts).toEqual([
      {
        address: "alice",
        name: "Alice",
        source: "wika",
        genesisHash: undefined,
      },
    ]);
    expect(await wallet.getSigner(accounts[0])).toBe(f.signer);
    const callback = vi.fn(),
      stop = await wallet.subscribeAccounts!(callback);
    f.update();
    expect(callback).toHaveBeenLastCalledWith([]);
    stop();
    stop();
    expect(f.stop).toHaveBeenCalledOnce();
    f.get.mockResolvedValue([]);
    await expect(wallet.getSigner(accounts[0])).rejects.toThrow(
      "no longer authorized",
    );
  });
  it("reports missing wallets and authorization denial", async () => {
    await expect(createInjectedWallet().connect("App")).rejects.toMatchObject({
      code: "WALLET_UNAVAILABLE",
    });
    const f = inject();
    f.enable.mockRejectedValueOnce(new Error("Access denied"));
    await expect(createInjectedWallet().connect("App")).rejects.toThrow(
      "Access denied",
    );
  });
  it("requires authorization before returning a signer", async () => {
    inject();
    await expect(
      createInjectedWallet().getSigner({ address: "alice", source: "wika" }),
    ).rejects.toThrow("Connect this wallet");
  });
});
