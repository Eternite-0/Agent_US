#!/usr/bin/env node
import { runCli } from '../src/cli.js';

try {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
} catch (err) {
  process.stderr.write(`Fatal: ${err?.stack || err?.message || String(err)}\n`);
  process.exitCode = 1;
}
