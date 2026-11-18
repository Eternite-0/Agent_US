import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
function key() {
  const value = Buffer.from(process.env.BACKEND_MASTER_KEY ?? '', 'base64');
  if (value.length !== 32)
    throw Error('BACKEND_MASTER_KEY must contain 32 base64-encoded bytes');
  return value;
}
export function seal(path, value) {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([
    c.update(JSON.stringify(value), 'utf8'),
    c.final(),
  ]);
  writeFileSync(path, Buffer.concat([iv, c.getAuthTag(), ciphertext]), {
    mode: 0o600,
    flag: 'wx',
  });
}
export function unseal(path) {
  const b = readFileSync(path);
  const c = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  c.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]));
}
