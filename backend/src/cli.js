import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const CLI_VERSION = '3.0.0';

export const VALID_PERMISSION_MODES = Object.freeze([
  'read-only',
  'approval',
  'auto-review',
  'auto-safe',
  'workspace-write',
  'full-access',
]);

const TERMINAL_SWARM_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'cancelled', 'reconciling']);
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BACKEND_ROOT = resolve(MODULE_DIR, '..');

/**
 * Error raised for invalid CLI invocation, connection failure, or backend API rejection.
 */
export class CliError extends Error {
  constructor(message, { code = 'CLI_ERROR', exitCode = 1, status = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.status = status;
  }
}

export function normalizePathKey(p) {
  const norm = resolve(String(p || '.'));
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function isResumeValueCandidate(arg, hasMorePositionalsAfter = false) {
  if (!arg || arg.startsWith('-')) return false;
  if (arg === 'latest') return true;
  if (hasMorePositionalsAfter) return !/\s/.test(arg);
  return /^[A-Za-z0-9._:-]+$/.test(arg);
}

/**
 * Parses CLI flags, subcommands (`import`), `--resume`, `--swarm`, and prompt text.
 */
export function parseCliArgs(argv = [], { cwd = process.cwd() } = {}) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const out = {
    command: 'chat',
    prompt: '',
    swarmGoal: '',
    url: '',
    token: '',
    dataDir: '',
    cwd: resolve(cwd),
    cwdExplicit: false,
    model: '',
    permission: '',
    resume: null,
    yes: false,
    skip: false,
    autostart: true,
    repl: false,
    json: false,
    help: false,
    version: false,
  };

  const positionals = [];
  let seenDoubleDash = false;

  const takeValue = (flag, inlineVal, i) => {
    if (inlineVal !== undefined) return { value: inlineVal, nextIndex: i };
    const next = args[i + 1];
    if (next === undefined) {
      throw new CliError(`Option ${flag} requires a value.`, { code: 'MISSING_ARG_VALUE' });
    }
    return { value: next, nextIndex: i + 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (seenDoubleDash) {
      positionals.push(raw);
      continue;
    }
    if (raw === '--') {
      seenDoubleDash = true;
      continue;
    }
    if (!raw.startsWith('-') || raw === '-') {
      positionals.push(raw);
      continue;
    }

    const eqIdx = raw.indexOf('=');
    const flag = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw;
    const inlineVal = eqIdx >= 0 ? raw.slice(eqIdx + 1) : undefined;

    switch (flag) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-v':
      case '--version':
        out.version = true;
        break;
      case '-y':
      case '--yes':
      case '--auto-approve':
        out.yes = true;
        break;
      case '--skip':
        out.skip = true;
        break;
      case '--no-autostart':
        out.autostart = false;
        break;
      case '-i':
      case '--repl':
      case '--interactive':
        out.repl = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--url': {
        const { value, nextIndex } = takeValue(flag, inlineVal, i);
        out.url = value;
        i = nextIndex;
        break;
      }
      case '--token': {
        const { value, nextIndex } = takeValue(flag, inlineVal, i);
        out.token = value;
        i = nextIndex;
        break;
      }
      case '--data-dir': {
        const { value, nextIndex } = takeValue(flag, inlineVal, i);
        out.dataDir = resolve(cwd, value);
        i = nextIndex;
        break;
      }
      case '-C':
      case '--cwd': {
        const { value, nextIndex } = takeValue(flag, inlineVal, i);
        out.cwd = resolve(cwd, value);
        out.cwdExplicit = true;
        i = nextIndex;
        break;
      }
      case '-m':
      case '--model': {
        const { value, nextIndex } = takeValue(flag, inlineVal, i);
        out.model = value;
        i = nextIndex;
        break;
      }
      case '-p':
      case '--permission':
      case '--permission-mode': {
        const { value, nextIndex } = takeValue(flag, inlineVal, i);
        if (!VALID_PERMISSION_MODES.includes(value)) {
          throw new CliError(
            `Invalid permission mode "${value}". Valid values: ${VALID_PERMISSION_MODES.join(', ')}`,
            { code: 'INVALID_PERMISSION_MODE' },
          );
        }
        out.permission = value;
        i = nextIndex;
        break;
      }
      case '--swarm': {
        const { value, nextIndex } = takeValue(flag, inlineVal, i);
        if (!value.trim()) {
          throw new CliError('--swarm requires a non-empty goal.', { code: 'EMPTY_SWARM_GOAL' });
        }
        out.command = 'swarm';
        out.swarmGoal = value.trim();
        i = nextIndex;
        break;
      }
      case '-r':
      case '--resume': {
        if (inlineVal !== undefined) {
          out.resume = inlineVal.trim() || 'latest';
        } else {
          const next = args[i + 1];
          const hasMore = args[i + 2] !== undefined && !args[i + 2].startsWith('-');
          if (isResumeValueCandidate(next, hasMore)) {
            out.resume = next;
            i++;
          } else {
            out.resume = 'latest';
          }
        }
        break;
      }
      default:
        throw new CliError(`Unknown option: ${flag}`, { code: 'UNKNOWN_OPTION' });
    }
  }

  if (out.command !== 'swarm' && positionals[0] === 'import') {
    out.command = 'import';
    positionals.shift();
  }

  if (out.command === 'swarm' && !out.swarmGoal && positionals.length) {
    out.swarmGoal = positionals.join(' ').trim();
  } else if (positionals.length) {
    out.prompt = positionals.join(' ').trim();
  }

  return out;
}

export function formatHelpText() {
  return [
    `Agent_US CLI v${CLI_VERSION}`,
    '',
    'Usage:',
    '  agent-us [options] [prompt]',
    '  agent-us --swarm "<goal>" [options]',
    '  agent-us import [--yes | --skip] [options]',
    '',
    'Options:',
    '  --url <url>               Backend base URL (default: $BACKEND_URL or http://127.0.0.1:8787)',
    '  --token <token>           Backend bearer token (default: $BACKEND_TOKEN or <dataDir>/.dev-token)',
    '  --data-dir <dir>          Backend data dir (default: $BACKEND_DATA or backend/var)',
    '  -C, --cwd <dir>           Workspace root directory (default: current working directory)',
    '  -m, --model <model>       Model alias for session/turn',
    '  -p, --permission <mode>   read-only | approval | auto-review | auto-safe | workspace-write | full-access',
    '  -r, --resume [id|latest]  Resume latest or specified session',
    '  --swarm <goal>            Run /swarm <goal> and stream execution & verification progress',
    '  -y, --yes, --auto-approve Auto-approve tool approvals and import confirmations',
    '  --skip                    Skip external onboarding import (with `import`)',
    '  --no-autostart            Do not auto-spawn local backend daemon when /health is unreachable',
    '  -i, --repl                Force interactive REPL mode',
    '  --json                    Print raw SSE JSON events instead of formatted terminal output',
    '  -h, --help                Show help',
    '  -v, --version             Show version',
    '',
    'Interactive REPL Commands:',
    '  /steer <text>             Inject mid-turn steering guidance (or start a turn if idle)',
    '  /undo [files|both] [turn] Rewind file/conversation changes (POST /v1/sessions/:id/rewind)',
    '  /redo [redoId]            Redo the last rewind (POST /v1/sessions/:id/rewind/redo)',
    '  /git                      Show workspace git changes (GET /v1/git/changes)',
    '  /import [--yes|--skip]    Detect & import ~/.claude / ~/.codex configs',
    '  /swarm <goal|status|stop> Launch or control a Swarm run',
    '  /compact                  Compact conversation context',
    '  /status                   Inspect current session & pending approvals',
    '  /cancel                   Cancel active turn or swarm run',
    '  /commands                 List built-in and workspace custom slash commands',
    '  /exit                     Exit CLI',
  ].join('\n');
}

