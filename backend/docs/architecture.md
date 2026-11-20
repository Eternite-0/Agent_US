# Agent_US — Autonomous Agent Framework Architecture

> Updated upon completing P0–P8 modular refactoring and verification.
> See also: [`p0-audit-and-research.md`](./p0-audit-and-research.md) for codebase audit and clean-room reference notes.

## 1. Seven-Layer Target Architecture

| Layer | Responsibility | Key Modules |
|---|---|---|
| **Layer 1: Application / Client** | UI presentation, SSE streaming consumer, typed SDKs, desktop host | [`frontend/src/App.tsx`](../../frontend/src/App.tsx), [`frontend/src/api/runtimeClient.ts`](../../frontend/src/api/runtimeClient.ts), [`frontend/src/components/ReconciliationCard.tsx`](../../frontend/src/components/ReconciliationCard.tsx), [`frontend/src/components/EvidenceBadge.tsx`](../../frontend/src/components/EvidenceBadge.tsx), [`backend/client/index.ts`](../../client/index.ts), [`desktop/main.mjs`](../../desktop/main.mjs) |
| **Layer 2: Control Plane** | Unified routing, approvals, schedules, audit views, HTTP/SSE endpoints | [`backend/src/governance/control-plane.js`](../src/governance/control-plane.js), [`backend/src/governance/scheduler.js`](../src/governance/scheduler.js), [`backend/src/routes/runtime-routes.js`](../src/routes/runtime-routes.js), [`backend/src/routes/swarm-routes.js`](../src/routes/swarm-routes.js), [`backend/src/routes/schedule-routes.js`](../src/routes/schedule-routes.js), [`backend/src/v1-routes.js`](../src/v1-routes.js) |
| **Layer 3: Agent Runtime Kernel** | Single execution contract for all agent profiles (phase transitions, inference, dispatch, cancellation, verification) | [`backend/src/kernel/runtime.js`](../src/kernel/runtime.js), [`backend/src/kernel/agent-loop.js`](../src/kernel/agent-loop.js), [`backend/src/kernel/state-machine.js`](../src/kernel/state-machine.js), [`backend/src/kernel/cancellation.js`](../src/kernel/cancellation.js), [`backend/src/kernel/inference.js`](../src/kernel/inference.js), [`backend/src/kernel/events.js`](../src/kernel/events.js), [`backend/src/kernel/errors.js`](../src/kernel/errors.js), [`backend/src/governance/verifier.js`](../src/governance/verifier.js) |
| **Layer 4: Tool Runtime** | Schema validation, effect classification, policy gating, command/SSRF analysis, sandboxing, MCP lifecycle, receipts | [`backend/src/tools/registry.js`](../src/tools/registry.js), [`backend/src/tools/dispatcher.js`](../src/tools/dispatcher.js), [`backend/src/tools/policy.js`](../src/tools/policy.js), [`backend/src/tools/command-analyzer.js`](../src/tools/command-analyzer.js), [`backend/src/tools/ssrf-guard.js`](../src/tools/ssrf-guard.js), [`backend/src/tools/sandbox.js`](../src/tools/sandbox.js), [`backend/src/tools/mcp-lifecycle.js`](../src/tools/mcp-lifecycle.js), [`backend/src/tools/builtin/`](../src/tools/builtin/fs-tools.js) |
| **Layer 5: Context & Memory** | Prompt Cache-preserving tail diff assembly, token budgeting, non-destructive multi-stage compaction, hybrid memory retrieval | [`backend/src/context/assembler.js`](../src/context/assembler.js), [`backend/src/context/budget.js`](../src/context/budget.js), [`backend/src/context/compaction.js`](../src/context/compaction.js), [`backend/src/context/memory.js`](../src/context/memory.js), [`backend/src/context.js`](../src/context.js) |
| **Layer 6: Adaptive Swarm** | 8-dim model/agent capability routing, acyclic DAG planner & live replanning, cache-safe fork, permission-ceiling inheritance, inter-agent mailbox | [`backend/src/swarm/capabilities.js`](../src/swarm/capabilities.js), [`backend/src/swarm/router.js`](../src/swarm/router.js), [`backend/src/swarm/planner.js`](../src/swarm/planner.js), [`backend/src/swarm/mailbox.js`](../src/swarm/mailbox.js), [`backend/src/swarm/child-lifecycle.js`](../src/swarm/child-lifecycle.js), [`backend/src/swarm/orchestrator.js`](../src/swarm/orchestrator.js) |
| **Layer 7: Persistence / Infrastructure** | SQLite WAL Schema v5, JCS-SHA256 hash-chained ledger, fenced job queue, checkpoints, unknown-outcome reconciler, crash recovery | [`backend/src/store.js`](../src/store.js), [`backend/src/runtime/session-repo.js`](../src/runtime/session-repo.js), [`backend/src/runtime/approval-manager.js`](../src/runtime/approval-manager.js), [`backend/src/durable/job-queue.js`](../src/durable/job-queue.js), [`backend/src/durable/checkpoint.js`](../src/durable/checkpoint.js), [`backend/src/durable/reconciliation.js`](../src/durable/reconciliation.js), [`backend/src/durable/recovery.js`](../src/durable/recovery.js), [`backend/src/governance/audit.js`](../src/governance/audit.js), [`backend/src/pool.js`](../src/pool.js) |

