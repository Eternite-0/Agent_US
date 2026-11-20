// Usage: node scripts/stills.mjs 200 500 900 ...
import path from "node:path";
import fs from "node:fs";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const frames = process.argv.slice(2).map(Number);
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const opts = { serveUrl, id: "AgentUSDefense", browserExecutable: fs.existsSync(chrome) ? chrome : undefined };
const composition = await selectComposition(opts);
fs.mkdirSync("out/stills", { recursive: true });
for (const frame of frames) {
  const output = path.resolve(`out/stills/f${String(frame).padStart(5, "0")}.png`);
  await renderStill({ ...opts, composition, frame, output, scale: 0.5 });
  console.log("wrote", output);
}
