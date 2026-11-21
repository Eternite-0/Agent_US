import { resolve } from 'node:path';
import { service } from './service.js';
import { logEvent } from './observability/logger.js';

const port = Number(process.env.PORT ?? 8787);
const runtime = await service({
  root: resolve(process.env.BACKEND_DATA ?? 'var'),
  token: process.env.BACKEND_TOKEN,
});
try {
  const address = await runtime.app.listen({
    host: '127.0.0.1',
    port,
  });
  console.log(address);
  logEvent('info', 'server.started', {
    address,
    host: '127.0.0.1',
    port,
    pid: process.pid,
  });
} catch (e) {
  logEvent('error', 'server.start_failed', {
    host: '127.0.0.1',
    port,
    error: e,
  });
  await runtime.close();
  throw e;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  logEvent('info', 'server.stopping', { pid: process.pid });
  await runtime.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
