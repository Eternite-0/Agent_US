import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 100% Standalone Extension Hub for Agent_US (ZERO dependency on ~/.codex!).
 *
 * - Ships with self-contained built-in catalog (`catalog-seed.json`) covering Creativity
 *   (Remotion, HyperFrames by HeyGen, Figma, Canva, Product Design, Higgsfield, fal, HeyGen,
 *   Adobe, Krea, Creative Claw, PixVerse, Kling AI, ImagineArt, Picsart, Morphix, etc.)
 *   and all 8 other categories so it works identically on ANY clean PC.
 * - Supports live online installation of real SKILL.md / manifests from public GitHub repos
 *   (e.g. remotion-dev/remotion, heygen-com/hyperframes, obra/superpowers, openai/skills,
 *   or any user-supplied GitHub repo URL) with graceful offline fallback to bundled definitions.
 * - Stores all installed plugins & personal skills strictly inside Agent_US's own `backendDataDir/extensions/`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, 'catalog-seed.json');

const SKILL_HUES = [
  ['#a78bfa', '#f472b6', '#fbbf24'],
  ['#fb923c', '#f472b6', '#c084fc'],
  ['#38bdf8', '#a78bfa', '#f472b6'],
  ['#34d399', '#60a5fa', '#a78bfa'],
  ['#facc15', '#fb7185', '#a78bfa'],
  ['#60a5fa', '#34d399', '#c084fc'],
];

function pickHue(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return SKILL_HUES[h % SKILL_HUES.length];
}

function loadSeed() {
  try {
    const raw = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
    return {
      channelName: raw.channelName || 'Agent_US Open Hub (GitHub / MCP)',
      upstreamSkillsRepo: raw.upstreamSkillsRepo || 'openai/skills',
      plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
      skills: Array.isArray(raw.skills)
        ? raw.skills.map((s) => ({ ...s, hue: s.hue || pickHue(s.slug || s.id || s.name) }))
        : [],
    };
  } catch {
    return {
      channelName: 'Agent_US Open Hub (GitHub / MCP)',
      upstreamSkillsRepo: 'openai/skills',
      plugins: [],
      skills: [],
    };
  }
}

function readRegistry(extDir) {
  const regPath = join(extDir, 'registry.json');
  try {
    if (existsSync(regPath)) {
      const parsed = JSON.parse(readFileSync(regPath, 'utf8'));
      return {
        installedPluginIds: Array.isArray(parsed.installedPluginIds) ? parsed.installedPluginIds : [],
        customPlugins: Array.isArray(parsed.customPlugins) ? parsed.customPlugins : [],
        pluginEndpoints:
          parsed.pluginEndpoints && typeof parsed.pluginEndpoints === 'object'
            ? parsed.pluginEndpoints
            : {},
        skillStates:
          parsed.skillStates && typeof parsed.skillStates === 'object' ? parsed.skillStates : {},
        remoteCuratedSlugs: Array.isArray(parsed.remoteCuratedSlugs)
          ? parsed.remoteCuratedSlugs
          : [],
      };
    }
  } catch {
    // ignore corrupt registry
  }
  return {
    installedPluginIds: [],
    customPlugins: [],
    pluginEndpoints: {},
    skillStates: {},
    remoteCuratedSlugs: [],
  };
}

function writeRegistry(extDir, reg) {
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, 'registry.json'), JSON.stringify(reg, null, 2), 'utf8');
}