/**
 * Formats non-empty piped stdin cleanly before the user prompt.
 */
export function formatPipedPrompt(prompt, pipedText) {
  const cleanPipe = String(pipedText ?? '').replace(/\r\n/g, '\n').trimEnd();
  const cleanPrompt = String(prompt ?? '').trim();
  if (!cleanPipe) return cleanPrompt;
  if (!cleanPrompt) return `<piped_stdin>\n${cleanPipe}\n</piped_stdin>`;
  return `<piped_stdin>\n${cleanPipe}\n</piped_stdin>\n\n${cleanPrompt}`;
}

/**
 * Safely captures non-TTY stdin stream up to `maxBytes`.
 */
export async function readPipedStdin(
  stdin,
  { isTty = Boolean(stdin?.isTTY), maxBytes = 512 * 1024 } = {},
) {
  if (!stdin || isTty) return '';
  if (stdin.readableEnded) return '';
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (total < maxBytes) {
      const remaining = maxBytes - total;
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        total += remaining;
        truncated = true;
      } else {
        chunks.push(buf);
        total += buf.length;
      }
    } else {
      truncated = true;
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return truncated ? `${text}\n[... piped stdin truncated at ${maxBytes} bytes ...]` : text;
}

export function readDevToken(dataDir) {
  if (!dataDir) return '';
  const tokenFile = join(dataDir, '.dev-token');
  if (!existsSync(tokenFile)) return '';
  try {
    return readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

export function loadProviderEnv(dataDir, env = process.env) {
  if (!dataDir) return {};
  const file = join(dataDir, '.provider-env.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && !env[k]) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveConnectionConfig(
  parsed,
  { cwd = process.cwd(), env = process.env, backendRoot = DEFAULT_BACKEND_ROOT } = {},
) {
  const dataDir = parsed.dataDir
    ? resolve(cwd, parsed.dataDir)
    : env.BACKEND_DATA
      ? resolve(cwd, env.BACKEND_DATA)
      : resolve(backendRoot, 'var');
  const defaultPort = env.PORT || '8787';
  const baseUrl = String(parsed.url || env.BACKEND_URL || `http://127.0.0.1:${defaultPort}`)
    .trim()
    .replace(/\/+$/, '');
  const token = String(parsed.token || env.BACKEND_TOKEN || readDevToken(dataDir) || '').trim();
  return {
    baseUrl,
    dataDir,
    token,
    workspaceRoot: parsed.cwd || resolve(cwd),
    cwdExplicit: Boolean(parsed.cwdExplicit),
  };
}

function isLocalUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return LOCAL_HOSTNAMES.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function probeHealth(baseUrl, fetchImpl, timeoutMs = 1500) {
  try {
    const res = await fetchImpl(`${baseUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Probes `/health` and, if unreachable and local (unless `--no-autostart`),
 * spawns detached `node backend/src/main.js` and polls `/health` cleanly.
 */
export async function ensureBackendReady({
  baseUrl,
  dataDir,
  token,
  backendRoot = DEFAULT_BACKEND_ROOT,
  autostart = true,
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  pollIntervalMs = 200,
  startupTimeoutMs = 15000,
} = {}) {
  if (await probeHealth(baseUrl, fetchImpl)) {
    return { baseUrl, dataDir, token, started: false };
  }
  if (!autostart) {
    throw new CliError(
      `Backend is unreachable at ${baseUrl}/health and --no-autostart is set.`,
      { code: 'BACKEND_UNREACHABLE' },
    );
  }
  if (!isLocalUrl(baseUrl)) {
    throw new CliError(
      `Backend is unreachable at ${baseUrl}/health (refusing to autostart non-local URL).`,
      { code: 'BACKEND_UNREACHABLE' },
    );
  }

  mkdirSync(dataDir, { recursive: true });
  let effectiveToken = token;
  if (!effectiveToken || effectiveToken.length < 24) {
    const fromFile = readDevToken(dataDir);
    if (fromFile.length >= 24) {
      effectiveToken = fromFile;
    } else {
      effectiveToken = randomBytes(32).toString('hex');
      try {
        writeFileSync(join(dataDir, '.dev-token'), effectiveToken, {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch {
        // ignore read-only dir errors; token still passes via env
      }
    }
  }

  let port = '8787';
  try {
    const u = new URL(baseUrl);
    if (u.port) port = u.port;
  } catch {
    // keep default
  }

  const providerEnv = loadProviderEnv(dataDir, env);
  const cfgFile = join(dataDir, 'config.json');
  const extraConfigEnv = !env.BACKEND_CONFIG && existsSync(cfgFile) ? { BACKEND_CONFIG: cfgFile } : {};
  const mainEntry = resolve(backendRoot, 'src', 'main.js');

  let logFd = null;
  let stdio = 'ignore';
  try {
    logFd = openSync(join(dataDir, 'daemon.log'), 'a');
    stdio = ['ignore', logFd, logFd];
  } catch {
    stdio = 'ignore';
  }

  let child;
  try {
    child = spawnImpl(process.execPath, [mainEntry], {
      cwd: backendRoot,
      detached: true,
      windowsHide: true,
      stdio,
      env: {
        ...env,
        ...providerEnv,
        ...extraConfigEnv,
        BACKEND_DATA: dataDir,
        BACKEND_TOKEN: effectiveToken,
        PORT: String(port),
      },
    });
    child?.unref?.();
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        // ignore
      }
    }
  }

  let exitedEarly = false;
  let exitCode = null;
  child?.once?.('exit', (code) => {
    exitedEarly = true;
    exitCode = code;
  });

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(baseUrl, fetchImpl, 1000)) {
      return { baseUrl, dataDir, token: effectiveToken, started: true, pid: child?.pid ?? null };
    }
    if (exitedEarly) break;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new CliError(
    exitedEarly
      ? `Autostarted backend exited early (code=${exitCode}) before becoming healthy at ${baseUrl}/health.`
      : `Timed out waiting for backend at ${baseUrl}/health after ${startupTimeoutMs}ms.`,
    { code: 'BACKEND_STARTUP_FAILED' },
  );
}

/**
 * Lightweight HTTP + SSE client targeting Agent_US `/v1/*`.
 */
export class AgentUsClient {
  constructor({ baseUrl, token = '', fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = String(token || '');
    this.fetchImpl = fetchImpl;
  }

  buildUrl(path, query = null) {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  async request(method, path, { query = null, body = undefined, signal = undefined } = {}) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(this.buildUrl(path, query), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const errObj = data && typeof data === 'object' ? data.error : null;
      const code = errObj?.code || `HTTP_${res.status}`;
      const msg = errObj?.message || (typeof data === 'string' && data) || `${method} ${path} failed (${res.status})`;
      throw new CliError(msg, { code, status: res.status });
    }
    return data;
  }

  listSessions(query = {}) {
    return this.request('GET', '/v1/sessions', { query });
  }

  getSession(id) {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  createSession(body) {
    return this.request('POST', '/v1/sessions', { body });
  }

  updateSession(id, body) {
    return this.request('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, { body });
  }

  listTurns(id, limit = 20) {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(id)}/turns`, { query: { limit } });
  }

  listMessages(id, { after = 0, limit = 100 } = {}) {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(id)}/messages`, {
      query: { after, limit },
    });
  }

  listEvents(id, { after = 0, limit = 1000 } = {}) {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(id)}/events`, {
      query: { after, limit },
    });
  }

  startTurn(id, body) {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(id)}/turns`, { body });
  }

  steerSession(id, input, opts = {}) {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(id)}/steer`, {
      body: { input, ...(opts.files ? { files: opts.files } : {}) },
    });
  }

  cancelTurn(turnId) {
    return this.request('POST', `/v1/turns/${encodeURIComponent(turnId)}/cancel`);
  }

  compactSession(id) {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(id)}/compact`);
  }

  rewindSession(id, body = { scope: 'both' }) {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(id)}/rewind`, { body });
  }

  redoRewind(id, body = {}) {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(id)}/rewind/redo`, { body });
  }

  listApprovals(query = {}) {
    return this.request('GET', '/v1/approvals', { query });
  }

  decideApproval(id, body) {
    return this.request('POST', `/v1/approvals/${encodeURIComponent(id)}/decision`, { body });
  }

  listChildSessions(id) {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(id)}/children`);
  }

  getSwarmRun(runId) {
    return this.request('GET', `/v1/swarm/runs/${encodeURIComponent(runId)}`);
  }

  cancelSwarmRun(runId) {
    return this.request('POST', `/v1/swarm/runs/${encodeURIComponent(runId)}/cancel`);
  }

  async getGitChanges(sessionId) {
    try {
      return await this.request('GET', '/v1/git/changes', { query: { sessionId } });
    } catch (err) {
      if (err?.status === 404) {
        return this.request('GET', '/v1/git/status', { query: { sessionId } });
      }
      throw err;
    }
  }

  detectExternalConfigs({ sessionId = null, workspaceRoot = null, force = true } = {}) {
    return this.request('GET', '/v1/onboarding/detect-external', {
      query: {
        ...(sessionId ? { sessionId } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        force: force ? '1' : '0',
      },
    });
  }

  importExternalConfigs(body) {
    return this.request('POST', '/v1/onboarding/import-external', { body });
  }

  async getWorkspaceCustomizations(sessionId = null) {
    try {
      return await this.request('GET', '/v1/workspace/customizations', {
        query: sessionId ? { sessionId } : null,
      });
    } catch (err) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Opens a resilient SSE stream on `/v1/sessions/:id/stream` with seq deduplication
   * and automatic reconnect while active.
   */
  connectStream(sessionId, { after = 0, onEvent, onError = null } = {}) {
    let closed = false;
    let lastSeq = Number(after) || 0;
    let controller = null;
    let activeReader = null;
    let backoffMs = 250;
    let retryTimer = null;
    let connectedOnce = false;
    const ready = Promise.withResolvers();

    const pump = async () => {
      while (!closed) {
        controller = new AbortController();
        try {
          const url = this.buildUrl(`/v1/sessions/${encodeURIComponent(sessionId)}/stream`, {
            after: lastSeq,
          });
          const headers = { Accept: 'text/event-stream' };
          if (this.token) headers.Authorization = `Bearer ${this.token}`;
          if (lastSeq > 0) headers['Last-Event-ID'] = String(lastSeq);
          const res = await this.fetchImpl(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            throw new CliError(`SSE stream failed (${res.status})`, {
              code: 'SSE_ERROR',
              status: res.status,
            });
          }
          backoffMs = 250;
          if (!connectedOnce) {
            connectedOnce = true;
            ready.resolve();
          }
          const reader = res.body.getReader();
          activeReader = reader;
          const decoder = new TextDecoder();
          let buffer = '';
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
              if (!frame.trim() || frame.trim().startsWith(':')) continue;
              let eventId = '';
              let eventName = '';
              const dataLines = [];
              for (const line of frame.split(/\r?\n/)) {
                if (line.startsWith('id:')) eventId = line.slice(3).trim();
                else if (line.startsWith('event:')) eventName = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
              }
              const dataText = dataLines.join('\n');
              if (!dataText) continue;
              let parsed;
              try {
                parsed = JSON.parse(dataText);
              } catch {
                continue;
              }
              const ev =
                parsed && typeof parsed === 'object'
                  ? { ...parsed, type: parsed.type || eventName }
                  : { type: eventName, data: parsed };
              const isEphemeral =
                ev.ephemeral === true ||
                ev.type === 'assistant/delta' ||
                ev.type === 'reasoning/delta' ||
                ev.type === 'tool/output';
              if (isEphemeral) {
                onEvent?.(ev);
                continue;
              }
              const seq = Number(ev.seq ?? eventId ?? 0);
              if (!Number.isFinite(seq) || seq <= 0) {
                onEvent?.(ev);
              } else if (seq > lastSeq) {
                ev.seq = seq;
                lastSeq = seq;
                onEvent?.(ev);
              }
            }
          }
        } catch (err) {
          if (closed) break;
          if (!connectedOnce && err?.status && err.status >= 400 && err.status < 500) {
            ready.reject(err);
            return;
          }
          onError?.(err);
        }
        if (closed) break;
        await new Promise((r) => {
          retryTimer = setTimeout(r, backoffMs);
          retryTimer.unref?.();
        });
        backoffMs = Math.min(backoffMs * 2, 4000);
      }
    };

    const loopPromise = pump();
    return {
      ready: ready.promise,
      done: loopPromise,
      getLastSeq: () => lastSeq,
      close: () => {
        if (closed) return;
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        activeReader?.cancel().catch(() => {});
        activeReader = null;
        controller?.abort();
        if (!connectedOnce) {
          connectedOnce = true;
          ready.resolve();
        }
      },
    };
  }
}

/**
 * Coordinates single-line reading from stdin so REPL commands and approval prompts never fight over stdin.
 */
export class LineInput {
  constructor(stdin, { isTty = Boolean(stdin?.isTTY), stdout = process.stdout } = {}) {
    this.stdin = stdin;
    this.isTty = isTty;
    this.stdout = stdout;
    this.closed = false;
    this.pendingLines = [];
    this.waiters = [];
    this.rl = null;
  }

  start() {
    if (this.rl || !this.stdin) return;
    this.rl = createInterface({
      input: this.stdin,
      terminal: Boolean(this.isTty),
      crlfDelay: Infinity,
    });
    this.rl.on('line', (line) => {
      if (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        waiter.resolve(line);
      } else {
        this.pendingLines.push(line);
      }
    });
    this.rl.on('close', () => {
      this.closed = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        waiter.resolve(null);
      }
    });
  }

  nextLine({ prompt = '', signal = null } = {}) {
    this.start();
    if (prompt && this.stdout) {
      this.stdout.write(prompt);
    }
    if (this.pendingLines.length > 0) {
      return Promise.resolve(this.pendingLines.shift());
    }
    if (this.closed || !this.stdin) {
      return Promise.resolve(null);
    }
    return new Promise((resolveLine) => {
      const waiter = { resolve: resolveLine };
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolveLine(null);
      };
      if (signal) {
        if (signal.aborted) {
          resolveLine(null);
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        const origResolve = waiter.resolve;
        waiter.resolve = (val) => {
          signal.removeEventListener('abort', onAbort);
          origResolve(val);
        };
      }
      this.waiters.push(waiter);
    });
  }

  close() {
    this.closed = true;
    this.rl?.close();
    this.rl = null;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter.resolve(null);
    }
  }
}

function compactText(val, max = 140) {
  const s = typeof val === 'string' ? val : JSON.stringify(val ?? {});
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

/**
 * Formats live Agent_US SSE events into readable terminal output without dropping or duplicating deltas.
 */
export class SseRenderer {
  constructor({ stdout = process.stdout, stderr = process.stderr, json = false, onApprovalRequested = null, onApprovalResolved = null } = {}) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.json = Boolean(json);
    this.onApprovalRequested = onApprovalRequested;
    this.onApprovalResolved = onApprovalResolved;
    this.inlineMode = 'none';
    this.sawAssistantDelta = new Map();
  }

  ensureNewline() {
    if (this.inlineMode !== 'none') {
      this.stdout.write('\n');
      this.inlineMode = 'none';
    }
  }

  writeLine(text, stream = this.stdout) {
    this.ensureNewline();
    stream.write(`${text}\n`);
  }

  render(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (this.json) {
      this.stdout.write(`${JSON.stringify(ev)}\n`);
      return;
    }
    const type = ev.type || '';
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
    const turnId = ev.turnId || data.turnId || '';

    switch (type) {
      case 'reasoning/delta': {
        const delta = String(data.delta ?? '');
        if (!delta) break;
        if (this.inlineMode !== 'reasoning') {
          this.ensureNewline();
          this.stdout.write('[thinking] ');
          this.inlineMode = 'reasoning';
        }
        this.stdout.write(delta);
        break;
      }
      case 'assistant/delta': {
        const delta = String(data.delta ?? '');
        if (!delta) break;
        if (this.inlineMode !== 'assistant') {
          this.ensureNewline();
          this.inlineMode = 'assistant';
        }
        this.stdout.write(delta);
        if (turnId) this.sawAssistantDelta.set(turnId, true);
        break;
      }
      case 'tool/call': {
        const argsStr = compactText(data.arguments ?? {}, 120);
        this.writeLine(`[tool] ${data.name || 'tool'}${argsStr && argsStr !== '{}' ? ` ${argsStr}` : ''}`);
        break;
      }
      case 'tool/output': {
        const chunk = String(data.chunk ?? data.delta ?? data.output ?? data.text ?? '');
        if (!chunk) break;
        if (this.inlineMode !== 'tool_output') {
          this.ensureNewline();
          this.inlineMode = 'tool_output';
        }
        this.stdout.write(chunk);
        if (chunk.endsWith('\n')) this.inlineMode = 'none';
        break;
      }
      case 'tool/result': {
        if (data.isError) {
          this.writeLine(`[tool:error] ${data.name || ''} ${compactText(data.output || data.error || '', 160)}`, this.stderr);
        }
        break;
      }
      case 'turn/steered': {
        this.writeLine(`[steered] queued: ${data.text || ''}`);
        break;
      }
      case 'turn/steer_injected': {
        const texts = Array.isArray(data.texts) ? data.texts.join(' | ') : (data.text || '');
        this.writeLine(`[steer_injected] step=${data.step ?? '?'} count=${data.count ?? 1}${texts ? `: ${texts}` : ''}`);
        break;
      }
      case 'turn/route_failover': {
        this.writeLine(
          `[route_failover] attempt=${data.attempt ?? '?'} status=${data.statusCode ?? '?'} ${data.fromAccountId || '?'} -> ${data.toAccountId || '?'} (${data.reason || 'failover'})`,
        );
        break;
      }
      case 'file/changed': {
        const stats =
          data.additions !== undefined || data.deletions !== undefined
            ? ` (+${data.additions ?? 0}/-${data.deletions ?? 0})`
            : '';
        this.writeLine(`[file] ${data.action || 'changed'} ${data.path || ''}${stats}`);
        break;
      }
      case 'approval/requested': {
        this.ensureNewline();
        this.onApprovalRequested?.({ ...data, id: data.approvalId ?? data.id });
        break;
      }
      case 'approval/resolved': {
        this.onApprovalResolved?.({ ...data, id: data.approvalId ?? data.id });
        this.writeLine(`[approval] ${data.approvalId || data.id || ''} -> ${data.status || 'resolved'} (${data.scope || 'once'})`);
        break;
      }
      case 'turn/completed': {
        if (turnId && !this.sawAssistantDelta.get(turnId) && data.text) {
          this.ensureNewline();
          this.stdout.write(`${data.text}\n`);
        }
        const tokens = `${data.inputTokens ?? 0}+${data.outputTokens ?? 0}`;
        this.writeLine(
          `[completed] turn=${turnId || '?'} model=${data.model || '?'} steps=${data.steps ?? 0} tokens=${tokens} (${data.durationMs ?? 0}ms)`,
        );
        break;
      }
      case 'turn/failed': {
        this.writeLine(`[failed] ${data.code || 'TURN_FAILED'}: ${data.error || 'Turn failed'}`, this.stderr);
        break;
      }
      case 'turn/cancelled': {
        this.writeLine(`[cancelled] turn=${turnId || '?'}`);
        break;
      }
      case 'turn/parked': {
        this.writeLine(`[parked] ${data.reason || ''} approval=${data.approvalId || ''}`);
        break;
      }
      case 'swarm/run_started': {
        this.writeLine(`[swarm] started run=${data.runId || ''} nodes=${data.nodeCount ?? 0} goal=${compactText(data.goal || '', 120)}`);
        break;
      }
      case 'swarm/node_updated': {
        this.writeLine(
          `[swarm:node] ${data.nodeKey || data.nodeId || '?'} -> ${data.status || '?'}${data.errorCode ? ` (${data.errorCode})` : ''}`,
        );
        break;
      }
      case 'swarm/message': {
        this.writeLine(
          `[swarm:msg] ${data.fromNodeKey || data.fromAgentId || '?'} -> ${data.toNodeKey || data.toAgentId || '?'}: ${compactText(data.message ?? data.payload ?? data.kind ?? '', 120)}`,
        );
        break;
      }
      case 'swarm/replanned': {
        this.writeLine(`[swarm:replan] run=${data.runId || ''}`);
        break;
      }
      case 'subagent/started':
      case 'subagent/completed':
      case 'subagent/failed': {
        this.writeLine(`[${type}] ${data.childSessionId || data.agentId || ''} ${compactText(data.summary || data.error || '', 120)}`);
        break;
      }
      case 'verifier/verdict': {
        this.writeLine(`[verifier] passed=${data.passed ?? data.ok ?? '?'} ${compactText(data.summary || data.reason || '', 140)}`);
        break;
      }
      case 'swarm/run_completed': {
        this.writeLine(`[swarm] run=${data.runId || ''} status=${data.status || 'completed'}`);
        break;
      }
      case 'session/rewound': {
        const count = Array.isArray(data.restoredFiles) ? data.restoredFiles.length : 0;
        this.writeLine(`[rewind] scope=${data.scope || 'both'} restored=${count} removedMessages=${data.removedMessages ?? 0}`);
        break;
      }
      case 'file/reverted': {
        this.writeLine(`[reverted] ${data.path || ''} (${data.action || 'restored'})`);
        break;
      }
      case 'session/rewind_redone': {
        const count = Array.isArray(data.restoredFiles) ? data.restoredFiles.length : 0;
        this.writeLine(`[redo] restored=${count}`);
        break;
      }
      default:
        break;
    }
  }
}

export function mapApprovalAnswer(answer) {
  const clean = String(answer ?? '').trim().toLowerCase();
  if (['y', 'yes', '1', 'o', 'once'].includes(clean)) {
    return { decision: 'allow', scope: 'once' };
  }
  if (['a', 'always', 's', 'session', '2'].includes(clean)) {
    return { decision: 'allow', scope: 'session' };
  }
  return { decision: 'deny', scope: 'once' };
}

/**
 * Serializes tool approval prompts from SSE events and `/v1/approvals` polling.
 */
export class ApprovalCoordinator {
  constructor({
    client,
    sessionId,
    autoApprove = false,
    lineInput = null,
    promptFn = null,
    stdout = process.stdout,
    stderr = process.stderr,
    renderer = null,
    pollIntervalMs = 800,
    includeChildren = false,
  } = {}) {
    this.client = client;
    this.sessionId = sessionId;
    this.autoApprove = Boolean(autoApprove);
    this.lineInput = lineInput;
    this.promptFn = promptFn;
    this.stdout = stdout;
    this.stderr = stderr;
    this.renderer = renderer;
    this.pollIntervalMs = pollIntervalMs;
    this.includeChildren = Boolean(includeChildren);
    this.seenIds = new Set();
    this.resolvedIds = new Set();
    this.activePromptAbort = null;
    this.activeApprovalId = null;
    this.queueChain = Promise.resolve();
    this.pollTimer = null;
    this.stopped = false;
  }

  enqueue(approval) {
    const approvalId = approval?.id || approval?.approvalId;
    if (!approvalId || this.seenIds.has(approvalId) || this.resolvedIds.has(approvalId)) return;
    this.seenIds.add(approvalId);
    this.queueChain = this.queueChain
      .then(() => this.#handleApproval({ ...approval, id: approvalId }))
      .catch((err) => {
        this.renderer?.ensureNewline?.();
        this.stderr.write(`[approval error] ${err?.message || err}\n`);
      });
  }

  markResolved(ev) {
    const approvalId = ev?.id || ev?.approvalId;
    if (!approvalId) return;
    this.resolvedIds.add(approvalId);
    if (this.activeApprovalId === approvalId && this.activePromptAbort) {
      this.activePromptAbort.abort();
    }
  }

  async #handleApproval(approval) {
    if (this.stopped || this.resolvedIds.has(approval.id)) return;
    const argsSummary = compactText(approval.arguments ?? {}, 180);
    if (this.autoApprove) {
      this.renderer?.ensureNewline?.();
      this.stdout.write(`[auto-approve] ${approval.tool || 'tool'} (${approval.id}) ${argsSummary}\n`);
      await this.#submitDecision(approval.id, {
        decision: 'allow',
        scope: 'once',
        reason: 'CLI --yes auto-approve',
      });
      return;
    }

    this.renderer?.ensureNewline?.();
    this.stdout.write(
      `[approval required] id=${approval.id} tool=${approval.tool || 'tool'} risk=${approval.riskLevel || 'unknown'}\n` +
        `  args: ${argsSummary}\n`,
    );

    const abortController = new AbortController();
    this.activePromptAbort = abortController;
    this.activeApprovalId = approval.id;

    let answer = null;
    try {
      const q = 'Approve? [y] once / [a] always (session) / [n] deny: ';
      if (this.promptFn) {
        answer = await this.promptFn(q, approval, abortController.signal);
      } else if (this.lineInput) {
        answer = await this.lineInput.nextLine({ prompt: q, signal: abortController.signal });
      }
    } finally {
      this.activePromptAbort = null;
      this.activeApprovalId = null;
    }

    if (this.resolvedIds.has(approval.id) || abortController.signal.aborted) {
      return;
    }

    if (answer === null) {
      this.stderr.write('[approval] No interactive stdin available; denying (pass --yes to auto-approve).\n');
      await this.#submitDecision(approval.id, {
        decision: 'deny',
        scope: 'once',
        reason: 'No interactive terminal input',
      });
      return;
    }

    const mapped = mapApprovalAnswer(answer);
    await this.#submitDecision(approval.id, mapped);
  }

  async #submitDecision(approvalId, payload) {
    try {
      await this.client.decideApproval(approvalId, payload);
      this.resolvedIds.add(approvalId);
    } catch (err) {
      if (err?.code === 'APPROVAL_INACTIVE' || err?.status === 409) {
        this.resolvedIds.add(approvalId);
        return;
      }
      throw err;
    }
  }

  async pollOnce() {
    if (this.stopped) return;
    try {
      if (this.includeChildren) {
        const [res, childrenRes] = await Promise.all([
          this.client.listApprovals({ status: 'pending', limit: 200 }),
          this.client.listChildSessions(this.sessionId).catch(() => ({ items: [] })),
        ]);
        const allowedSessions = new Set([
          this.sessionId,
          ...(childrenRes?.items ?? []).map((c) => c.id),
        ]);
        for (const item of res?.items ?? []) {
          if (allowedSessions.has(item.sessionId)) this.enqueue(item);
        }
      } else {
        const res = await this.client.listApprovals({
          sessionId: this.sessionId,
          status: 'pending',
          limit: 200,
        });
        for (const item of res?.items ?? []) {
          this.enqueue(item);
        }
      }
    } catch {
      // Transient polling errors are ignored; SSE and next poll retry.
    }
  }

  startPolling() {
    if (this.pollTimer || this.stopped) return;
    void this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async flush() {
    await this.queueChain.catch(() => {});
  }

  async stop() {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.activePromptAbort?.abort();
    await this.queueChain.catch(() => {});
  }
}

async function getLatestEventSeq(client, sessionId) {
  let after = 0;
  for (let page = 0; page < 50; page++) {
    const res = await client.listEvents(sessionId, { after, limit: 1000 });
    const items = Array.isArray(res?.items) ? res.items : [];
    if (!items.length) break;
    const last = items[items.length - 1];
    if (typeof last?.seq === 'number' && last.seq > after) {
      after = last.seq;
    } else {
      break;
    }
    if (items.length < 1000) break;
  }
  return after;
}

async function resolveResumeSession(client, target, { workspaceRoot, cwdExplicit }) {
  if (target && target !== 'latest') {
    return client.getSession(target);
  }
  let res = await client.listSessions({ scope: 'chats', limit: 50 });
  let items = Array.isArray(res?.items) ? res.items : [];
  if (!items.length) {
    res = await client.listSessions({ limit: 50 });
    items = Array.isArray(res?.items) ? res.items : [];
  }
  if (!items.length) {
    throw new CliError('No sessions found to resume.', { code: 'NO_SESSIONS_FOUND' });
  }
  if (cwdExplicit) {
    const targetKey = normalizePathKey(workspaceRoot);
    const matching = items.find((s) => s.workspaceRoot && normalizePathKey(s.workspaceRoot) === targetKey);
    if (matching) return matching;
  }
  return items[0];
}

async function runImportFlow({
  client,
  sessionId = null,
  workspaceRoot = null,
  yes = false,
  skip = false,
  lineInput = null,
  promptFn = null,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const detected = await client.detectExternalConfigs({ sessionId, workspaceRoot, force: true });
  const items = Array.isArray(detected?.items) ? detected.items : [];
  if (!items.length) {
    stdout.write('[import] No external ~/.claude or ~/.codex configurations detected.\n');
    return { ok: true, action: 'none', importedCount: 0 };
  }

  stdout.write(`[import] Detected ${items.length} external asset(s):\n`);
  for (const item of items) {
    stdout.write(
      `  - [${item.provider}/${item.scope}] ${item.kind}: ${item.name} (${item.displayPath || item.id})\n`,
    );
  }

  let action = null;
  if (skip) {
    action = 'skip';
  } else if (yes) {
    action = 'import';
  } else {
    const q = `Import ${items.length} asset(s) into Agent_US native storage? [y]es / [s]kip / [c]ancel: `;
    let answer = null;
    if (promptFn) {
      answer = await promptFn(q, detected);
    } else if (lineInput) {
      answer = await lineInput.nextLine({ prompt: q });
    }
    if (answer === null) {
      stderr.write('[import] No interactive confirmation received; pass --yes to import or --skip to dismiss.\n');
      return { ok: false, action: 'cancelled', importedCount: 0 };
    }
    const clean = String(answer).trim().toLowerCase();
    if (['y', 'yes', '1'].includes(clean)) action = 'import';
    else if (['s', 'skip', 'n', 'no'].includes(clean)) action = 'skip';
    else {
      stdout.write('[import] Cancelled.\n');
      return { ok: true, action: 'cancelled', importedCount: 0 };
    }
  }

  const body =
    action === 'import'
      ? {
          ...(sessionId ? { sessionId } : {}),
          action: 'import',
          itemIds: items.map((i) => i.id),
          targetScope: 'auto',
        }
      : {
          ...(sessionId ? { sessionId } : {}),
          action: 'skip',
        };
  const result = await client.importExternalConfigs(body);
  if (action === 'skip') {
    stdout.write('[import] External config onboarding skipped.\n');
  } else {
    stdout.write(`[import] Imported ${result?.importedCount ?? items.length} asset(s) into Agent_US.\n`);
  }
  return result;
}

function formatGitChanges(data, stdout) {
  if (!data?.available) {
    stdout.write('[git] Not a git repository.\n');
    return;
  }
  const aheadBehind =
    data.ahead || data.behind ? ` (ahead ${data.ahead ?? 0}, behind ${data.behind ?? 0})` : '';
  stdout.write(`[git] branch=${data.branch || '(detached)'}${aheadBehind} root=${data.workspaceRoot || ''}\n`);
  const printGroup = (label, list) => {
    if (!Array.isArray(list) || !list.length) return;
    stdout.write(`  ${label} (${list.length}):\n`);
    for (const item of list) {
      const p = typeof item === 'string' ? item : item.path;
      const st = typeof item === 'object' && item.status ? `${item.status} ` : '';
      stdout.write(`    ${st}${p}\n`);
    }
  };
  printGroup('staged', data.staged);
  printGroup('unstaged', data.unstaged);
  printGroup('untracked', data.untracked);
  if (Array.isArray(data.blockedSensitive) && data.blockedSensitive.length) {
    stdout.write(`  blockedSensitive: ${data.blockedSensitive.join(', ')}\n`);
  }
  if (
    !data.staged?.length &&
    !data.unstaged?.length &&
    !data.untracked?.length &&
    data.uncommittedCount !== undefined
  ) {
    stdout.write(`  uncommittedCount: ${data.uncommittedCount}\n`);
  }
}

async function runSwarmAndStream({
  client,
  session,
  goal,
  permission = '',
  autoApprove = false,
  lineInput = null,
  promptFn = null,
  stdout = process.stdout,
  stderr = process.stderr,
  json = false,
  initialAfterSeq = 0,
  approvalPollMs = 800,
  swarmPollMs = 800,
}) {
  let activeRunId = null;
  const terminal = Promise.withResolvers();
  const renderer = new SseRenderer({
    stdout,
    stderr,
    json,
    onApprovalRequested: (a) => approvals.enqueue(a),
    onApprovalResolved: (a) => approvals.markResolved(a),
  });
  const approvals = new ApprovalCoordinator({
    client,
    sessionId: session.id,
    autoApprove,
    lineInput,
    promptFn,
    stdout,
    stderr,
    renderer,
    pollIntervalMs: approvalPollMs,
    includeChildren: true,
  });

  const stream = client.connectStream(session.id, {
    after: initialAfterSeq,
    onEvent: (ev) => {
      renderer.render(ev);
      if (ev.type === 'swarm/run_completed') {
        const evRunId = ev.data?.runId;
        if (!activeRunId || !evRunId || evRunId === activeRunId) {
          terminal.resolve({ status: ev.data?.status || 'completed', event: ev });
        }
      }
    },
  });

  let swarmPoll = null;
  try {
    await stream.ready;
    approvals.startPolling();
    const res = await client.startTurn(session.id, {
      input: `/swarm ${goal}`,
      clientTurnId: `cli-swarm-${randomUUID()}`,
      ...(permission ? { permissionMode: permission } : {}),
    });
    activeRunId = res?.runId || res?.run?.id || null;
    if (res?.message) {
      renderer.writeLine(`[swarm] ${res.message}`);
    }
    if (res?.run?.status && TERMINAL_SWARM_STATES.has(res.run.status)) {
      terminal.resolve({ status: res.run.status, run: res.run });
    } else if (activeRunId) {
      swarmPoll = setInterval(async () => {
        try {
          const run = await client.getSwarmRun(activeRunId);
          if (run && TERMINAL_SWARM_STATES.has(run.status)) {
            terminal.resolve({ status: run.status, run });
          }
        } catch {
          // ignore transient poll error
        }
      }, swarmPollMs);
      swarmPoll.unref?.();
    } else {
      terminal.resolve({ status: 'completed', response: res });
    }
    const outcome = await terminal.promise;
    return outcome.status === 'completed' ? 0 : 1;
  } finally {
    if (swarmPoll) clearInterval(swarmPoll);
    await approvals.stop();
    stream.close();
    renderer.ensureNewline();
  }
}

async function runSingleTurnAndStream({
  client,
  session,
  input,
  model = '',
  permission = '',
  autoApprove = false,
  lineInput = null,
  promptFn = null,
  stdout = process.stdout,
  stderr = process.stderr,
  json = false,
  initialAfterSeq = 0,
  approvalPollMs = 800,
}) {
  let expectedTurnId = null;
  let earlyTerminal = null;
  const terminal = Promise.withResolvers();
  const renderer = new SseRenderer({
    stdout,
    stderr,
    json,
    onApprovalRequested: (a) => approvals.enqueue(a),
    onApprovalResolved: (a) => approvals.markResolved(a),
  });
  const approvals = new ApprovalCoordinator({
    client,
    sessionId: session.id,
    autoApprove,
    lineInput,
    promptFn,
    stdout,
    stderr,
    renderer,
    pollIntervalMs: approvalPollMs,
  });

  const handleTerminalCandidate = (ev) => {
    const evTurnId = ev.turnId || ev.data?.turnId || '';
    if (expectedTurnId) {
      if (!evTurnId || evTurnId === expectedTurnId) {
        terminal.resolve(ev);
      }
    } else {
      earlyTerminal = ev;
    }
  };

  const stream = client.connectStream(session.id, {
    after: initialAfterSeq,
    onEvent: (ev) => {
      renderer.render(ev);
      if (
        ev.type === 'turn/completed' ||
        ev.type === 'turn/failed' ||
        ev.type === 'turn/cancelled' ||
        ev.type === 'turn/parked'
      ) {
        handleTerminalCandidate(ev);
      }
    },
  });

  try {
    await stream.ready;
    approvals.startPolling();
    const res = await client.startTurn(session.id, {
      input,
      clientTurnId: `cli-${randomUUID()}`,
      ...(model ? { model } : {}),
      ...(permission ? { permissionMode: permission } : {}),
    });
    expectedTurnId = res?.turn?.id || null;
    if (earlyTerminal) {
      const earlyTurnId = earlyTerminal.turnId || earlyTerminal.data?.turnId || '';
      if (!expectedTurnId || !earlyTurnId || earlyTurnId === expectedTurnId) {
        terminal.resolve(earlyTerminal);
      }
    }
    if (res?.turn?.state && TERMINAL_TURN_STATES.has(res.turn.state)) {
      terminal.resolve({ type: `turn/${res.turn.state}`, turnId: res.turn.id, data: res.turn });
    }
    const finalEv = await terminal.promise;
    return finalEv?.type === 'turn/completed' ? 0 : 1;
  } finally {
    await approvals.stop();
    stream.close();
    renderer.ensureNewline();
  }
}

async function runInteractiveRepl({
  client,
  session: initialSession,
  workspaceRoot,
  model = '',
  permission = '',
  autoApprove = false,
  lineInput,
  promptFn = null,
  stdout = process.stdout,
  stderr = process.stderr,
  json = false,
  isTty = false,
  approvalPollMs = 800,
}) {
  let session = initialSession;
  let activeTurnId = null;
  let activeRunId = null;
  let streamFailed = false;
  let idleWaiters = [];
  let lastAfterSeq = session ? await getLatestEventSeq(client, session.id) : 0;

  const notifyIdleIfReady = () => {
    if (!activeTurnId && !activeRunId && idleWaiters.length) {
      const copy = idleWaiters.splice(0);
      for (const resolveIdle of copy) resolveIdle();
    }
  };

  const waitForIdle = (timeoutMs = 60_000) => {
    if ((!activeTurnId && !activeRunId) || streamFailed) return Promise.resolve();
    return new Promise((resolveIdle) => {
      const timer = setTimeout(() => {
        const idx = idleWaiters.indexOf(done);
        if (idx >= 0) idleWaiters.splice(idx, 1);
        resolveIdle();
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolveIdle();
      };
      idleWaiters.push(done);
    });
  };

  if (session) {
    const [turnsRes, msgsRes] = await Promise.all([
      client.listTurns(session.id, 5).catch(() => ({ items: [] })),
      client.listMessages(session.id, { after: 0, limit: 20 }).catch(() => ({ items: [] })),
    ]);
    const newestTurn = turnsRes?.items?.[0];
    if (newestTurn && (newestTurn.state === 'running' || newestTurn.state === 'reconciling')) {
      activeTurnId = newestTurn.id;
      lastAfterSeq = 0;
    }
    stdout.write(
      `[session] resumed ${session.id} (${session.title || 'untitled'}) [${session.workspaceRoot || workspaceRoot}]\n`,
    );
    const msgs = Array.isArray(msgsRes?.items) ? msgsRes.items : [];
    for (const m of msgs.slice(-2)) {
      if (m.role === 'user' || m.role === 'assistant') {
        stdout.write(`  ${m.role}: ${compactText(m.content || '', 120)}\n`);
      }
    }
  } else {
    stdout.write(`[Agent_US v${CLI_VERSION}] workspace=${workspaceRoot} (type /commands for help, /exit to quit)\n`);
  }

  let stream = null;
  let approvals = null;
  let renderer = null;

  const ensureAttached = async (sess) => {
    session = sess;
    if (stream) return;
    renderer = new SseRenderer({
      stdout,
      stderr,
      json,
      onApprovalRequested: (a) => approvals?.enqueue(a),
      onApprovalResolved: (a) => approvals?.markResolved(a),
    });
    approvals = new ApprovalCoordinator({
      client,
      sessionId: session.id,
      autoApprove,
      lineInput,
      promptFn,
      stdout,
      stderr,
      renderer,
      pollIntervalMs: approvalPollMs,
      includeChildren: true,
    });
    stream = client.connectStream(session.id, {
      after: lastAfterSeq,
      onEvent: (ev) => {
        renderer.render(ev);
        if (ev.type === 'turn/started') {
          activeTurnId = ev.turnId || ev.data?.turnId || activeTurnId;
        } else if (
          ev.type === 'turn/completed' ||
          ev.type === 'turn/failed' ||
          ev.type === 'turn/cancelled' ||
          ev.type === 'turn/parked'
        ) {
          activeTurnId = null;
          notifyIdleIfReady();
        } else if (ev.type === 'swarm/run_started') {
          activeRunId = ev.data?.runId || activeRunId;
        } else if (ev.type === 'swarm/run_completed') {
          activeRunId = null;
          notifyIdleIfReady();
        }
      },
      onError: () => {
        streamFailed = false;
      },
    });
    await stream.ready;
    approvals.startPolling();
  };

  if (session) {
    await ensureAttached(session);
  }

  const ensureSession = async (titleHint = 'CLI Session') => {
    if (session) return session;
    const created = await client.createSession({
      title: String(titleHint || 'CLI Session').slice(0, 120),
      workspaceRoot,
      ...(model ? { model } : {}),
      ...(permission ? { permissionMode: permission } : {}),
    });
    lastAfterSeq = 0;
    await ensureAttached(created);
    return created;
  };

  let exitedExplicitly = false;
  try {
    while (true) {
      const promptStr = isTty && !activeTurnId && !activeRunId ? 'agent-us> ' : '';
      const rawLine = await lineInput.nextLine({ prompt: promptStr });
      if (rawLine === null) break;
      const line = rawLine.trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') {
        exitedExplicitly = true;
        break;
      }

      if (line === '/commands' || line === '/help') {
        stdout.write(
          [
            '[commands]',
            '  /steer <text>             Send live steering mid-turn',
            '  /undo [files|both] [turn] Rewind changes',
            '  /redo [redoId]            Redo last rewind',
            '  /git                      Show workspace git changes',
            '  /import [--yes|--skip]    Detect & import external configs',
            '  /swarm <goal|status|stop> Launch or control Swarm',
            '  /compact                  Compact conversation context',
            '  /status                   Show session status',
            '  /cancel                   Cancel active turn or swarm run',
            '  /exit                     Exit REPL',
          ].join('\n') + '\n',
        );
        const custom = await client.getWorkspaceCustomizations(session?.id ?? null);
        if (custom) {
          const cmds = Array.isArray(custom.commands) ? custom.commands : [];
          const skills = Array.isArray(custom.skills) ? custom.skills : [];
          const agents = Array.isArray(custom.agents) ? custom.agents : [];
          if (cmds.length || skills.length || agents.length) {
            stdout.write('[workspace customizations]\n');
            for (const c of cmds) {
              stdout.write(`  /${c.name || c.id}${c.description ? ` — ${c.description}` : ''}\n`);
            }
            for (const s of skills) {
              stdout.write(`  skill:${s.name || s.id}${s.description ? ` — ${s.description}` : ''}\n`);
            }
            for (const a of agents) {
              stdout.write(`  agent:${a.name || a.id}${a.description ? ` — ${a.description}` : ''}\n`);
            }
          }
        }
        continue;
      }

      if (line.startsWith('/steer')) {
        const text = line.slice('/steer'.length).trim();
        if (!text) {
          stderr.write('[steer] Usage: /steer <text>\n');
          continue;
        }
        const s = await ensureSession(text);
        const res = await client.steerSession(s.id, text);
        if (!res?.steered && res?.turn?.id) {
          activeTurnId = res.turn.id;
        }
        stdout.write(`[steer] ${res?.steered ? `queued (${res.queued ?? 1})` : `started turn ${res?.turn?.id || ''}`}\n`);
        continue;
      }

      if (line === '/git') {
        const changes = await client.getGitChanges(session?.id ?? undefined);
        formatGitChanges(changes, stdout);
        continue;
      }

      if (line === '/status') {
        if (!session) {
          stdout.write('[status] No active session yet.\n');
          continue;
        }
        const fresh = await client.getSession(session.id);
        session = fresh;
        const pending = await client.listApprovals({ sessionId: session.id, status: 'pending' });
        stdout.write(
          `[status] session=${fresh.id} state=${fresh.state} model=${fresh.model || '?'} permission=${fresh.permissionMode || '?'} pendingApprovals=${pending?.items?.length ?? 0}\n`,
        );
        continue;
      }

      if (line === '/cancel' || line === '/stop') {
        if (activeTurnId) {
          await client.cancelTurn(activeTurnId);
          stdout.write(`[cancel] Requested cancel for turn ${activeTurnId}\n`);
        } else if (activeRunId) {
          await client.cancelSwarmRun(activeRunId);
          stdout.write(`[cancel] Requested cancel for swarm run ${activeRunId}\n`);
        } else {
          stdout.write('[cancel] Nothing active to cancel.\n');
        }
        continue;
      }

      // Mutating session commands wait for any active turn to settle first.
      if (activeTurnId || activeRunId) {
        await waitForIdle();
      }

      if (line === '/undo' || line.startsWith('/undo ')) {
        if (!session) {
          stderr.write('[undo] No active session.\n');
          continue;
        }
        const parts = line.slice('/undo'.length).trim().split(/\s+/).filter(Boolean);
        let scope = 'both';
        let turnId = undefined;
        for (const p of parts) {
          if (['files', 'code', 'both', 'conversation'].includes(p)) scope = p;
          else turnId = p;
        }
        const res = await client.rewindSession(session.id, {
          scope,
          ...(turnId ? { turnId } : {}),
        });
        const restoredCount = Array.isArray(res?.restoredFiles) ? res.restoredFiles.length : 0;
        const deletedCount = Array.isArray(res?.deletedFiles) ? res.deletedFiles.length : 0;
        stdout.write(
          `[undo] ok=${res?.ok !== false} scope=${res?.scope || scope} restored=${restoredCount} deleted=${deletedCount} removedMessages=${res?.removedMessages ?? 0}${res?.redoId ? ` redoId=${res.redoId}` : ''}\n`,
        );
        continue;
      }

      if (line === '/redo' || line.startsWith('/redo ')) {
        if (!session) {
          stderr.write('[redo] No active session.\n');
          continue;
        }
        const redoId = line.slice('/redo'.length).trim() || undefined;
        const res = await client.redoRewind(session.id, redoId ? { redoId } : {});
        stdout.write(
          `[redo] restored=${res?.restoredFiles?.length ?? 0} deleted=${res?.deletedFiles?.length ?? 0}\n`,
        );
        continue;
      }

      if (line === '/import' || line.startsWith('/import ')) {
        const subArgs = line.slice('/import'.length).trim().split(/\s+/).filter(Boolean);
        const yesFlag = autoApprove || subArgs.includes('--yes') || subArgs.includes('-y') || subArgs.includes('yes');
        const skipFlag = subArgs.includes('--skip') || subArgs.includes('skip');
        await runImportFlow({
          client,
          sessionId: session?.id ?? null,
          yes: yesFlag,
          skip: skipFlag,
          lineInput,
          promptFn,
          stdout,
          stderr,
        });
        continue;
      }

      if (line === '/compact') {
        if (!session) {
          stderr.write('[compact] No active session.\n');
          continue;
        }
        const res = await client.compactSession(session.id);
        stdout.write(`[compact] compacted=${Boolean(res?.compacted)} compressed=${res?.compressedCount ?? 0}\n`);
        continue;
      }

      const s = await ensureSession(line);
      const res = await client.startTurn(s.id, {
        input: line,
        clientTurnId: `cli-${randomUUID()}`,
        ...(model ? { model } : {}),
        ...(permission ? { permissionMode: permission } : {}),
      });
      if (res?.mode === 'swarm') {
        if (res.action === 'start' && res.runId) activeRunId = res.runId;
        if (res.message) stdout.write(`[swarm] ${res.message}\n`);
      } else if (res?.turn?.id) {
        activeTurnId = res.turn.id;
      }
    }

    if (!exitedExplicitly && (activeTurnId || activeRunId)) {
      await waitForIdle();
    }
  } finally {
    await approvals?.stop();
    stream?.close();
    renderer?.ensureNewline();
  }
  return 0;
}

/**
 * Main CLI entry point.
 */
export async function runCli(argv = [], deps = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    isTty = Boolean(stdin?.isTTY),
    backendRoot = DEFAULT_BACKEND_ROOT,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    promptFn = null,
    pollIntervalMs = 200,
    startupTimeoutMs = 15000,
    approvalPollMs = 800,
    swarmPollMs = 800,
  } = deps;

  let lineInput = null;
  try {
    const parsed = parseCliArgs(argv, { cwd });
    if (parsed.help) {
      stdout.write(`${formatHelpText()}\n`);
      return 0;
    }
    if (parsed.version) {
      stdout.write(`agent-us ${CLI_VERSION}\n`);
      return 0;
    }

    const conn = resolveConnectionConfig(parsed, { cwd, env, backendRoot });
    const ready = await ensureBackendReady({
      baseUrl: conn.baseUrl,
      dataDir: conn.dataDir,
      token: conn.token,
      backendRoot,
      autostart: parsed.autostart,
      env,
      fetchImpl,
      spawnImpl,
      pollIntervalMs,
      startupTimeoutMs,
    });

    const client = new AgentUsClient({
      baseUrl: ready.baseUrl,
      token: ready.token,
      fetchImpl,
    });

    const createLineInput = () => {
      if (!lineInput) {
        lineInput = new LineInput(stdin, { isTty, stdout });
      }
      return lineInput;
    };

    if (parsed.command === 'import') {
      const res = await runImportFlow({
        client,
        workspaceRoot: conn.cwdExplicit ? conn.workspaceRoot : null,
        yes: parsed.yes,
        skip: parsed.skip,
        lineInput: parsed.yes || parsed.skip ? null : createLineInput(),
        promptFn,
        stdout,
        stderr,
      });
      return res?.ok === false ? 1 : 0;
    }

    if (parsed.command === 'swarm') {
      const piped = await readPipedStdin(stdin, { isTty });
      const goal = formatPipedPrompt(parsed.swarmGoal, piped);
      let session = null;
      let initialAfterSeq = 0;
      if (parsed.resume) {
        session = await resolveResumeSession(client, parsed.resume, {
          workspaceRoot: conn.workspaceRoot,
          cwdExplicit: conn.cwdExplicit,
        });
        initialAfterSeq = await getLatestEventSeq(client, session.id);
      } else {
        session = await client.createSession({
          title: `[Swarm] ${parsed.swarmGoal.slice(0, 60)}`,
          workspaceRoot: conn.workspaceRoot,
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(parsed.permission ? { permissionMode: parsed.permission } : {}),
        });
      }
      return await runSwarmAndStream({
        client,
        session,
        goal,
        permission: parsed.permission,
        autoApprove: parsed.yes,
        lineInput: parsed.yes ? null : createLineInput(),
        promptFn,
        stdout,
        stderr,
        json: parsed.json,
        initialAfterSeq,
        approvalPollMs,
        swarmPollMs,
      });
    }

    if (parsed.prompt && !parsed.repl) {
      const piped = await readPipedStdin(stdin, { isTty });
      const finalPrompt = formatPipedPrompt(parsed.prompt, piped);
      let session = null;
      let initialAfterSeq = 0;
      if (parsed.resume) {
        session = await resolveResumeSession(client, parsed.resume, {
          workspaceRoot: conn.workspaceRoot,
          cwdExplicit: conn.cwdExplicit,
        });
        initialAfterSeq = await getLatestEventSeq(client, session.id);
      } else {
        session = await client.createSession({
          title: parsed.prompt.slice(0, 120),
          workspaceRoot: conn.workspaceRoot,
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(parsed.permission ? { permissionMode: parsed.permission } : {}),
        });
      }
      return await runSingleTurnAndStream({
        client,
        session,
        input: finalPrompt,
        model: parsed.model,
        permission: parsed.permission,
        autoApprove: parsed.yes,
        lineInput: parsed.yes || !isTty ? null : createLineInput(),
        promptFn,
        stdout,
        stderr,
        json: parsed.json,
        initialAfterSeq,
        approvalPollMs,
      });
    }

    let resumedSession = null;
    if (parsed.resume) {
      resumedSession = await resolveResumeSession(client, parsed.resume, {
        workspaceRoot: conn.workspaceRoot,
        cwdExplicit: conn.cwdExplicit,
      });
      if (parsed.model || parsed.permission) {
        resumedSession = await client.updateSession(resumedSession.id, {
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(parsed.permission ? { permissionMode: parsed.permission } : {}),
        });
      }
    }

    return await runInteractiveRepl({
      client,
      session: resumedSession,
      workspaceRoot: conn.workspaceRoot,
      model: parsed.model,
      permission: parsed.permission,
      autoApprove: parsed.yes,
      lineInput: createLineInput(),
      promptFn,
      stdout,
      stderr,
      json: parsed.json,
      isTty,
      approvalPollMs,
    });
  } catch (err) {
    stderr.write(`Error: ${err?.message || String(err)}\n`);
    return err instanceof CliError ? err.exitCode : 1;
  } finally {
    lineInput?.close();
  }
}
