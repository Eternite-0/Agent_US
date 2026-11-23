import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_PROVIDER_PRESETS,
  mergeProviderPresetCatalog,
} from '../src/data/providerPresets.ts';
import { PROVIDER_LOGO_FILE } from '../src/data/providerLogoFiles.ts';

test('every built-in provider explicitly resolves to a packaged brand image', () => {
  for (const id of Object.keys(BUILTIN_PROVIDER_PRESETS.items)) {
    const file = PROVIDER_LOGO_FILE[id];
    assert.ok(file, id);
    const image = readFileSync(
      new URL(`../src/assets/providers/${file}`, import.meta.url),
    );
    assert.ok(
      file.endsWith('.svg')
        ? /<svg\b/.test(image.toString())
        : image.subarray(1, 4).toString() === 'PNG',
      file,
    );
  }
});
test('a backend-supported native login takes precedence over manual catalog fallback', () => {
  const preset = BUILTIN_PROVIDER_PRESETS.items['workbuddy-intl'];
  assert.equal(
    mergeProviderPresetCatalog(null).items[preset.id].loginMode,
    'manual',
  );
  const remote = {
    ...preset,
    category: 'oauth',
    loginMode: 'web',
    nativeLogin: true,
  };
  assert.deepEqual(
    mergeProviderPresetCatalog({ items: { [preset.id]: remote } }).items[
      preset.id
    ],
    remote,
  );
});
