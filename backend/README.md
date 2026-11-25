# Agent_US Backend

Agent_US 后端是 Node.js 24 + Fastify 5 + SQLite WAL 的本地优先运行时。`service.js` 组装 `DirectAgentRuntime`、`ControlPlane`、`AccountPool`、`EvaluationService`、`ExperienceMemoryService`、`CommunicationBus` 和兼容协议服务。

## 快速启动

```powershell
Set-Location D:\Agent_US\backend
npm ci
$env:BACKEND_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

默认监听 `127.0.0.1:8787`。数据目录默认为 `backend/var`，可通过 `BACKEND_DATA` 覆盖。工作区目录可通过 `AGENT_WORKSPACE` 或 `PUT /v1/workspace` 设置。

## 主 API 面

新的功能和客户端集成使用 `/v1/*`。`v1-routes.js` 注册基础会话、工作区、账号、模型、认证、记忆、Git、网关和 SSE 端点，其他运行时能力由 `routes/` 下的模块注册。

| 能力 | 关键端点 | 真实入口 |
| --- | --- | --- |
| 健康与工作区 | `GET /v1/health`、`GET/PUT /v1/workspace`、`GET /v1/git/status` | [`v1-routes.js`](src/v1-routes.js)、[`workspace-tools.js`](src/workspace-tools.js) |
| 直连会话 | `GET/POST /v1/sessions`、`POST /v1/sessions/:id/turns`、`GET /v1/stream` | [`direct-agent.js`](src/direct-agent.js)、[`runtime/session-repo.js`](src/runtime/session-repo.js) |
| 会话控制 | `POST /v1/sessions/:id/steer`、`.../compact`、`.../rewind`、`POST /v1/turns/:id/cancel` | [`direct-agent.js`](src/direct-agent.js)、[`kernel/cancellation.js`](src/kernel/cancellation.js) |
| 审批与治理 | `GET /v1/approvals`、`POST /v1/approvals/:id/decision`、`GET /v1/audit/*` | [`runtime/approval-manager.js`](src/runtime/approval-manager.js)、[`governance/`](src/governance/) |
| 自治计划 | `POST /v1/plans`、`POST /v1/plans/validate`、`POST /v1/plans/execute`、`POST /v1/plans/replan` | [`planning/`](src/planning/)、[`routes/intelligence-routes.js`](src/routes/intelligence-routes.js) |
| Dynamic Swarm | `POST /v1/swarm/runs`、`GET /v1/swarm/runs/:id`、`GET .../delivery`、`POST .../artifacts/apply-all` | [`swarm/orchestrator.js`](src/swarm/orchestrator.js)、[`routes/swarm-routes.js`](src/routes/swarm-routes.js) |
| 自治运行 | `POST /v1/autonomous/runs` | [`direct-agent.js`](src/direct-agent.js)、[`repo-intelligence.js`](src/repo-intelligence.js) |
| Benchmark 与评测 | `GET /v1/benchmarks`、`GET/POST /v1/evaluations` | [`evaluation/service.js`](src/evaluation/service.js)、[`routes/intelligence-routes.js`](src/routes/intelligence-routes.js) |
| 通信与能力 | `/v1/communication/*`、`/v1/agents/capabilities/*`、`/v1/swarm/teams/optimize` | [`communication/`](src/communication/)、[`swarm/capabilities.js`](src/swarm/capabilities.js)、[`swarm/team-optimizer.js`](src/swarm/team-optimizer.js) |
| 经验记忆 | `/v1/memory`、`/v1/memory/experience/*` | [`context/memory.js`](src/context/memory.js)、[`memory/service.js`](src/memory/service.js) |
| Durable Runtime | `/v1/runtime/*`、`/v1/reconciliations/*`、`/v1/sessions/:id/checkpoints` | [`kernel/`](src/kernel/)、[`durable/`](src/durable/)、[`routes/runtime-routes.js`](src/routes/runtime-routes.js) |
| 调度 | `/v1/schedules/*` | [`governance/cron.js`](src/governance/cron.js)、[`governance/scheduler.js`](src/governance/scheduler.js) |
| Provider 与模型 | `/v1/accounts/*`、`/v1/models/*`、`/v1/auth/*` | [`pool.js`](src/pool.js)、[`web-login.js`](src/web-login.js) |
| 协议网关 | `POST /v1/chat/completions`、`POST /v1/messages` | [`gateway-proxy.js`](src/gateway-proxy.js)、[`v1-routes.js`](src/v1-routes.js) |
| 签到与扩展 | `/v1/checkin/*`、MCP 状态和 Hook Trust 端点 | [`checkin.js`](src/checkin.js)、[`mcp-client.js`](src/mcp-client.js)、[`tools/`](src/tools/) |

### Legacy / compatibility API

旧版 `/api/v1/*` DAG 路由仍在 [`routes.js`](src/routes.js) 和 [`engine.js`](src/engine.js) 中挂载，用于兼容旧客户端。Direct Multi-Turn Streaming、自治计划和 Dynamic Swarm 的新文档与调用关系以 `/v1/*` 和 `routes/` 为准。

## 本地扩展配置

- 项目规则由 `AGENTS.md`、`AGENTS.override.md` 和 `CLAUDE.md` 按工作区层级发现并注入。
- 生命周期 Hook 可配置于 `<workspace>/.agent-us/hooks.json` 或 `backend/var/hooks.json`，包括 `SessionStart`、`PreToolUse`、`PostToolUse` 和 `Stop`。
- MCP Stdio Server 可配置于 `<workspace>/.agent-us/mcp.json` 或 `backend/var/mcp.json`，由 MCP Hub 和生命周期管理器挂载。
- 本地凭证和数据库属于运行时数据，文档不记录其内容。

## 数据与持久化

`Store` 使用 SQLite WAL。当前代码将 `PRAGMA user_version` 维护为 **7**，并提供从历史 v5 / v6 数据库到 v7 的迁移和回滚保护。关键持久化对象包含会话、消息、工具收据、Checkpoint、Job、审批、Swarm 运行、节点、Artifact、调度运行、经验记忆、评测记录、指标事件和哈希链账本。

真实实现见 [`store.js`](src/store.js)、[`runtime/session-repo.js`](src/runtime/session-repo.js)、[`durable/checkpoint.js`](src/durable/checkpoint.js)、[`durable/job-queue.js`](src/durable/job-queue.js) 和 [`memory/schema.js`](src/memory/schema.js)。

## 检查与测试

```powershell
Set-Location D:\Agent_US\backend
npm run check

# 运行单个相关套件
node --test test/repo-intelligence.test.js
node --test test/swarm/autonomous-generalization.test.js
node --test test/migration-v5-v6-v7.test.js

# CI 使用的非环境门禁回归方式
node --test --test-concurrency=4 --test-timeout=60000 test/<suite>.test.js
```

CI 在 Windows 和 Ubuntu 上逐文件运行核心回归，排除 `security.test.js`、`providers.test.js` 和 `integration.test.js`。见 [CI 工作流](../.github/workflows/ci.yml)。

2.3 的真实 Provider、陌生仓库、独立 Reviewer、恢复和离线控制结果见 [`docs/archive/2.3-general-autonomous-agent-report.md`](docs/archive/2.3-general-autonomous-agent-report.md)。
