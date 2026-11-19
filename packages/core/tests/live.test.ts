import { expect, it } from "vitest";
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { WikaClient, type Signer } from "../src";

// Explicit opt-in: sends paid likes from //Alice on a development chain only.
it.skipIf(!process.env.WIKA_NODE_URL)(
  "quotes, signs and finalizes a real like on Wika 4.x",
  async () => {
    const endpoint = process.env.WIKA_NODE_URL!;
    const client = await WikaClient.connect({ endpoint });
    const api = await ApiPromise.create({
      provider: new WsProvider(endpoint),
      noInitWarn: true,
    });
    try {
      expect(
        (await api.rpc.system.chainType()).isDevelopment,
        "Live test requires a development chain",
      ).toBe(true);
      await cryptoWaitReady();
      const alice = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
      const signer: Signer = {
        signPayload: async (payload) => ({
          id: 1,
          signature: api.registry
            .createType("ExtrinsicPayload", payload, {
              version: payload.version,
            })
            .sign(alice).signature,
        }),
      };
      const url = `https://example.org/wika-core-test/${Date.now()}`;
      const network = await client.getNetwork();
      expect(network.symbol).toBe("WIKA");
      expect(network.decimals).toBe(12);
      expect(await client.claims.getFinalizedHeight()).toBeGreaterThanOrEqual(
        0,
      );
      expect(await client.getPage(url, alice.address)).toMatchObject({
        likes: 0n,
        mine: null,
      });
      const quote = await client.quoteLike(alice.address, { url, count: 2 });
      expect(quote.price).toBeGreaterThan(0n);
      expect(quote.estimatedFee).toBeGreaterThan(0n);
      expect(quote.affordable).toBe(true);
      const updates: string[] = [];
      let observed = 0n;
      const stop = await client.subscribePage(url, alice.address, (page) => {
        observed = page.likes;
      });
      try {
        const receipt = await client.submitLike(
          {
            address: alice.address,
            source: "development",
            genesisHash: network.genesisHash,
          },
          signer,
          { url, count: 2 },
          { onStatus: (value) => updates.push(value) },
        );
        expect(receipt.txHash).toMatch(/^0x[\da-f]{64}$/);
        expect(updates).toContain("inBlock");
        expect(updates.at(-1)).toBe("finalized");
        await expect.poll(() => observed, { timeout: 10000 }).toBe(2n);
        expect(await client.getPage(url, alice.address)).toMatchObject({
          likes: 2n,
          mine: { count: 2 },
        });
        await expect(
          client.quoteLike(alice.address, { url, count: 1 }),
        ).rejects.toMatchObject({ code: "ALREADY_LIKED" });
      } finally {
        stop();
      }
      await expect(
        WikaClient.connect({ endpoint, genesisHash: "0xwrong" }),
      ).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    } finally {
      await client.disconnect();
      await api.disconnect();
    }
  },
  180000,
);
