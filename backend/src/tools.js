import { createHash } from 'node:crypto';
import { posix as posixPath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Fault, id } from './store.js';
import { docker } from './docker.js';
import {
  ExecutePermitRegistry,
  RejectedBeforeEffectError,
  dispatchWithPermit,
} from './permits.js';

const path = z
  .string()
  .min(1)
  .max(160)
  .regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/);
export const filemap = z.record(path, z.base64().max(88000));
const result = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.string().max(16384),
  stderr: z.string().max(16384),
  files: filemap,
});
const args = z.array(z.string().max(16000)).min(1).max(64);
const definitions = {
  shell: z.strictObject({ argv: args }),
  pty: z.strictObject({ argv: args }),
  git: z.strictObject({ args }),
  read_file: z.strictObject({ path }),
  write_file: z.strictObject({ path, text: z.string().max(16000) }),
  mcp: z.strictObject({
    server: z.string().max(64),
    name: z.string().max(128),
    argumentsJson: z.string().max(4096),
  }),
};

export const TOOL_META = Object.freeze({
  read_file: Object.freeze({
    readOnly: true,
    destructive: false,
    replayable: true,
    outward: false,
  }),
  read_blob: Object.freeze({
    readOnly: true,
    destructive: false,
    replayable: true,
    outward: false,
  }),
  write_file: Object.freeze({
    readOnly: false,
    destructive: false,
    replayable: true,
    outward: false,
  }),
  shell: Object.freeze({
    readOnly: false,
    destructive: true,
    replayable: false,
    outward: false,
  }),
  pty: Object.freeze({
    readOnly: false,
    destructive: true,
    replayable: false,
    outward: false,
  }),
  git: Object.freeze({
    readOnly: false,
    destructive: true,
    replayable: false,
    outward: false,
  }),
  mcp: Object.freeze({
    readOnly: false,
    destructive: true,
    replayable: false,
    outward: true,
  }),
});

export function isReplayableTool(name) {
  return TOOL_META[name]?.replayable ?? false;
}

const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'timeout',
  'nice',
  'time',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}/;
const BLOCK_DEV_REDIRECT_RE =
  />\s*\/dev\/(?:sd|nvme|disk|rdisk|hd|mmcblk)[a-z0-9]*/i;
const DD_BLOCK_DEV_RE =
  /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|disk|rdisk|hd|mmcblk)[a-z0-9]*/i;
const MKFS_DEV_RE = /\bmkfs(?:\.[a-z0-9_-]+)?\b[^\n]*\/dev\//i;
const DISK_ERASE_RE =
  /\b(?:diskutil\s+(?:eraseDisk|zeroDisk|secureErase)|format\s+c:)\b/i;

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripSurroundingQuotes(token) {
  let s = String(token ?? '').trim();
  while (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1);
  }
  return s;
}

function isDangerousRmTarget(rawToken) {
  const t = stripSurroundingQuotes(rawToken).trim();
  if (!t) return false;
  if (
    t === '/' ||
    t === '/*' ||
    t === '~' ||
    t === '~/' ||
    t === '~/*' ||
    t === '$HOME' ||
    t === '${HOME}' ||
    t === '$HOME/' ||
    t === '${HOME}/' ||
    t === '$HOME/*' ||
    t === '${HOME}/*' ||
    /^[a-z]:[\\/]*\*?$/i.test(t)
  ) {
    return true;
  }
  // Normalize POSIX paths like `//`, `/./`, `/etc/..`, `//*`
  if (t.startsWith('/')) {
    const clean = t.replace(/\/+\*$/, '');
    const norm = posixPath.normalize(clean || '/');
    if (norm === '/' || norm === '/*') return true;
  }
  if (/^(?:\$HOME|\$\{HOME\}|~)(?:\/\.?)*\/?\*?$/.test(t)) {
    return true;
  }
  return false;
}

