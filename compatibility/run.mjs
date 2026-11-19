import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const nodeRoot =
  process.env.WIKA_NODE_CHECKOUT ?? resolve(root, "../wika_node");
try {
  const { runSuite } = await import(
    pathToFileURL(resolve(nodeRoot, "compatibility/src/suite.mjs")).href
  );
  await runSuite(root);
} catch (error) {
  console.error(
    error.code === "ERR_MODULE_NOT_FOUND"
      ? "Install the node compatibility harness (npm ci in wika_node/compatibility) and set WIKA_NODE_CHECKOUT if it is not a sibling checkout."
      : error,
  );
  process.exitCode = 1;
}
