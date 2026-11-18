import { resolve } from 'node:path';
import { service } from './service.js';
const runtime = await service({
  root: resolve(process.env.BACKEND_DATA ?? 'var'),
  token: process.env.BACKEND_TOKEN,
});
try {
  console.log(
    await runtime.app.listen({
      host: '127.0.0.1',
      port: Number(process.env.PORT ?? 8787),
    }),
  );
} catch (e) {
  await runtime.close();
  throw e;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
