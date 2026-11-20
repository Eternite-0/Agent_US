'use strict';

const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

/**
 * electron-builder afterPack hook.
 * Ensures backend runtime `node_modules` (including scoped packages and nested
 * `node_modules` that electron-builder's default glob filters omit) are copied
 * verbatim into `resources/backend/node_modules` before NSIS / Portable archive
 * creation.
 */
exports.default = async function afterPack(context) {
  const desktopDir = __dirname;
  const stagedNodeModules = join(desktopDir, 'release', '.stage', 'backend', 'node_modules');
  const targetNodeModules = join(context.appOutDir, 'resources', 'backend', 'node_modules');

  if (!existsSync(stagedNodeModules)) {
    throw new Error(`[after-pack] Missing staged backend node_modules at ${stagedNodeModules}`);
  }

  rmSync(targetNodeModules, { recursive: true, force: true });
  mkdirSync(targetNodeModules, { recursive: true });
  cpSync(stagedNodeModules, targetNodeModules, { recursive: true, dereference: true });

  const mustExist = [
    join(targetNodeModules, 'fastify', 'package.json'),
    join(targetNodeModules, 'openai', 'package.json'),
    join(targetNodeModules, 'zod', 'package.json'),
    join(targetNodeModules, '@deepseek-ai', 'dsh-llm', 'package.json'),
  ];
  for (const p of mustExist) {
    if (!existsSync(p)) {
      throw new Error(`[after-pack] Required runtime dependency missing after copy: ${p}`);
    }
  }
  console.log(`[after-pack] Bundled backend runtime node_modules -> ${targetNodeModules}`);
};
