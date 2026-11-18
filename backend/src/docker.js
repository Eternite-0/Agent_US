import { spawn } from 'node:child_process';
import { Fault } from './store.js';
export function docker(args, { input = '', signal, cap = 800000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: 'pipe',
      windowsHide: true,
      signal,
    });
    let size = 0;
    const out = [],
      err = [];
    child.on('error', reject);
    child.stdin.on('error', () => {});
    for (const [stream, buffers] of [
      [child.stdout, out],
      [child.stderr, err],
    ])
      stream.on('data', (b) => {
        size += b.length;
        if (size > cap) {
          child.kill();
          reject(new Fault('OUTPUT_LIMIT'));
        } else buffers.push(b);
      });
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString())
        : reject(new Fault('CONTAINER_UNAVAILABLE', 503)),
    );
    child.stdin.end(input);
  });
}
