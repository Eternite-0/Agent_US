import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

// One short-lived listener per grant. No callback query, vendor error body or token
// is reflected into the browser, the UI polling response, or diagnostic logs.
export async function listenForGrant({
  path,
  origin,
  signal,
  receive,
  intermediate,
}) {
  let busy = false,
    result,
    failed = false;
  const server = createServer({ maxHeaderSize: 32768 }, async (req, res) => {
    const host = `127.0.0.1:${req.socket.localPort}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (req.headers.host !== host || req.url.split('?')[0] !== path)
      return res.writeHead(404).end();
    if (req.headers.origin && req.headers.origin !== origin)
      return res.writeHead(403).end();
    if (req.headers.origin === origin)
      res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS')
      return res
        .writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        })
        .end();
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (busy || signal.aborted) return res.writeHead(409).end();
    const q = new URL(req.url, `http://${host}`).searchParams;
    if (intermediate && intermediate(q, res)) return;
    busy = true;
    try {
      if (q.has('error')) throw new Error('授权被拒绝');
      result = await receive(q, `http://${host}${path}`, req);
      res.end('授权已完成，可以关闭此页面并返回 Agent_US。');
    } catch {
      failed = true;
      res.writeHead(400).end('授权未完成，请返回 Agent_US 重试。');
    } finally {
      server.close();
    }
  });
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const close = () => {
    server.close();
    server.closeAllConnections();
    result = null;
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) {
    close();
    signal.throwIfAborted();
  }
  return {
    callback: `http://127.0.0.1:${server.address().port}${path}`,
    poll() {
      if (failed) throw new Error('授权失败');
      return result;
    },
  };
}