function checkShellText(cmdText, depth = 0) {
  if (depth > 3) return null;
  const text = String(cmdText ?? '');
  if (FORK_BOMB_RE.test(text)) return 'fork-bomb';
  if (BLOCK_DEV_REDIRECT_RE.test(text) || DD_BLOCK_DEV_RE.test(text) || MKFS_DEV_RE.test(text))
    return 'block-device-write';
  if (DISK_ERASE_RE.test(text)) return 'disk-erase';
  const segments = text.split(/&&|\|\||;|\||\r?\n/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const hit = checkTokenized(tokens, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function checkTokenized(argv, depth = 0) {
  if (depth > 3 || !argv.length) return null;
  let i = 0;
  while (i < argv.length) {
    const rawTok = stripSurroundingQuotes(argv[i]);
    if (ENV_ASSIGN_RE.test(rawTok)) {
      i++;
      continue;
    }
    const base = rawTok.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    if (WRAPPERS.has(base)) {
      i++;
      while (i < argv.length) {
        const nextTok = stripSurroundingQuotes(argv[i]);
        if (nextTok === '--') {
          i++;
          break;
        }
        if (base === 'env' && (nextTok === '-u' || nextTok === '--unset')) {
          i += 2;
          continue;
        }
        if (nextTok.startsWith('-')) {
          i++;
          continue;
        }
        if (base === 'env' && ENV_ASSIGN_RE.test(nextTok)) {
          i++;
          continue;
        }
        if (base === 'timeout' && /^\d/.test(nextTok)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  if (i >= argv.length) return null;
  const cmd = stripSurroundingQuotes(argv[i]).split(/[\\/]/).pop().replace(/\.exe$/i, '');
  const rest = argv.slice(i + 1);
  if (SHELLS.has(cmd.toLowerCase())) {
    const cIdx = rest.findIndex((a) => {
      const s = stripSurroundingQuotes(a);
      return s === '-c' || /^-[a-z]*c[a-z]*$/.test(s);
    });
    if (cIdx >= 0 && rest[cIdx + 1]) {
      return checkShellText(stripSurroundingQuotes(rest[cIdx + 1]), depth + 1);
    }
  }
  if (cmd.toLowerCase() === 'rm') {
    const cleanRest = rest.map(stripSurroundingQuotes);
    const recursive = cleanRest.some(
      (a) => a === '--recursive' || (a.startsWith('-') && !a.startsWith('--') && /[rR]/.test(a)),
    );
    const noPreserve = cleanRest.includes('--no-preserve-root');
    if (noPreserve) return 'rm-root-or-home';
    if (recursive) {
      const targets = cleanRest.filter((a) => a !== '--' && !a.startsWith('-'));
      if (targets.some((t) => isDangerousRmTarget(t))) {
        return 'rm-root-or-home';
      }
    }
  }
  if (cmd.toLowerCase().startsWith('mkfs') && rest.some((a) => stripSurroundingQuotes(a).startsWith('/dev/'))) {
    return 'block-device-write';
  }
  if (
    cmd.toLowerCase() === 'dd' &&
    rest.some((a) => /^of=\/dev\/(?:sd|nvme|disk|rdisk|hd|mmcblk)/i.test(stripSurroundingQuotes(a)))
  ) {
    return 'block-device-write';
  }
  if (
    (cmd.toLowerCase() === 'diskutil' &&
      rest.some((a) => /^(?:eraseDisk|zeroDisk|secureErase)$/i.test(stripSurroundingQuotes(a)))) ||
    (cmd.toLowerCase() === 'format' && rest.some((a) => /^c:$/i.test(stripSurroundingQuotes(a))))
  ) {
    return 'disk-erase';
  }
  const joined = [cmd, ...rest].join(' ');
  if (FORK_BOMB_RE.test(joined)) return 'fork-bomb';
  if (BLOCK_DEV_REDIRECT_RE.test(joined)) return 'block-device-write';
  return null;
}

export function checkHardBlockedCommand(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  return checkTokenized(argv, 0);
}

const hash = (v) => createHash('sha256').update(v).digest('hex');

export { dispatchWithPermit };

export async function sandbox(
  argv,
  files,
  { signal, image = 'agent-us/worker:1', tty = false } = {},
) {
  const name = 'agent-work-' + id();
  const timeout = AbortSignal.timeout(25000);
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const raw = await docker(
      [
        'run',
        '--rm',
        '--pull=never',
        '-i',
        '--name',
        name,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=64',
        '--memory=256m',
        '--memory-swap=256m',
        '--cpus=1',
        '--user=65534:65534',
        '--tmpfs',
        '/work:rw,nosuid,nodev,size=8m,uid=65534,gid=65534',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=24m,mode=1777',
        image,
      ],
      { signal, input: JSON.stringify({ argv, files, tty }) },
    );
    return result.parse(JSON.parse(raw));
  } finally {
    if (signal.aborted)
      await docker(['rm', '-f', name], {
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
  }
}

export function reconcile(
  db,
  approvalId,
  { version, outcome, note = undefined },
) {
  return db.tx(() => {
    const record = db.get('approvals', approvalId);
    if (
      record.kind !== 'reconciliation' ||
      record.version !== version ||
      record.status !== 'pending' ||
      record.expires < Date.now()
    ) {
      throw new Fault('APPROVAL_INACTIVE');
    }
    const task = db.get('tasks', record.taskId);
    if (!['running', 'planning', 'reviewing'].includes(task.status)) {
      throw new Fault('LEASE_LOST');
    }
    const job = db.db
      .prepare("SELECT * FROM jobs WHERE id=? AND status='reconciling'")
      .get(record.jobId);
    if (!job) throw new Fault('LEASE_LOST');

    const ev = record.evidenceId ? db.get('evidence', record.evidenceId) : null;
    const node = record.assignmentId
      ? db.get('assignments', record.assignmentId)
      : null;

    if (outcome === 'abort') {
      if (ev)
        db.update('evidence', ev, {
          status: 'reconciled_aborted',
          ...(note ? { reconciliationNote: note } : {}),
        });
      const updated = db.update('approvals', record, {
        status: 'deny',
        outcome,
        ...(note ? { reason: note } : {}),
      });
      db.db
        .prepare("UPDATE jobs SET status='failed', fence=NULL WHERE id=?")
        .run(job.id);
      if (node) db.update('assignments', node, { status: 'failed' });
      db.update('tasks', task, {
        status: 'failed',
        code: 'RECONCILIATION_ABORTED',
      });
      return updated;
    }

    const evStatus =
      outcome === 'succeeded'
        ? 'reconciled_succeeded'
        : 'reconciled_not_applied';
    if (ev) {
      db.update('evidence', ev, {
        status: evStatus,
        ...(note ? { reconciliationNote: note } : {}),
      });
    }
    const updated = db.update('approvals', record, {
      status: 'consumed',
      outcome,
      ...(note ? { reason: note } : {}),
    });
    const payload = JSON.parse(job.payload);
    const reconciledList = Array.isArray(payload.reconciled)
      ? payload.reconciled
      : [];
    reconciledList.push({
      evidenceId: record.evidenceId,
      tool: record.tool,
      outcome,
      ...(note ? { note } : {}),
    });
    db.db
      .prepare(
        "UPDATE jobs SET status='pending', fence=NULL, attempts=MAX(0,attempts-1), payload=? WHERE id=?",
      )
      .run(JSON.stringify({ ...payload, reconciled: reconciledList }), job.id);
    if (node) db.update('assignments', node, { status: 'queued' });
    return updated;
  });
}

export function decide(
  db,
  approvalId,
  { version, decision, outcome = undefined, reason = undefined },
) {
  return db.tx(() => {
    const record = db.get('approvals', approvalId);
    if (record.kind === 'reconciliation') {
      const mapped =
        outcome ?? (decision === 'approve' ? 'not_applied' : 'abort');
      return reconcile(db, approvalId, {
        version,
        outcome: mapped,
        note: reason,
      });
    }
    if (
      record.version !== version ||
      record.status !== 'pending' ||
      record.expires < Date.now()
    )
      throw new Fault('APPROVAL_INACTIVE');
    const task = db.get('tasks', record.taskId);
    if (task.status !== 'running') throw new Fault('LEASE_LOST');

    const activeMatch = db.db
      .prepare(
        "SELECT 1 FROM jobs WHERE id=? AND fence=? AND status='active' AND expires>=?",
      )
      .get(record.jobId, record.fence, Date.now());
    const parkedJob =
      !activeMatch && record.parked
        ? db.db
            .prepare("SELECT * FROM jobs WHERE id=? AND status='parked'")
            .get(record.jobId)
        : null;
    if (!activeMatch && !parkedJob) throw new Fault('LEASE_LOST');

    const updated = db.update('approvals', record, {
      status: decision,
      ...(reason ? { reason } : {}),
    });

    if (parkedJob) {
      const payload = JSON.parse(parkedJob.payload);
      const nextPayload = { ...payload };
      if (decision === 'deny') {
        const denied = Array.isArray(nextPayload.deniedApprovals)
          ? nextPayload.deniedApprovals
          : [];
        denied.push({
          approvalId: record.id,
          tool: record.tool,
          ...(reason ? { reason } : {}),
        });
        nextPayload.deniedApprovals = denied;
      } else {
        nextPayload.resumedApprovalId = record.id;
      }
      db.db
        .prepare(
          "UPDATE jobs SET status='pending', fence=NULL, payload=? WHERE id=? AND status='parked'",
        )
        .run(JSON.stringify(nextPayload), parkedJob.id);
      if (record.assignmentId) {
        const node = db.get('assignments', record.assignmentId);
        if (node.status === 'awaiting_approval') {
          db.update('assignments', node, { status: 'queued' });
        }
      }
    }
    return updated;
  });
}

const ARG_FALLBACK =
  'Disabled for the rest of this turn after repeated invalid arguments. Do not call this tool again. Continue with other available tools or answer in text/markdown.';

export function toolset(
  execution,
  {
    image,
    mcp = {},
    runner = sandbox,
    parkAfterMs = execution.approvalParkMs ?? Infinity,
    approvalMode = execution.approvalMode ?? execution.task.approvalMode ?? 'manual',
    formatOutput = null,
    includeReadBlob = false,
  } = {},
) {
  const { store, task, worker, node, job, signal, guard } = execution;
  const permits = execution.permits ?? new ExecutePermitRegistry();
  execution.permits = permits;
  const argRecovery = new Map();
  execution.argRecovery = argRecovery;
  execution.evidenceCount = execution.evidenceCount ?? 0;
  execution.toolDurationMs = execution.toolDurationMs ?? 0;

  let files = Object.assign(Object.create(null), task.files ?? {});
  const inherited = store
    .list('artifacts', { taskId: task.id, limit: 500 })
    .filter((a) => a.published && node.dependencies.includes(a.key));
  for (const a of inherited)
    for (const [p, v] of Object.entries(a.files ?? {}))
      files[`inputs/${a.key}/${p}`] = v;
  const writable = node.role === 'Coder' || node.role === 'Tester';
  execution.files = files;

  const activeDefs = { ...definitions };
  if (includeReadBlob) {
    activeDefs.read_blob = z.strictObject({
      uri: z.string().regex(/^artifact:\/\/[0-9a-f]{64}$/),
      offset: z.number().int().min(0).max(2_000_000).optional(),
      limit: z.number().int().min(1).max(16384).optional(),
    });
  }

  return Object.entries(activeDefs)
    .filter(([name]) => writable || TOOL_META[name]?.readOnly)
    .map(([name, schema]) => ({
      name,
      meta: TOOL_META[name],
      isConcurrencySafe: () => !!TOOL_META[name]?.readOnly,
      description: `${name} in the isolated assignment workspace`,
      parameters: z.toJSONSchema(schema),
      output: {
        schema: { type: 'string' },
        render: (_, v) => [{ type: 'text', text: v }],
      },
      async execute(raw, exec) {
        guard();
        const combined = AbortSignal.any([signal, exec.signal]);
        combined.throwIfAborted();

        const prevArgState = argRecovery.get(name);
        if (prevArgState?.disabled) {
          store.add(
            'evidence',
            {
              status: 'rejected_before_effect',
              effect: 'none',
              code: 'TOOL_DISABLED_FOR_TURN',
              tool: name,
              workerId: worker.id,
              assignmentId: node.id,
            },
            task.projectId,
            task.id,
          );
          return ARG_FALLBACK;
        }

        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          const failures = (prevArgState?.failures ?? 0) + 1;
          const disabled = failures >= 2;
          const issues = parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
          argRecovery.set(name, { failures, disabled, lastIssues: issues });
          store.add(
            'evidence',
            {
              status: 'rejected_before_effect',
              effect: 'none',
              code: 'INVALID_ARGUMENTS',
              tool: name,
              workerId: worker.id,
              assignmentId: node.id,
              issues,
            },
            task.projectId,
            task.id,
          );
          const hint = `Invalid arguments for ${name}: ${issues.join('; ')}.`;
          return disabled
            ? `${hint}\n${ARG_FALLBACK}`
            : `${hint} ${2 - failures} corrective attempt(s) remaining. Retry with valid arguments matching the schema.`;
        }
        if (prevArgState?.failures) {
          argRecovery.set(name, { failures: 0, disabled: false });
        }
        const action = parsed.data;
        const meta = TOOL_META[name];

        if (name === 'read_blob') {
          const started = Date.now();
          const blob = store.getBlob(action.uri);
          const offset = action.offset ?? 0;
          const limit = action.limit ?? 8192;
          const slice = blob.content.slice(offset, offset + limit);
          execution.toolDurationMs += Date.now() - started;
          execution.tainted = true;
          execution.evidenceCount++;
          const text = JSON.stringify({
            uri: action.uri,
            totalChars: blob.content.length,
            offset,
            returnedChars: slice.length,
            hasMore: offset + slice.length < blob.content.length,
            content: slice,
          });
          return formatOutput ? formatOutput(name, text, store) : text;
        }

        if (name === 'read_file') {
          const started = Date.now();
          if (!Object.hasOwn(files, action.path)) {
            throw new RejectedBeforeEffectError('FILE_NOT_FOUND', {
              message: `FILE_NOT_FOUND: ${action.path}`,
            });
          }
          store.add(
            'evidence',
            {
              status: 'finished',
              tool: name,
              workerId: worker.id,
              assignmentId: node.id,
              path: action.path,
              digest: hash(files[action.path]),
            },
            task.projectId,
            task.id,
          );
          execution.toolDurationMs += Date.now() - started;
          execution.tainted = true;
          execution.evidenceCount++;
          const text = Buffer.from(files[action.path], 'base64')
            .toString('utf8')
            .slice(0, 16384);
          return formatOutput ? formatOutput(name, text, store) : text;
        }

        let argv = action.argv;
        if (name === 'git') argv = ['git', ...action.args];
        if (name === 'write_file')
          argv = [
            'python',
            '-c',
            'import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(sys.argv[2])',
            action.path,
            action.text,
          ];
        if (name === 'mcp') {
          if (!Object.hasOwn(mcp, action.server)) {
            throw new RejectedBeforeEffectError('UNKNOWN_MCP_SERVER', {
              message: `UNKNOWN_MCP_SERVER: ${action.server}`,
            });
          }
          try {
            JSON.parse(action.argumentsJson);
          } catch {
            throw new RejectedBeforeEffectError('INVALID_MCP_ARGUMENTS', {
              message: 'INVALID_MCP_ARGUMENTS: argumentsJson must be valid JSON',
            });
          }
          argv = [
            'python',
            '-I',
            '/opt/mcp.py',
            JSON.stringify(mcp[action.server]),
            action.name,
            action.argumentsJson,
          ];
        }

        if (name === 'shell' || name === 'pty') {
          const blockedRule = checkHardBlockedCommand(argv);
          if (blockedRule) {
            store.add(
              'evidence',
              {
                status: 'rejected_before_effect',
                effect: 'none',
                code: 'POLICY_HARD_BLOCKED',
                rule: blockedRule,
                tool: name,
                workerId: worker.id,
                assignmentId: node.id,
              },
              task.projectId,
              task.id,
            );
            throw new RejectedBeforeEffectError('POLICY_HARD_BLOCKED', {
              message: `POLICY_HARD_BLOCKED: blocked by rule ${blockedRule}`,
              hint: `Command matched hard-blocked safety rule "${blockedRule}" and was rejected before execution.`,
            });
          }
        }

        const digest = hash(
          JSON.stringify([worker.id, exec.callId, name, action, files]),
        );
        const actionDigest = hash(
          JSON.stringify([node.id, name, action, files]),
        );

        let evidence;
        let permit;
        let consumedApprovalId;

        // Check for a pre-approved parked approval bound to this exact assignment + action + files.
        const preApproved = store
          .list('approvals', { taskId: task.id, limit: 500 })
          .find(
            (a) =>
              a.assignmentId === node.id &&
              a.parked === true &&
              a.status === 'approve' &&
              a.actionDigest === actionDigest &&
              a.expires >= Date.now(),
          );

        if (preApproved) {
          ({ evidence, permit } = store.tx(() => {
            guard();
            const fresh = store.get('approvals', preApproved.id);
            if (fresh.status !== 'approve' || fresh.expires < Date.now()) {
              throw new Fault('APPROVAL_INACTIVE');
            }
            store.update('approvals', fresh, { status: 'consumed' });
            const ev = store.add(
              'evidence',
              {
                status: 'executing',
                tool: name,
                replayable: meta.replayable,
                outward: meta.outward,
                workerId: worker.id,
                assignmentId: node.id,
                approvalId: fresh.id,
                digest,
              },
              task.projectId,
              task.id,
            );
            const p = permits.issue({
              owner: execution,
              effectId: ev.id,
              approvalId: fresh.id,
              evidenceId: ev.id,
              callId: exec.callId,
              attempt: 1,
            });
            return { evidence: ev, permit: p };
          }));
          consumedApprovalId = preApproved.id;
        } else {
          // Optional workspace-write or auto-review bypass (NEVER for outward tools or tainted context).
          let autoApproved = null;
          let reviewAudit = null;
          if (!meta.outward) {
            if (approvalMode === 'workspace-write' && name === 'write_file') {
              autoApproved = {
                autoDecision: 'workspace-write',
                risk: 'low',
                reason: 'In-sandbox workspace write pre-approved by policy',
              };
            } else if (
              approvalMode === 'auto-review' &&
              typeof execution.autoReview === 'function'
            ) {
              const verdict = await execution.autoReview({
                tool: name,
                meta,
                action,
                tainted: !!execution.tainted,
                signal: combined,
              });
              reviewAudit = verdict;
              if (
                verdict?.allow === true &&
                verdict?.risk === 'low' &&
                !execution.tainted
              ) {
                autoApproved = {
                  autoDecision: 'auto-review',
                  risk: verdict.risk,
                  reason: verdict.reason,
                  reviewAudit: verdict,
                };
              }
            }
          }

          if (autoApproved) {
            ({ evidence, permit, consumedApprovalId } = store.tx(() => {
              guard();
              const a = store.add(
                'approvals',
                {
                  status: 'consumed',
                  policy: 1,
                  fence: job.fence,
                  jobId: job.id,
                  workerId: worker.id,
                  assignmentId: node.id,
                  callId: exec.callId,
                  tool: name,
                  action,
                  digest,
                  actionDigest,
                  expires: Date.now() + 120000,
                  ...autoApproved,
                },
                task.projectId,
                task.id,
              );
              const ev = store.add(
                'evidence',
                {
                  status: 'executing',
                  tool: name,
                  replayable: meta.replayable,
                  outward: meta.outward,
                  workerId: worker.id,
                  assignmentId: node.id,
                  approvalId: a.id,
                  digest,
                },
                task.projectId,
                task.id,
              );
              const p = permits.issue({
                owner: execution,
                effectId: ev.id,
                approvalId: a.id,
                evidenceId: ev.id,
                callId: exec.callId,
                attempt: 1,
              });
              return { evidence: ev, permit: p, consumedApprovalId: a.id };
            }));
          } else {
            const waitStarted = Date.now();
            const approval = store.add(
              'approvals',
              {
                status: 'pending',
                policy: 1,
                ...(meta.outward ? { checkpoint: 'outward' } : {}),
                ...(reviewAudit ? { reviewAudit } : {}),
                fence: job.fence,
                jobId: job.id,
                workerId: worker.id,
                assignmentId: node.id,
                callId: exec.callId,
                tool: name,
                action,
                digest,
                actionDigest,
                expires: Date.now() + 120000,
              },
              task.projectId,
              task.id,
            );
            for (;;) {
              guard();
              combined.throwIfAborted();
              const a = store.get('approvals', approval.id);
              if (a.status === 'approve' && a.expires >= Date.now()) {
                ({ evidence, permit } = store.tx(() => {
                  guard();
                  store.update('approvals', a, { status: 'consumed' });
                  const ev = store.add(
                    'evidence',
                    {
                      status: 'executing',
                      tool: name,
                      replayable: meta.replayable,
                      outward: meta.outward,
                      workerId: worker.id,
                      assignmentId: node.id,
                      approvalId: a.id,
                      digest,
                    },
                    task.projectId,
                    task.id,
                  );
                  const p = permits.issue({
                    owner: execution,
                    effectId: ev.id,
                    approvalId: a.id,
                    evidenceId: ev.id,
                    callId: exec.callId,
                    attempt: 1,
                  });
                  return { evidence: ev, permit: p };
                }));
                consumedApprovalId = a.id;
                break;
              }
              if (
                a.expires < Date.now() &&
                ['approve', 'pending'].includes(a.status)
              )
                store.update('approvals', a, { status: 'expired' });
              if (a.status !== 'pending' || a.expires < Date.now())
                throw new Fault('APPROVAL_DENIED');
              if (
                Number.isFinite(parkAfterMs) &&
                Date.now() - waitStarted >= parkAfterMs
              ) {
                store.tx(() => {
                  guard();
                  const latest = store.get('approvals', approval.id);
                  if (latest.status === 'pending') {
                    store.update('approvals', latest, {
                      parked: true,
                      expires: Date.now() + 1_800_000,
                    });
                  }
                });
                execution.parkedApprovalId = approval.id;
                execution.onPark?.(approval.id);
                throw new Fault('APPROVAL_PARKED', 202, {
                  approvalId: approval.id,
                });
              }
              await delay(100, undefined, { signal: combined });
            }
          }
        }

        const execStarted = Date.now();
        try {
          const outcome = await dispatchWithPermit(
            permit,
            {
              owner: execution,
              effectId: evidence.id,
              approvalId: consumedApprovalId,
              evidenceId: evidence.id,
              callId: exec.callId,
              attempt: 1,
            },
            permits,
            () =>
              runner(argv, files, {
                signal: combined,
                image,
                tty: name === 'pty',
              }),
          );
          guard();
          const changes = [];
          for (const p of new Set([
            ...Object.keys(files),
            ...Object.keys(outcome.files),
          ])) {
            if (files[p] !== outcome.files[p])
              changes.push({
                path: p,
                before: files[p] ?? null,
                after: outcome.files[p] ?? null,
              });
          }
          const { files: next, ...summary } = outcome;
          store.update('evidence', evidence, {
            status: 'finished',
            ...summary,
            changes,
          });
          files = next;
          execution.files = next;
          execution.evidenceCount++;
          execution.toolDurationMs += Date.now() - execStarted;
          if (name !== 'write_file') execution.tainted = true;
          const serialized = JSON.stringify(summary);
          return formatOutput
            ? formatOutput(name, serialized, store)
            : serialized;
        } catch (e) {
          execution.toolDurationMs += Date.now() - execStarted;
          store.update('evidence', evidence, { status: 'failed' });
          throw e;
        }
      },
    }));
}
