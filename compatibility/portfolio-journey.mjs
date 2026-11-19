import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
const root = fileURLToPath(new URL("..", import.meta.url));
const { chromium } = await import(
  new URL(
    "../../wika_browser_ext_react/v2/node_modules/playwright/index.mjs",
    import.meta.url,
  ).href
);

/** Real dashboard, node RPC, GraphQL and transactions; only the injected dev wallet and website proof are test fixtures. */
export async function startPortfolioJourney({
  api,
  endpoint,
  queryEndpoint,
  url,
  alice,
  bob,
  reportDirectory,
}) {
  assert.equal((await api.rpc.system.chainType()).isDevelopment, true);
  assert.equal(
    new URL(endpoint).hostname,
    "127.0.0.1",
    "Only an isolated loopback development node may be used",
  );
  assert.ok(reportDirectory);
  await mkdir(reportDirectory, { recursive: true });
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const vite = spawn(
    process.execPath,
    [
      root + "/node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root + "/examples/owners",
      env: {
        ...process.env,
        VITE_WIKA_NODE_URL: endpoint,
        VITE_WIKA_INDEXER_URL: queryEndpoint,
        VITE_WIKA_GENESIS_HASH: api.genesisHash.toHex(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let viteLog = "",
    browser,
    page,
    stopped = false;
  vite.stdout.on("data", (value) => {
    viteLog += value;
  });
  vite.stderr.on("data", (value) => {
    viteLog += value;
  });
  const events = [],
    browserErrors = [],
    graphqlErrors = [],
    requests = [],
    signatures = [];
  const report = {
    passed: false,
    chain: api.genesisHash.toHex(),
    page: url,
    stages: events,
    websiteProof:
      "Controlled HTML fixture consumed by the real verifier worker; public DNS/TLS is outside this test.",
    wallet:
      "Injected development-wallet provider with real SCALE signing; not the native browser extension.",
    transport:
      "Real browser WebSocket RPC and cross-origin HTTP GraphQL; no route interception or fetch mocks.",
  };
  const save = () =>
    writeFile(
      reportDirectory + "/journey-result.json",
      JSON.stringify(
        { ...report, browserErrors, graphqlErrors, signatures, requests },
        null,
        2,
      ) + "\n",
    );
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await save();
    if (!report.passed && page) {
      await page
        .screenshot({ path: reportDirectory + "/failure.png", fullPage: true })
        .catch(() => {});
      await writeFile(
        reportDirectory + "/failure-page.txt",
        await page.locator("body").innerText(),
      ).catch(() => {});
    }
    await browser?.close();
    if (vite.exitCode === null && vite.signalCode === null) {
      const exited = once(vite, "exit");
      vite.kill("SIGTERM");
      const timer = setTimeout(() => vite.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    await writeFile(reportDirectory + "/dashboard-server.log", viteLog);
  };
  try {
    await save();
    const dashboardUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      assert.equal(vite.exitCode, null, viteLog);
      try {
        const response = await fetch(dashboardUrl);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, viteLog);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: "chromium" }),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
    });
    await context.exposeFunction(
      "__wikaSignDevelopmentPayload",
      async (payload) => {
        assert.equal(payload.genesisHash, api.genesisHash.toHex());
        assert.equal(
          payload.address,
          bob.address,
          "Only Bob's historical withdrawal may be signed",
        );
        const call = api.registry.createType("Call", payload.method);
        assert.equal(call.section, "owners");
        assert.equal(call.method, "withdrawRewards");
        assert.equal(call.args[0].toUtf8(), url);
        assert.equal(call.args[1].toString(), "1");
        assert.equal(call.args[2].toString(), "560000000000");
        signatures.push({
          address: payload.address,
          section: call.section,
          method: call.method,
          period: call.args[1].toString(),
          amount: call.args[2].toString(),
        });
        return {
          id: signatures.length,
          signature: api.registry
            .createType("ExtrinsicPayload", payload, {
              version: payload.version,
            })
            .sign(bob).signature,
        };
      },
    );
    await context.addInitScript(
      ({ aliceAddress, bobAddress, genesisHash }) => {
        window.injectedWeb3 = {
          wika: {
            enable: async () => ({
              accounts: {
                get: async () => [
                  {
                    address: bobAddress,
                    name: "Bob (development)",
                    genesisHash,
                    type: "sr25519",
                  },
                  {
                    address: aliceAddress,
                    name: "Alice (development)",
                    genesisHash,
                    type: "sr25519",
                  },
                ],
              },
              signer: {
                signPayload: (payload) =>
                  window.__wikaSignDevelopmentPayload(payload),
              },
            }),
          },
        };
      },
      {
        aliceAddress: alice.address,
        bobAddress: bob.address,
        genesisHash: api.genesisHash.toHex(),
      },
    );
    page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("response", async (response) => {
      if (
        response.url() === queryEndpoint + "/" ||
        response.url() === queryEndpoint
      ) {
        requests.push({
          url: response.url(),
          status: response.status(),
          method: response.request().method(),
        });
        try {
          const body = await response.json();
          if (body.errors) graphqlErrors.push(body.errors);
        } catch {}
      }
    });
    await page.goto(dashboardUrl);
    await page
      .getByRole("button", { name: "Connect node", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Use connected wallet", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Wallet portfolio", exact: true })
      .waitFor();
    const portfolio = () =>
      page.getByRole("region", { name: "Wallet portfolio", exact: true });
    const row = (period) =>
      portfolio()
        .getByRole("row")
        .filter({ has: page.getByText(`Period #${period}`, { exact: true }) });
    async function refreshUntil(check, label) {
      const deadline = Date.now() + 120000;
      let last;
      while (Date.now() < deadline) {
        try {
          await check();
          return;
        } catch (error) {
          last = error;
        }
        await writeFile(
          reportDirectory + "/progress-page.txt",
          await page.locator("body").innerText(),
        );
        const button = portfolio().getByRole("button", {
          name: "Refresh discovery",
          exact: true,
        });
        await button.waitFor({ state: "visible" });
        if (await button.isEnabled()) await button.click();
        await page.waitForTimeout(1200);
      }
      throw new Error(`${label}: ${last}\n${await portfolio().innerText()}`);
    }
    async function account(address) {
      await page
        .getByLabel("Wallet account to view", { exact: true })
        .selectOption(address);
    }
    const record = async (name, extra = {}) => {
      events.push({ name, time: new Date().toISOString(), ...extra });
      await save();
      console.log(`[portfolio journey] ${name}`);
    };
    return {
      async firstOwnership() {
        await account(bob.address);
        await refreshUntil(async () => {
          assert.match(await row(1).innerText({ timeout: 1000 }), /Owned now/);
          assert.match(await row(1).innerText(), /0\.66 WIKA/);
          assert.equal(
            await row(1)
              .getByRole("button", { name: "Manage page" })
              .isEnabled(),
            true,
          );
        }, "Bob's first ownership and backlog");
        assert.doesNotMatch(await portfolio().innerText(), /Invalid Date/);
        await record("first-ownership", {
          owner: bob.address,
          period: "1",
          reserved: "660000000000",
        });
        await page.screenshot({
          path: reportDirectory + "/first-ownership.png",
          fullPage: true,
        });
      },
      async pendingReplacement() {
        await refreshUntil(async () => {
          const text = await row(1).innerText({ timeout: 1000 });
          assert.match(text, /Withdrawals held/);
          assert.match(text, /0 WIKA withdrawable/);
        }, "Bob's frozen withdrawals");
        await account(alice.address);
        await refreshUntil(async () => {
          assert.match(await portfolio().innerText(), /Replacement candidate/);
          assert.match(await portfolio().innerText(), /Replacement pending/);
        }, "Alice's incoming replacement");
        await record("pending-replacement", {
          currentOwner: bob.address,
          candidate: alice.address,
          withdrawalsHeld: true,
        });
        await page.screenshot({
          path: reportDirectory + "/pending-replacement.png",
          fullPage: true,
        });
      },
      async replacementActivated() {
        await account(alice.address);
        await refreshUntil(async () => {
          assert.match(await row(2).innerText({ timeout: 1000 }), /Owned now/);
          assert.match(await row(2).innerText(), /0\.33 WIKA/);
        }, "Alice's active period and new earnings");
        await account(bob.address);
        await refreshUntil(async () => {
          assert.match(
            await row(1).innerText({ timeout: 1000 }),
            /Earlier ownership/,
          );
          assert.match(await row(1).innerText(), /0\.56 WIKA/);
        }, "Bob's reserved historical earnings");
        await record("replacement-activated", {
          historicalPeriod: "1",
          historicalBalance: "560000000000",
          currentPeriod: "2",
          currentBalance: "330000000000",
        });
        await page.screenshot({
          path: reportDirectory + "/historical-earnings.png",
          fullPage: true,
        });
      },
      async withdrawHistorical() {
        await row(1)
          .getByRole("button", { name: "Manage page", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Review withdrawal", exact: true })
          .click();
        const quote = page.getByRole("region", {
          name: "Historical withdrawal quote",
          exact: true,
        });
        await quote.waitFor();
        assert.match(await quote.innerText(), /Amount: 0\.56 WIKA/);
        assert.match(await quote.innerText(), /Period #1/);
        await quote
          .getByRole("button", {
            name: "Submit historical withdrawal",
            exact: true,
          })
          .click();
        await page
          .getByText(/Historical withdrawal finalized:/)
          .waitFor({ timeout: 90000 });
        assert.equal(signatures.length, 1);
        const p = (await api.query.owners.periods(url, 1)).unwrap();
        assert.equal(p.balance.toString(), "0");
        await record("browser-withdrawal-finalized", {
          period: "1",
          amount: "560000000000",
          signatures: signatures.length,
          nodeBalance: "0",
        });
      },
      async withdrawalIndexed() {
        await refreshUntil(async () => {
          assert.match(
            await row(1).innerText({ timeout: 1000 }),
            /Earlier ownership/,
          );
          assert.match(await row(1).innerText(), /0 WIKA/);
        }, "Historical withdrawal shown after indexing");
        await account(alice.address);
        await refreshUntil(async () => {
          assert.match(await row(2).innerText({ timeout: 1000 }), /0\.33 WIKA/);
          assert.equal(await row(1).count(), 0);
        }, "New owner's earnings unaffected by old-owner withdrawal");
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          ),
          false,
        );
        await page.screenshot({
          path: reportDirectory + "/final-mobile.png",
          fullPage: true,
        });
        assert.deepEqual(browserErrors, []);
        assert.deepEqual(graphqlErrors, []);
        assert.ok(
          requests.some(
            (request) => request.method === "POST" && request.status === 200,
          ),
        );
        await record("withdrawal-indexed-and-wallet-isolation", {
          historicalBalance: "0",
          currentBalance: "330000000000",
          browserErrors: 0,
          graphqlErrors: 0,
        });
        report.passed = true;
        await save();
      },
      stop,
    };
  } catch (error) {
    report.error = String(error);
    if (page) {
      await page
        .screenshot({ path: reportDirectory + "/failure.png", fullPage: true })
        .catch(() => {});
      await writeFile(
        reportDirectory + "/failure-page.txt",
        await page.locator("body").innerText(),
      ).catch(() => {});
    }
    await stop();
    throw error;
  }
}
