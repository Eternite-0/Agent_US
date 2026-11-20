import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleExtensionHubRequest } from '../desktop/extension-hub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendTarget = process.env.BACKEND_URL || 'http://127.0.0.1:8787';
const backendDataDir = process.env.BACKEND_DATA || resolve(__dirname, '..', 'backend', 'var');
let backendToken = process.env.BACKEND_TOKEN || '';
if (!backendToken) {
  const tokenFile = resolve(backendDataDir, '.dev-token');
  if (existsSync(tokenFile)) {
    try {
      backendToken = readFileSync(tokenFile, 'utf8').trim();
    } catch {
      // ignore
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'agent-us-extension-hub',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url || !req.url.startsWith('/api/extensions/')) {
            next();
            return;
          }
          void handleExtensionHubRequest(req, res, backendDataDir).then((handled) => {
            if (!handled) next();
          });
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/v1': {
        target: backendTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (!req.headers.authorization && backendToken) {
              proxyReq.setHeader('Authorization', `Bearer ${backendToken}`);
            }
          });
        },
      },
      '/api/v1': {
        target: backendTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (!req.headers.authorization && backendToken) {
              proxyReq.setHeader('Authorization', `Bearer ${backendToken}`);
            }
          });
        },
      },
      '/health': {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
});