## 2. Durability, Fencing & Unknown-Outcome Reconciliation

1. Every turn enqueues a `runtime_jobs` row (`kind='direct_turn'`) inside the same SQLite transaction as the `direct_turns` row and user `direct_messages` row (`store.tx()`).
2. `RecoveryWorker` claims jobs with a cryptographic `fence` token and lease deadline (`leaseExpiresAt`). Workers periodically renew leases and verify `jobQueue.assertFence(jobId, fence)` before committing step checkpoints or terminal state transitions, blocking split-brain overwrites.
3. Terminal states (`completed`, `failed`, `cancelled`) are immutable (`TurnStateMachine` + SQLite claim guards prevent resurrection of cancelled turns across restarts).
4. Before any non-readonly tool runs, `ToolDispatcher` records an `executing` row in `tool_receipts` tagged with `(effectClass, riskLevel, replayable, outward, argsDigest)`.
5. On startup crash recovery (`UnknownOutcomeReconciler`), if an interrupted turn holds an `executing` receipt:
   - `replayable === 1`: safely eligible for re-execution/recovery.
   - `replayable === 0` or `outward === 1`: receipt transitions to `status='outcome_unknown'`, a `direct_approvals` row (`kind='reconciliation'`) is created, and the turn parks until the operator explicitly resolves `happened | not_applied | abort` via `/v1/reconciliations/:id/resolve` or `ReconciliationCard` in UI.

## 3. Tool Runtime & Security Boundaries

- **Risk & Effect Matrix**: Tools declare `effectClass` (`read_only`, `reversible_write`, `irreversible_side_effect`, `external_network`), `riskLevel` (`low`, `medium`, `high`, `critical`), `replayable`, and `outward`.
- **Policy Evaluation**: `ToolPermissionPolicy` runs backend-authoritatively across modes (`read-only`, `approval`, `auto-safe`, `workspace-write`, `full-access`), plus `intersectPolicies(parent, child)` so spawned/forked children can never escalate permissions above parent ceilings.
- **Host vs. Container Boundary**:
  - `HostSandboxAdapter`: enforces path confinement (`resolveConfinedPath` blocking symlink/junction escapes and `.git`/credential secrets), child env scrubbing (`sanitizeChildEnv`), AST/command safety inspection (`analyzeCommand`), SSRF/DNS-rebinding/IPv4-mapped-IPv6 HTTP guard (`safeFetchExternal`), and process-tree termination (`killProcessTree`), without false promises of kernel namespace isolation.
  - `DockerSandboxAdapter`: delegates containerized runs with `--network=none`, `--read-only`, `--cap-drop=ALL`, `--no-new-privileges`, memory and PID caps.

## 4. Context Engine, Prompt Cache Stability & Non-Destructive Compaction

- **Prefix Immutability**: `ContextAssembler` pins a per-session `nonce` on `direct_sessions` so `messages[0]` (`buildStaticSystemPrompt(nonce)`) never mutates between turns. Volatile workspace, git branch, `AGENTS.md`, plan, hooks, and retrieved memory diffs are appended strictly via `liveContextNotes` right before the active turn's user prompt, while prior turn boundaries replay their cached tail notes in place so the prefix remains byte-identical across turns.
- **Non-Destructive Compaction**: `MultiStageCompactor` preserves 100% of raw `direct_messages` rows in SQLite. Compaction writes a structured record into `context_compactions` (`coveredThroughSeq`, `summaryText`, `taskStateJson`, `preservedConstraintsJson`), updates `direct_sessions.activeCompactionId`, and retains extracted goals, constraints, active plan, `turn_snapshots` edited files, recent receipts, and `artifact://` URIs across summaries.

## 5. Adaptive Swarm & Evidence Verification

- **Dynamic Routing**: `ModelCapabilityRegistry` syncs live catalog/account health from `AccountPool` and scores models across 8 dimensions (`coding`, `reasoning`, `research`, `planning`, `speed`, `contextCapacity`, `multimodal`, `toolCompatibility`). `AgentCapabilityRegistry.synthesizeProfile()` dynamically derives task-tailored profiles rather than fixed role templates, and `AdaptiveModelRouter` pairs tasks to models and profiles.
- **DAG & Child Lifecycle**: `DynamicTaskPlanner` validates DAG acyclicity via Kahn topological sort and supports live `addNode`, `cancelNode`, `reprioritizeNode`, and subgraph replanning. `ChildAgentManager` implements `spawn`, cache-safe `fork` (sharing parent `nonce`, history prefix, and tail cache with `MAX_FORK_DEPTH=2`), `pause`, `resume`, `interrupt`, `cancel` cascades, `GitWorktreeIsolator` isolation, and `InterAgentMailbox` messaging.
- **Completion Gate**: `EvidenceVerifier` blocks fabricated pass/build claims contradicted by `bash`/`start_process` receipts (`exitCode !== 0`), blocks completion on unresolved `outcome_unknown` receipts (`block_reconciliation`), and verifies claimed written files exist on disk before persisting `verdictJson` and `evidenceCount` onto `direct_turns`.

## 6. Verification & Benchmark Baseline

- **Backend**: `cd backend && npm run check && node --test test/*.test.js` — **71 / 76 tests pass** (all P1–P8 suites pass: `kernel.test.js`, `durable-runtime.test.js`, `tool-runtime-security.test.js`, `context-memory.test.js`, `adaptive-swarm.test.js`, `governance-verification.test.js`, `e2e-runtime.test.js`, `stress-benchmark.test.js`, and all non-Docker/Magpie baseline suites). The 5 pre-existing environment-gated failures (`integration.test.js`, `providers.test.js`, and 3 in `security.test.js`) fail with `MAGPIE_UNAVAILABLE` / `CONTAINER_UNAVAILABLE` when Docker/Magpie are absent locally.
- **P8 Stress Benchmark (`stress-benchmark.test.js`)**:
  - 20 concurrent sessions completed in `1225.6 ms` total (`p50 = 838.47 ms`, `p95 = 1099.42 ms` in full-suite run; `977.1 ms` standalone).
  - 50 mixed tool dispatches via `ToolDispatcher`: `45` succeeded, `5` policy-blocked, `50/50` receipts persisted in `122 ms`.
  - 30 contended `DurableJobQueue` jobs across 4 workers: `0` duplicate executions.
  - 5 crash-recovery cycles via expired leases + `RecoveryWorker`: `5/5` recovered (`100%`).