function formatTitle(slug) {
  if (!slug) return 'Skill';
  if (/[A-Z\u4e00-\u9fa5]/.test(slug)) return slug;
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function parseSkillMd(filePath, fallbackSlug) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    let name = fallbackSlug;
    let description = '';
    let body = raw;
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (fm) {
      const yaml = fm[1];
      body = fm[2].trim();
      const nm = yaml.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      const dm = yaml.match(/^description:\s*["']?(.+?)["']?\s*$/m);
      if (nm) name = nm[1].trim();
      if (dm) description = dm[1].trim();
    }
    if (!description) {
      const firstLine = body
        .split(/\r?\n/)
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .find((l) => l.length > 6);
      description = firstLine ? firstLine.slice(0, 140) : `Custom skill (${fallbackSlug})`;
    }
    return {
      name: formatTitle(name),
      slug: fallbackSlug,
      description: description.slice(0, 180),
      instructions: body.slice(0, 6000) || description,
    };
  } catch {
    return null;
  }
}

function scanOwnPersonalSkills(extDir) {
  const dir = join(extDir, 'skills');
  if (!existsSync(dir)) return [];
  const list = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const mdPath = join(dir, ent.name, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const parsed = parseSkillMd(mdPath, ent.name);
    if (!parsed) continue;
    list.push({
      id: ent.name.toLowerCase(),
      slug: ent.name,
      name: parsed.name,
      scope: 'personal',
      description: parsed.description,
      instructions: parsed.instructions,
      hue: pickHue(ent.name),
      installed: true,
      custom: true,
    });
  }
  return list;
}

async function fetchTextWithTimeout(url, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Agent-US-Extension-Hub/1.0',
        Accept: 'application/vnd.github.v3+json, text/plain, */*',
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads a real SKILL.md directly from a public GitHub repo (no Codex dependency!).
 */
async function tryFetchGithubSkillMd(spec) {
  if (!spec || !spec.repo || !spec.path) return null;
  const branch = spec.branch || 'main';
  const rawUrl = `https://raw.githubusercontent.com/${spec.repo}/${branch}/${spec.path.replace(/^\/+/, '')}`;
  const text = await fetchTextWithTimeout(rawUrl, 4500);
  if (text && text.trim().length > 20) {
    return { text, rawUrl };
  }
  return null;
}

/**
 * Refreshes open-source curated skill slugs from public GitHub repo `openai/skills` (optional online sync).
 */
async function tryRefreshUpstreamSkills(upstreamRepo) {
  const apiUrl = `https://api.github.com/repos/${upstreamRepo}/contents/skills/.curated`;
  const raw = await fetchTextWithTimeout(apiUrl, 4500);
  if (!raw) return null;
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return null;
    return items
      .filter((it) => it && it.type === 'dir' && typeof it.name === 'string')
      .map((it) => it.name);
  } catch {
    return null;
  }
}

function buildHubCatalog({ extDir, query = '' }) {
  const seed = loadSeed();
  const reg = readRegistry(extDir);
  const q = String(query || '').trim().toLowerCase();

  // Merge built-in seed plugins + user custom plugins + saved endpoints
  const pluginMap = new Map();
  for (const p of seed.plugins) {
    pluginMap.set(p.id, {
      ...p,
      tools: p.bundledSkills?.length ? p.bundledSkills : [`${p.slug || p.id}_invoke`],
      endpoint: reg.pluginEndpoints[p.id] || p.endpoint,
    });
  }
  for (const cp of reg.customPlugins) {
    pluginMap.set(cp.id, {
      ...cp,
      endpoint: reg.pluginEndpoints[cp.id] || cp.endpoint,
    });
  }

  let plugins = [...pluginMap.values()];
  if (q) {
    plugins = plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.longDescription || '').toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.bundledSkills || p.tools || []).some((t) => t.toLowerCase().includes(q)),
    );
  }

  // Merge Agent_US's own personal skills + built-in system/recommended skills + optional upstream GitHub slugs
  const personal = scanOwnPersonalSkills(extDir);
  const seenSlugs = new Set(personal.map((s) => s.slug.toLowerCase()));
  const skills = [...personal];

  for (const sk of seed.skills) {
    const slug = (sk.slug || sk.id).toLowerCase();
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    skills.push({
      ...sk,
      installed: sk.id in reg.skillStates ? Boolean(reg.skillStates[sk.id]) : Boolean(sk.installed),
    });
  }

  for (const slug of reg.remoteCuratedSlugs) {
    const low = String(slug).toLowerCase();
    if (seenSlugs.has(low)) continue;
    seenSlugs.add(low);
    const id = `rec-${low}`;
    skills.push({
      id,
      slug,
      name: formatTitle(slug),
      scope: 'recommended',
      description: `Open-source curated skill from github.com/${seed.upstreamSkillsRepo}`,
      instructions: `Follow the ${formatTitle(slug)} workflow from ${seed.upstreamSkillsRepo}.`,
      githubSkillSpec: {
        repo: seed.upstreamSkillsRepo,
        branch: 'main',
        path: `skills/.curated/${slug}/SKILL.md`,
      },
      hue: pickHue(slug),
      installed: id in reg.skillStates ? Boolean(reg.skillStates[id]) : false,
    });
  }

  return {
    source: {
      available: true,
      channelName: seed.channelName,
      totalCatalogPlugins: pluginMap.size,
      upstreamSkillsRepo: seed.upstreamSkillsRepo,
      localSkillsCount: skills.length,
      extensionsDir: extDir,
    },
    plugins,
    skills,
    installedPluginIds: reg.installedPluginIds,
  };
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) rejectBody(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (e) {
        rejectBody(e);
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseGithubRepoUrl(input) {
  const m = String(input || '')
    .trim()
    .match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/tree\/([^/]+)\/(.+))?/i);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2].replace(/\.git$/i, ''),
    branch: m[3] || 'main',
    subPath: m[4] || '',
  };
}

