import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleExtensionHubRequest } from './extension-hub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const forceProd = process.argv.includes('--prod') || isPackaged;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

let mainWindow = null;
let backendProc = null;
let localServer = null;

function getPaths() {
  if (isPackaged) {
    const res = process.resourcesPath;
    const dataDir = join(app.getPath('userData'), 'backend-var');
    mkdirSync(dataDir, { recursive: true });
    return {
      distDir: join(res, 'frontend-dist'),
      backendDir: join(res, 'backend'),
      backendDataDir: dataDir,
    };
  }
  const root = resolve(__dirname, '..');
  const dataDir = join(root, 'backend', 'var');
  mkdirSync(dataDir, { recursive: true });
  return {
    distDir: join(root, 'frontend', 'dist'),
    backendDir: join(root, 'backend'),
    backendDataDir: dataDir,
  };
}

function getOrCreateToken(dataDir) {
  if (process.env.BACKEND_TOKEN && process.env.BACKEND_TOKEN.length >= 24) {
    return process.env.BACKEND_TOKEN;
  }
  const tokenFile = join(dataDir, '.dev-token');
  if (!isPackaged && existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 24) return existing;
  }
  const fresh = randomBytes(32).toString('hex');
  if (!isPackaged) {
    writeFileSync(tokenFile, fresh, 'utf8');
  }
  return fresh;
}

function checkHealth(port) {
  return new Promise((resolveOk) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 1000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolveOk(res.statusCode === 200 && JSON.parse(body).ok === true);
          } catch {
            resolveOk(false);
          }
        });
      },
    );
    req.on('error', () => resolveOk(false));
    req.on('timeout', () => {
      req.destroy();
      resolveOk(false);
    });
    req.end();
  });
}

function checkAuthorized(port, token) {
  return new Promise((resolveOk) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/projects',
        method: 'GET',
        timeout: 1000,
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        resolveOk(res.statusCode === 200);
      },
    );
    req.on('error', () => resolveOk(false));
    req.on('timeout', () => {
      req.destroy();
      resolveOk(false);
    });
    req.end();
  });
}

async function ensureBackend(backendDir, backendDataDir, token) {
  const preferredPort = Number(process.env.PORT || 8787);
  if (await checkHealth(preferredPort)) {
    if (await checkAuthorized(preferredPort, token)) {
      return { port: preferredPort, token, spawned: false };
    }
  }

  // If preferredPort is already bound by another process, fall back to 18787
  const port = (await checkHealth(preferredPort)) ? preferredPort + 10000 : preferredPort;

  // Load optional local config.json & .provider-env.json from backendDataDir (or dev backend/var)
  const extraEnv = {};
  const cfgPath = join(backendDataDir, 'config.json');
  if (!process.env.BACKEND_CONFIG && existsSync(cfgPath)) {
    extraEnv.BACKEND_CONFIG = cfgPath;
  }
  const envFile = join(backendDataDir, '.provider-env.json');
  if (existsSync(envFile)) {
    try {
      const parsed = JSON.parse(readFileSync(envFile, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && !process.env[k]) extraEnv[k] = v;
      }
    } catch {
      // ignore malformed env file
    }
  }

  const entry = join(backendDir, 'src', 'main.js');
  const execBin = process.platform === 'win32' ? 'node.exe' : 'node';
  const child = spawn(isPackaged ? process.execPath : execBin, [entry], {
    cwd: backendDir,
    env: {
      ...process.env,
      ...extraEnv,
      ...(isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      BACKEND_TOKEN: token,
      BACKEND_DATA: backendDataDir,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backendProc = child;

  for (let i = 0; i < 40; i++) {
    if (await checkHealth(port)) {
      return { port, token, spawned: true };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { port, token, spawned: true };
}

function startLocalUiServer(distDir, backendPort, token, backendDataDir) {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/extensions/')) {
        const handled = await handleExtensionHubRequest(req, res, backendDataDir);
        if (handled) return;
      }
      if (
        url.pathname.startsWith('/v1') ||
        url.pathname.startsWith('/api/v1') ||
        url.pathname === '/health'
      ) {
        const upstream = httpRequest(
          {
            host: '127.0.0.1',
            port: backendPort,
            method: req.method,
            path: req.url,
            headers: {
              ...req.headers,
              host: `127.0.0.1:${backendPort}`,
              ...(!req.headers.authorization && token
                ? { authorization: `Bearer ${token}` }
                : {}),
            },
          },
          (uRes) => {
            res.writeHead(uRes.statusCode || 502, uRes.headers);
            uRes.pipe(res);
          },
        );
        upstream.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          }
          res.end(JSON.stringify({ error: { code: 'BACKEND_UNREACHABLE' } }));
        });
        req.pipe(upstream);
        return;
      }

      const clean = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      let filePath = resolve(distDir, clean);
      if (!filePath.startsWith(distDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, 'index.html');
      } catch {
        filePath = join(distDir, 'index.html');
      }
      try {
        const body = await readFile(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('Frontend dist not found. Run npm --prefix ../frontend run build');
      }
    });

    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 5173;
      resolveServer({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function createMainWindow() {
  const { distDir, backendDir, backendDataDir } = getPaths();
  const token = getOrCreateToken(backendDataDir);
  const { port: backendPort } = await ensureBackend(backendDir, backendDataDir, token);

  let targetUrl = process.env.ELECTRON_RENDERER_URL || '';
  if (!targetUrl && !forceProd) {
    // Check if Vite dev server is running on 5173
    const devAlive = await new Promise((ok) => {
      const r = httpRequest({ host: '127.0.0.1', port: 5173, path: '/', method: 'HEAD', timeout: 400 }, () => ok(true));
      r.on('error', () => ok(false));
      r.on('timeout', () => { r.destroy(); ok(false); });
      r.end();
    });
    if (devAlive) targetUrl = 'http://127.0.0.1:5173';
  }

  if (!targetUrl) {
    const started = await startLocalUiServer(distDir, backendPort, token, backendDataDir);
    localServer = started.server;
    targetUrl = started.url;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    title: 'Codex',
    backgroundColor: '#111111',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(url);
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: 'deny' };
  });

  await mainWindow.loadURL(targetUrl);
}

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});

ipcMain.handle('window:close', () => {
  mainWindow?.close();
});

ipcMain.handle('window:is-maximized', () => {
  return Boolean(mainWindow?.isMaximized());
});

ipcMain.handle('dialog:pick-directory', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择项目源文件夹',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const dirPath = res.filePaths[0];
  return { path: dirPath, name: basename(dirPath) };
});

app.whenReady().then(() => {
  void createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
  if (backendProc && !backendProc.killed) {
    backendProc.kill();
    backendProc = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
