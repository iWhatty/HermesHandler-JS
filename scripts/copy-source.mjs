import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);

const sourceDir = join(rootDir, "src");
const outputDir = join(rootDir, "dist");

await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });
