import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { mkdir, writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = resolve(root, "..");
const etl = resolve(workspace, "wika_etl/subql_wika");
const output = resolve(
  root,
  process.env.WIKA_PORTFOLIO_REPORT_DIRECTORY ||
    "compatibility/reports/portfolio-live",
);
await mkdir(output, { recursive: true });
const result = {
  passed: false,
  startedAt: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  scope:
    "Native node → finalized ETL → GraphQL → real owners dashboard → signed historical withdrawal → ETL. Development website proof and injected signer fixtures; no Linux/container or production validation.",
  commands: [],
};
const save = () =>
  writeFile(
    join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
const children = new Set();
const groups = new WeakSet();
let pg, directory;
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const signal = (name) => {
    try {
      if (groups.has(child) && process.platform !== "win32")
        process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
async function run(args, cwd, env, logName, timeoutMs = 180000) {
  const stream = createWriteStream(join(output, logName));
  const child = spawn(args[0], args.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  groups.add(child);
  children.add(child);
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const timer = setTimeout(() => void stop(child), timeoutMs);
  try {
    const [code, signal] = await once(child, "exit");
    result.commands.push({ args, cwd, code, signal, log: logName });
    await save();
    assert.equal(
      code,
      0,
      `${args.join(" ")} failed; see ${join(output, logName)}`,
    );
  } finally {
    clearTimeout(timer);
    stream.end();
    children.delete(child);
  }
}
const interrupt = async () => {
  for (const child of children) await stop(child);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
await save();
try {
  let dbPort = process.env.WIKA_TEST_DB_PORT;
  if (!dbPort) {
    assert.ok(
      process.env.WIKA_EMBEDDED_POSTGRES_MODULE,
      "Set WIKA_TEST_DB_PORT for an isolated PostgreSQL, or WIKA_EMBEDDED_POSTGRES_MODULE to an installed embedded-postgres entrypoint. No operator database is selected automatically.",
    );
    const { default: EmbeddedPostgres } = await import(
      pathToFileURL(resolve(process.env.WIKA_EMBEDDED_POSTGRES_MODULE)).href
    );
    directory = await mkdtemp(join(tmpdir(), "wika-portfolio-live-"));
    dbPort = String(await freePort());
    pg = new EmbeddedPostgres({
      databaseDir: join(directory, "postgres"),
      user: "postgres",
      password: "postgres",
      port: Number(dbPort),
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    const require = createRequire(join(etl, "package.json"));
    const { Client } = require("pg");
    const db = new Client({
      host: "127.0.0.1",
      port: Number(dbPort),
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    try {
      await db.connect();
      await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist");
    } finally {
      await db.end();
    }
  }
  // The existing ETL integration fixture uses these two service ports; refuse to collide.
  for (const port of [13100, 13101]) {
    const probe = createServer();
    probe.listen(port, "127.0.0.1");
    await once(probe, "listening");
    await new Promise((resolve) => probe.close(resolve));
  }
  await run(["npm", "run", "build"], root, {}, "consumer-build.log");
  await run(["npm", "run", "codegen"], etl, {}, "etl-codegen.log");
  await run(["npm", "run", "typecheck"], etl, {}, "etl-typecheck.log");
  await run(["npm", "run", "build"], etl, {}, "etl-build.log");
  const rpcPort = await freePort(),
    networkPort = await freePort();
  const binary = resolve(
    process.env.WIKA_NODE_BINARY ||
      join(workspace, "wika_node/target/release/wika-node"),
  );
  const stream = createWriteStream(join(output, "node.log"));
  const node = spawn(
    binary,
    [
      "--dev",
      "--tmp",
      `--rpc-port=${rpcPort}`,
      `--port=${networkPort}`,
      "--no-prometheus",
      "--no-telemetry",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(node);
  node.stdout.pipe(stream, { end: false });
  node.stderr.pipe(stream, { end: false });
  try {
    await run(
      ["npm", "run", "test:integration"],
      etl,
      {
        WIKA_NODE_URL: `ws://127.0.0.1:${rpcPort}`,
        WIKA_TEST_DB_PORT: dbPort,
        WIKA_PORTFOLIO_LIVE_MODULE: join(
          root,
          "compatibility/portfolio-journey.mjs",
        ),
        WIKA_PORTFOLIO_REPORT_DIRECTORY: output,
      },
      "etl-journey-test.log",
      750000,
    );
    const journey = JSON.parse(
      await readFile(join(output, "journey-result.json"), "utf8"),
    );
    assert.equal(journey.passed, true);
    assert.equal(journey.signatures.length, 1);
    assert.equal(journey.stages.length, 5);
    result.journey = journey;
    const sources = [
      "wika_plugins_react/compatibility/portfolio-live.mjs",
      "wika_plugins_react/compatibility/portfolio-journey.mjs",
      "wika_plugins_react/examples/owners/src/App.tsx",
      "wika_plugins_react/examples/owners/src/Portfolio.tsx",
      "wika_plugins_react/packages/core/src/portfolio.ts",
      "wika_plugins_react/packages/core/src/claims-client.ts",
      "wika_etl/subql_wika/tests/live.test.ts",
      "wika_etl/subql_wika/schema.graphql",
      "wika_etl/subql_wika/src/mappings/financial.ts",
      "wika_node/compatibility/src/claims-fixture.mjs",
      "wika_node/verifier/src/worker.mjs",
    ];
    result.sources = Object.fromEntries(
      await Promise.all(
        sources.map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(join(workspace, path)))
            .digest("hex"),
        ]),
      ),
    );
    result.binary = {
      path: binary,
      sha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    };
    result.passed = true;
  } finally {
    await stop(node);
    children.delete(node);
    stream.end();
  }
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const child of children) await stop(child);
  await pg?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  result.finishedAt = new Date().toISOString();
  await save();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
console.log(
  JSON.stringify({
    passed: result.passed,
    reportDirectory: output,
    error: result.error,
  }),
);
