import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.WIKA_CORE_MODULE = pathToFileURL(resolve('packages/core/dist/index.js')).href;
const nodeRoot = process.env.WIKA_NODE_CHECKOUT ?? resolve('../wika_node');
await import(pathToFileURL(resolve(nodeRoot, 'verifier/integration/safe-claims.mjs')).href);
