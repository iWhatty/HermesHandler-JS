import { mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const srcDir = resolve(root, "src");
const distDir = resolve(root, "dist");

await mkdir(distDir, { recursive: true });

// Copy all JS files (and keep folder structure)
await cp(srcDir, distDir, {
  recursive: true,
  force: true
});

console.log(`[build] Copied src -> dist`);
