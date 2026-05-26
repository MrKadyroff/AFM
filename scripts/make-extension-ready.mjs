import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const extDir = path.join(rootDir, "chrome-ext-afm");
const outDir = path.join(rootDir, "afm-ext");

async function copyFileSafe(from, to) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
}

async function copyDirRecursive(fromDir, toDir) {
    await fs.mkdir(toDir, { recursive: true });
    const entries = await fs.readdir(fromDir, { withFileTypes: true });

    for (const entry of entries) {
        const src = path.join(fromDir, entry.name);
        const dst = path.join(toDir, entry.name);
        if (entry.isDirectory()) {
            await copyDirRecursive(src, dst);
        } else if (entry.isFile()) {
            await copyFileSafe(src, dst);
        }
    }
}

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

await copyFileSafe(path.join(extDir, "manifest.json"), path.join(outDir, "manifest.json"));
await copyFileSafe(path.join(extDir, "content.js"), path.join(outDir, "content.js"));
await copyFileSafe(
    path.join(extDir, "payload", "autofill_runtime.js"),
    path.join(outDir, "payload", "autofill_runtime.js")
);
await copyDirRecursive(path.join(extDir, "icons"), path.join(outDir, "icons"));

console.log("Ready extension folder:", path.relative(rootDir, outDir));
