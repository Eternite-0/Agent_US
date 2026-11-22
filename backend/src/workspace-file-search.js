import { opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const OMIT_DIRECTORIES = new Set(['.git', '.agent-us', 'node_modules', 'dist', 'coverage', 'upstream', 'var']);
const PROTECTED_ROOTS = ['../../upstream/', '../var/'].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const isHidden = (name) => name.startsWith('.') && !['.github', '.gitignore', '.editorconfig'].includes(name);
const isSensitive = (name) => /\.(?:pem|key|pfx|sqlite(?:3)?|sqlite-wal|sqlite-shm)$/i.test(name);

function isOutside(root, path) {
  const fromRoot = relative(root, path);
  return isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`);
}

export async function searchWorkspaceFiles(workspaceRoot, { search = '', limit = 20, kind = 'file' } = {}) {
  const workspace = resolve(workspaceRoot);
  if (PROTECTED_ROOTS.some((root) => !isOutside(root, workspace))) return [];
  const root = await realpath(workspace);
  if (PROTECTED_ROOTS.some((path) => !isOutside(path, root))) return [];
  const query = String(search).trim().toLowerCase().replaceAll('\\', '/').slice(0, 200);
  const maxResults = Math.max(1, Math.min(30, Math.trunc(Number(limit) || 20)));
  const directories = [root];
  const matches = [];
  let scanned = 0;
  for (let index = 0; index < directories.length && index < 400 && scanned < 15_000; index += 1) {
    const directory = directories[index];
    try {
      const canonical = await realpath(directory);
      if (isOutside(root, canonical) || canonical !== directory) continue;
      for await (const entry of await opendir(canonical)) {
        scanned += 1;
        if (scanned > 15_000) break;
        const name = entry.name;
        if (isHidden(name) || /[\u0000-\u001f\u007f]/u.test(name)) continue;
        const fullPath = join(canonical, name);
        const path = relative(root, fullPath).split(sep).join('/');
        if (entry.isDirectory()) {
          if (OMIT_DIRECTORIES.has(name.toLowerCase())) continue;
          if (directories.length < 400) directories.push(fullPath);
          if (kind !== 'file' && path.toLowerCase().includes(query)) matches.push(`${path}/`);
        } else if (kind !== 'folder' && entry.isFile() && !isSensitive(name) && path.toLowerCase().includes(query)) {
          matches.push(path);
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
    if (!query && matches.length >= maxResults) break;
  }
  const relevance = (path) => basename(path).toLowerCase().startsWith(query) ? 0 : 1;
  return matches.sort((a, b) => relevance(a) - relevance(b) || a.length - b.length || a.localeCompare(b)).slice(0, maxResults);
}
