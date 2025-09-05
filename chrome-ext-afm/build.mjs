import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";

const RAW_URL = "https://raw.githubusercontent.com/MrKadyroff/AFM/refs/heads/main/autofill_obs.js";
const OUT_DIR = "payload";
const OUT_FILE = path.join(OUT_DIR, "autofill_obs.js");

function download(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
            let data = ""; res.setEncoding("utf8");
            res.on("data", (c) => data += c);
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });
}

console.log("↓ Скачиваем payload из GitHub…");
const code = await download(RAW_URL);

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(OUT_FILE, code, "utf8");
console.log("✓ Обновлено:", OUT_FILE);
