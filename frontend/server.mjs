import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const PORT = Number(process.env.FRONTEND_PORT || 5173);
const DIST = resolve('dist');
const BACKEND = new URL(process.env.BACKEND_URL || 'http://127.0.0.1:8787');
let BACKEND_TOKEN = process.env.BACKEND_TOKEN || '';
if (!BACKEND_TOKEN) {
  const tokenFile = resolve('..', 'backend', 'var', '.dev-token');
  if (existsSync(tokenFile)) {
    try {
      BACKEND_TOKEN = readFileSync(tokenFile, 'utf8').trim();
    } catch {
      // ignore
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function proxyRequest(req, res) {
  const targetReq = (BACKEND.protocol === 'https:' ? httpsRequest : httpRequest)(
    {
      protocol: BACKEND.protocol,
      hostname: BACKEND.hostname,
      port: BACKEND.port || (BACKEND.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: BACKEND.host,
        ...(!req.headers.authorization && BACKEND_TOKEN
          ? { authorization: `Bearer ${BACKEND_TOKEN}` }
          : {}),
      },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  targetReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: { code: 'BACKEND_UNREACHABLE' } }));
  });
  req.pipe(targetReq);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/v1/') || url.pathname === '/health') {
    return proxyRequest(req, res);
  }
  const clean = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  let filePath = resolve(DIST, clean);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    filePath = join(DIST, 'index.html');
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found. Run `npm run build` first.');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex Frontend running at http://127.0.0.1:${PORT} -> backend ${BACKEND.origin}`);
});
