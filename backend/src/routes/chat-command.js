import { Fault, id } from '../store.js';
import { intersectPolicies } from '../tools/policy.js';
import { parseSwarmCommand } from '../swarm/command.js';
import { isTerminalRunState } from '../swarm/node-state-machine.js';

// Per-command limits can narrow the session policy. Keep aliases (e.g. maxSteps
// and maxTotalSteps) independent so the ledger still takes their minimum.
function commandBudget(session, requested) {
  const result = { ...session.budget };
  if (requested === undefined) return result;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested))
    throw new Fault('INVALID_SWARM_BUDGET', 400);
  const limits = [
    'maxSteps',
    'maxTotalSteps',
    'maxTokens',
    'maxTotalTokens',
    'maxOutputTokens',
    'maxDurationMs',
  ];
  for (const [key, value] of Object.entries(requested)) {
    if (!limits.includes(key) || !Number.isSafeInteger(value) || value < 0)
      throw new Fault('INVALID_SWARM_BUDGET', 400);
    result[key] = result[key] == null ? value : Math.min(result[key], value);
  }
  return result;
}

function currentRun(store, orchestrator, sessionId) {
  // Older integrations may have submitted multiple runs. Prefer unfinished work.
  const row = store.db
    .prepare(
      `SELECT id FROM swarm_runs WHERE sessionId=?
    ORDER BY (status IN ('completed','failed','cancelled')), createdAt DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId);
  return row ? orchestrator.getRun(row.id) : null;
}

function response(action, run, orchestrator) {
  let message = '此会话还没有 Swarm Run。';
  if (action === 'help')
    message =
      '使用 /swarm <任务> 启动协作，/swarm status 查看进度，/swarm stop 停止当前任务。';
  else if (run)
    message = `Swarm ${run.id} · ${run.status} · ${run.nodes.length} 个节点`;
  return {
    mode: 'swarm',
    action,
    runId: run?.id ?? null,
    run,
    message,
    ledger: run
      ? (orchestrator.budgetLedger?.getSnapshot(run.id) ?? null)
      : null,
  };
}

// Parse only human chat ingress. Scheduler inputs, child objectives and tool output are data.
export function handleChatCommand(runtime, sessionId, body, traffic) {
  const command = parseSwarmCommand(body.input);
  if (!command) return null;
  const { action, task } = command;
  const session = runtime.getSession(sessionId);
  const { store, swarmOrchestrator: orchestrator } = runtime;
  if (body.files && Object.keys(body.files).length)
    throw new Fault('SWARM_ATTACHMENTS_UNSUPPORTED', 400);
  if (action === 'help') return response(action, null, orchestrator);
  if (action === 'status')
    return response(
      action,
      currentRun(store, orchestrator, sessionId),
      orchestrator,
    );
  if (session.parentSessionId)
    throw new Fault('SWARM_ROOT_SESSION_REQUIRED', 403);
  if (
    body.clientTurnId != null &&
    (typeof body.clientTurnId !== 'string' || !body.clientTurnId.trim())
  ) {
    throw new Fault('INVALID_CLIENT_TURN_ID', 400);
  }
  const clientId = body.clientTurnId ?? id();
  const input = body.input.trim();
  // The command receipt, run, initial queue job and history commit together.
  return store.tx(() => {
    const prior = store.db
      .prepare(
        'SELECT input, runId FROM swarm_command_receipts WHERE sessionId=? AND clientTurnId=?',
      )
      .get(sessionId, clientId);
    if (prior) {
      if (prior.input !== input) throw new Fault('IDEMPOTENCY_CONFLICT', 409);
      return response(action, orchestrator.getRun(prior.runId), orchestrator);
    }
    if (
      store.db
        .prepare(
          'SELECT 1 FROM direct_turns WHERE sessionId=? AND clientTurnId=?',
        )
        .get(sessionId, clientId)
    ) {
      throw new Fault('IDEMPOTENCY_CONFLICT', 409);
    }
    let run = currentRun(store, orchestrator, sessionId);
    const active = run && !isTerminalRunState(run.status);
    if (action === 'stop') {
      if (active) run = orchestrator.cancelRun(run.id);
    } else {
      const turn = store.db
        .prepare(
          "SELECT id FROM direct_turns WHERE sessionId=? AND state IN ('running','reconciling','parked') LIMIT 1",
        )
        .get(sessionId);
      if (turn || runtime.activeSessionTurn.has(sessionId))
        throw new Fault('SESSION_BUSY', 409);
      if (active)
        throw new Fault('SWARM_ALREADY_ACTIVE', 409, { runId: run.id });
      const { permissionMode } = intersectPolicies(session, {
        permissionMode: body.permissionMode ?? session.permissionMode,
      });
      ({ run } = orchestrator.submitRun({
        sessionId,
        goal: task,
        workspaceRoot: session.workspaceRoot || runtime.getWorkspaceRoot(),
        parentPermissionMode: permissionMode,
        budget: commandBudget(session, body.budget),
        maxConcurrency: 8,
        ...traffic,
      }));
    }
    const result = response(action, run, orchestrator);
    const now = Date.now();
    store.db
      .prepare(
        'INSERT INTO swarm_command_receipts(sessionId,clientTurnId,input,runId) VALUES(?,?,?,?)',
      )
      .run(sessionId, clientId, input, result.runId);
    const insert = store.db.prepare(
      'INSERT INTO direct_messages(sessionId,role,content,meta,createdAt) VALUES(?,?,?,?,?)',
    );
    const meta = JSON.stringify({ swarmAction: action, runId: result.runId });
    insert.run(sessionId, 'user', input, meta, now);
    insert.run(sessionId, 'assistant', result.message, meta, now);
    store.db
      .prepare(
        "UPDATE direct_sessions SET updatedAt=?, title=CASE WHEN title='新对话' AND ?='start' THEN ? ELSE title END WHERE id=?",
      )
      .run(now, action, task.slice(0, 120), sessionId);
    return result;
  });
}
