import fs from "node:fs/promises";
import path from "node:path";

let JavaScriptObfuscator;
try {
    ({ default: JavaScriptObfuscator } = await import("javascript-obfuscator"));
} catch (err) {
    console.error("Missing dependency: javascript-obfuscator. Run npm install.");
    process.exit(1);
}

const root = process.cwd();
const inputPath = path.join(root, "autofill_bot.js");
const outputPath = path.join(root, "autofill_obs.js");

const source = await fs.readFile(inputPath, "utf8");

const headerMatch = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/);
const header = headerMatch ? headerMatch[0] : "";
const headerWithNewline = header ? (header.endsWith("\n") ? header : `${header}\n`) : "";
const body = header ? source.slice(header.length) : source;

const obfuscated = JavaScriptObfuscator.obfuscate(body, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.6,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.3,
    stringArray: true,
    stringArrayEncoding: ["base64"],
    rotateStringArray: true,
    selfDefending: true,
    identifierNamesGenerator: "hexadecimal",
    transformObjectKeys: true
}).getObfuscatedCode();

await fs.writeFile(outputPath, `${headerWithNewline}${obfuscated}`, "utf8");
console.log("✓ Obfuscated:", path.relative(root, outputPath));
