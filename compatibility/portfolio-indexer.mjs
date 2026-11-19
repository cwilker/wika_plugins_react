// Run after npm run build, with WIKA_TEST_DB_PORT pointing at an isolated PostgreSQL.
// Uses the sibling ETL's installed query service, not a mock GraphQL server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { WikaPortfolioClient } from "../packages/core/dist/index.js";
import { encodeAddress } from "@polkadot/util-crypto";
const require = createRequire(
  new URL("../../wika_etl/subql_wika/package.json", import.meta.url),
);
const { Client } = require("pg");
assert.ok(
  process.env.WIKA_TEST_DB_PORT,
  "Set WIKA_TEST_DB_PORT to an isolated PostgreSQL instance.",
);
const port = Number(process.env.WIKA_TEST_DB_PORT);
const db = new Client({
  host: "127.0.0.1",
  port,
  user: "postgres",
  password: "postgres",
  database: "postgres",
});
const schema = `portfolio_contract_${process.pid}_${Date.now()}`;
const account = encodeAddress(new Uint8Array(32).fill(1), 42);
const otherPrefix = encodeAddress(new Uint8Array(32).fill(1), 0);
let child,
  output = "";
try {
  await db.connect();
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(
    `CREATE TABLE "${schema}"._metadata (key text PRIMARY KEY, value jsonb NOT NULL)`,
  );
  for (const [key, value] of Object.entries({
    genesisHash: "0xcontract",
    startHeight: 1,
    lastProcessedHeight: 100,
    lastProcessedTimestamp: Date.now(),
    historicalStateEnabled: "height",
  }))
    await db.query(`INSERT INTO "${schema}"._metadata VALUES ($1, $2)`, [
      key,
      JSON.stringify(value),
    ]);
  await db.query(
    `CREATE TABLE "${schema}".ownership_periods (id text PRIMARY KEY, url text NOT NULL, owner text NOT NULL, period numeric NOT NULL, active boolean NOT NULL, _block_range int8range NOT NULL)`,
  );
  await db.query(`CREATE INDEX ON "${schema}".ownership_periods(owner)`);
  await db.query(
    `CREATE TABLE "${schema}".page_replacements (id text PRIMARY KEY, url text NOT NULL, candidate text NOT NULL, active boolean NOT NULL, _block_range int8range NOT NULL)`,
  );
  await db.query(
    `CREATE TABLE "${schema}".claim_verifications (id text PRIMARY KEY, url text NOT NULL, account text NOT NULL, finished_block integer, _block_range int8range NOT NULL)`,
  );
  for (let i = 0; i < 25; i++)
    await db.query(
      `INSERT INTO "${schema}".ownership_periods VALUES ($1, $2, $3, $4, $5, '[1,)')`,
      [
        String(i).padStart(2, "0"),
        `https://example.com/page-${i}`,
        account,
        i === 0 ? "9007199254740993" : String(i + 1),
        i < 5,
      ],
    );
  await db.query(
    `INSERT INTO "${schema}".ownership_periods VALUES ('outsider', 'https://example.com/outsider', 'other', 1, true, '[1,)'), ('future', 'https://example.com/future', $1, 1, true, '[101,)')`,
    [account],
  );
  await db.query(
    `INSERT INTO "${schema}".page_replacements VALUES ('pending', 'https://example.com/candidate', $1, true, '[1,)'), ('closed', 'https://example.com/closed', $1, false, '[1,)')`,
    [account],
  );
  await db.query(
    `INSERT INTO "${schema}".claim_verifications VALUES ('pending', 'https://example.com/check', $1, null, '[1,)'), ('finished', 'https://example.com/finished', $1, 90, '[1,)')`,
    [account],
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const queryPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  child = spawn(
    process.execPath,
    [
      require.resolve("@subql/query/bin/run"),
      `--name=${schema}`,
      `--port=${queryPort}`,
      "--disable-hot-schema",
    ],
    {
      env: {
        ...process.env,
        DB_HOST: "127.0.0.1",
        DB_PORT: String(port),
        DB_USER: "postgres",
        DB_PASS: "postgres",
        DB_DATABASE: "postgres",
        NODE_ENV: "production",
        TZ: "UTC",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    output += value;
  });
  const url = `http://127.0.0.1:${queryPort}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, output.slice(-8000));
    try {
      const result = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
        signal: AbortSignal.timeout(1000),
      });
      if (result.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(ready, output.slice(-8000));
  const client = new WikaPortfolioClient(url);
  const snapshot = await client.snapshot("0xcontract", 110);
  assert.equal(snapshot.height, 100);
  assert.ok(
    Number.isFinite(Date.parse(snapshot.updatedAt)),
    "Numeric live metadata time must normalize to a displayable timestamp",
  );
  const first = await client.load(otherPrefix, snapshot);
  assert.equal(first.records.length, 22); // 20 periods + replacement + pending verification
  assert.equal(
    first.records.find((r) => r.id === "00").period,
    9007199254740993n,
  );
  await db.query(
    `UPDATE "${schema}"._metadata SET value='120'::jsonb WHERE key='lastProcessedHeight'`,
  );
  const second = await client.load(otherPrefix, snapshot, first.cursors);
  assert.equal(second.records.length, 5);
  assert.deepEqual(second.cursors, {
    periods: false,
    replacements: false,
    verifications: false,
  });
  assert.equal(
    [...first.records, ...second.records].some(
      (r) =>
        r.id === "future" ||
        r.id === "outsider" ||
        r.id === "closed" ||
        r.id === "finished",
    ),
    false,
  );
  await assert.rejects(client.snapshot("0xwrong", 110), /different chain/);
  console.log(
    JSON.stringify({
      passed: true,
      service: "@subql/query",
      records: 27,
      periodPages: 2,
      snapshotHeight: 100,
      exactLargePeriod: true,
      ss58Normalization: true,
      excludedOtherWalletsAndClosedRequests: true,
      snapshotStableWhileIndexerAdvances: true,
    }),
  );
} catch (e) {
  console.error(output.slice(-8000));
  throw e;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await db.end();
}