/**
 * Handles /api/extensions/* requests for both Vite dev server and standalone Electron desktop app.
 */
export async function handleExtensionHubRequest(req, res, backendDataDir) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/api/extensions/')) return false;

  const extDir = join(backendDataDir, 'extensions');
  mkdirSync(extDir, { recursive: true });

  try {
    if (req.method === 'GET' && url.pathname === '/api/extensions/catalog') {
      const q = url.searchParams.get('q') || '';
      const refresh = url.searchParams.get('refresh') === '1';
      if (refresh) {
        const seed = loadSeed();
        const slugs = await tryRefreshUpstreamSkills(seed.upstreamSkillsRepo);
        if (slugs && slugs.length > 0) {
          const reg = readRegistry(extDir);
          reg.remoteCuratedSlugs = slugs;
          writeRegistry(extDir, reg);
        }
      }
      sendJson(res, 200, buildHubCatalog({ extDir, query: q }));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/plugins/install') {
      const body = await readJsonBody(req);
      const plugin = body.plugin;
      if (!plugin || !plugin.id) {
        sendJson(res, 400, { error: 'Missing plugin payload' });
        return true;
      }
      const reg = readRegistry(extDir);
      if (!reg.installedPluginIds.includes(plugin.id)) {
        reg.installedPluginIds = [plugin.id, ...reg.installedPluginIds];
      }
      if (plugin.custom && !reg.customPlugins.some((p) => p.id === plugin.id)) {
        reg.customPlugins = [plugin, ...reg.customPlugins];
      }
      if (typeof body.endpoint === 'string' && body.endpoint.trim()) {
        reg.pluginEndpoints[plugin.id] = body.endpoint.trim();
      }

      const safeId = String(plugin.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      const targetDir = join(extDir, 'plugins', safeId);
      mkdirSync(targetDir, { recursive: true });

      // Attempt live GitHub raw SKILL.md download when plugin declares a public githubSkillSpec!
      let fetchedFromGithub = false;
      const spec = plugin.githubSkillSpec;
      if (spec) {
        const fetched = await tryFetchGithubSkillMd(spec);
        if (fetched) {
          mkdirSync(join(targetDir, 'skills'), { recursive: true });
          writeFileSync(join(targetDir, 'skills', 'SKILL.md'), fetched.text, 'utf8');
          fetchedFromGithub = true;
        }
      }

      // Always write a self-contained manifest & bundled skill summary (never stores secrets!)
      writeFileSync(
        join(targetDir, 'plugin.json'),
        JSON.stringify(
          {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version || '1.0.0',
            category: plugin.category,
            description: plugin.description,
            transport: plugin.transport,
            endpoint: reg.pluginEndpoints[plugin.id] || plugin.endpoint,
            websiteUrl: plugin.websiteUrl,
            repositoryUrl: plugin.repositoryUrl,
            bundledSkills: plugin.bundledSkills || plugin.tools || [],
            fetchedFromGithub,
            installedAt: Date.now(),
          },
          null,
          2,
        ),
        'utf8',
      );

      writeRegistry(extDir, reg);
      sendJson(res, 200, {
        ok: true,
        installedDir: targetDir,
        fetchedFromGithub,
        installedPluginIds: reg.installedPluginIds,
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/plugins/install-github') {
      const body = await readJsonBody(req);
      const parsed = parseGithubRepoUrl(body.url);
      if (!parsed) {
        sendJson(res, 400, { error: '请输入有效的 GitHub 仓库链接，例如 https://github.com/owner/repo' });
        return true;
      }
      const slug = parsed.repo.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const id = `gh-${parsed.owner.toLowerCase()}-${slug}`;
      const candidatePaths = parsed.subPath
        ? [`${parsed.subPath.replace(/\/+$/, '')}/SKILL.md`, parsed.subPath]
        : ['SKILL.md', 'README.md'];

      let fetchedContent = '';
      for (const p of candidatePaths) {
        const hit = await tryFetchGithubSkillMd({
          repo: `${parsed.owner}/${parsed.repo}`,
          branch: parsed.branch,
          path: p,
        });
        if (hit) {
          fetchedContent = hit.text;
          break;
        }
      }

      const plugin = {
        id,
        slug,
        name: formatTitle(parsed.repo),
        version: 'github',
        category: body.category || 'Creativity',
        description: `Installed from github.com/${parsed.owner}/${parsed.repo}`,
        longDescription: fetchedContent ? fetchedContent.slice(0, 600) : `Open-source plugin from ${body.url}`,
        author: parsed.owner,
        transport: 'GitHub · Open Source',
        endpoint: `https://github.com/${parsed.owner}/${parsed.repo}`,
        websiteUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
        repositoryUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
        bundledSkills: [slug],
        tools: [slug],
        tileBg: '#18181b',
        tileFg: '#ffffff',
        custom: true,
      };

      const reg = readRegistry(extDir);
      reg.customPlugins = [plugin, ...reg.customPlugins.filter((p) => p.id !== plugin.id)];
      if (!reg.installedPluginIds.includes(plugin.id)) {
        reg.installedPluginIds = [plugin.id, ...reg.installedPluginIds];
      }
      const targetDir = join(extDir, 'plugins', id.replace(/[^a-zA-Z0-9_-]/g, '_'));
      mkdirSync(targetDir, { recursive: true });
      if (fetchedContent) {
        writeFileSync(join(targetDir, 'SKILL.md'), fetchedContent, 'utf8');
      }
      writeFileSync(join(targetDir, 'plugin.json'), JSON.stringify(plugin, null, 2), 'utf8');
      writeRegistry(extDir, reg);

      sendJson(res, 200, {
        ok: true,
        plugin,
        fetchedFromGithub: Boolean(fetchedContent),
        installedPluginIds: reg.installedPluginIds,
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/plugins/uninstall') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      const reg = readRegistry(extDir);
      reg.installedPluginIds = reg.installedPluginIds.filter((x) => x !== id);
      writeRegistry(extDir, reg);
      const targetDir = join(extDir, 'plugins', id.replace(/[^a-zA-Z0-9_-]/g, '_'));
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      sendJson(res, 200, { ok: true, installedPluginIds: reg.installedPluginIds });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/skills/toggle') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      const nextInstalled = Boolean(body.installed);
      const reg = readRegistry(extDir);
      reg.skillStates[id] = nextInstalled;

      // If enabling a recommended skill that has a public GitHub SKILL.md, download a local copy into extensions/skills!
      let fetchedFromGithub = false;
      if (nextInstalled && body.skill?.githubSkillSpec) {
        const fetched = await tryFetchGithubSkillMd(body.skill.githubSkillSpec);
        if (fetched) {
          const safeSlug = String(body.skill.slug || id).replace(/[^a-zA-Z0-9_-]/g, '-');
          const skDir = join(extDir, 'skills', safeSlug);
          mkdirSync(skDir, { recursive: true });
          writeFileSync(join(skDir, 'SKILL.md'), fetched.text, 'utf8');
          fetchedFromGithub = true;
        }
      }
      writeRegistry(extDir, reg);
      sendJson(res, 200, { ok: true, id, installed: nextInstalled, fetchedFromGithub });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/skills/save') {
      const body = await readJsonBody(req);
      const sk = body.skill;
      if (!sk || !sk.name) {
        sendJson(res, 400, { error: 'Missing skill payload' });
        return true;
      }
      const safeSlug =
        String(sk.slug || sk.id || sk.name)
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-|-$/g, '') || `skill-${Date.now()}`;
      const skDir = join(extDir, 'skills', safeSlug);
      mkdirSync(skDir, { recursive: true });
      const md = `---\nname: ${sk.name}\ndescription: ${String(sk.description || '').replace(/\r?\n/g, ' ')}\n---\n\n${sk.instructions || ''}\n`;
      writeFileSync(join(skDir, 'SKILL.md'), md, 'utf8');
      const reg = readRegistry(extDir);
      reg.skillStates[sk.id || safeSlug] = true;
      writeRegistry(extDir, reg);
      sendJson(res, 200, { ok: true, path: join(skDir, 'SKILL.md'), slug: safeSlug });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/extensions/skills/delete') {
      const body = await readJsonBody(req);
      const slug = String(body.slug || body.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (slug) {
        const skDir = join(extDir, 'skills', slug);
        if (existsSync(skDir)) rmSync(skDir, { recursive: true, force: true });
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    sendJson(res, 404, { error: 'Unknown /api/extensions route' });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
    return true;
  }
}
