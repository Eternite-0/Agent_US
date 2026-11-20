# Agent_US Backend

Node.js 24 + Fastify + SQLite WAL 后端运行时，提供直连多轮流式智能体（`DirectAgentRuntime`）、多供应商账号号池（`AccountPool`）、模型管理中心与签到中心（`CheckinService`）。

## 快速启动

```powershell
Set-Location D:\Agent_US\backend
npm ci
$env:BACKEND_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

服务默认监听 `127.0.0.1:8787`，数据目录默认为 `backend/var`（可通过 `BACKEND_DATA` 覆盖，工作区目录可通过 `AGENT_WORKSPACE` 或 `PUT /v1/workspace` 设置）。

## 接入本地 Agent2API / 外部 Provider

1. 启动本地 `agent2api`（默认 `http://127.0.0.1:3065/v1`）或在前端「设置 → 账号号池」中添加供应商账号（也支持调用 `POST /v1/accounts/import-local` 自动导入 `var/config.json` + `var/.provider-env.json` 或本机网关）。
2. 调用 `POST /v1/accounts/:id/sync-models`（或前端点击「获取模型」）自动拉取模型列表、上下文窗口与视觉能力。
3. 在模型管理页启用模型并设置默认模型即可立即参与对话路由。

## 主要 `/v1` API 概览

| 类别 | 关键端点 | 说明 |
| --- | --- | --- |
| 健康与工作区 | `GET /v1/health`, `GET/PUT /v1/workspace`, `GET /v1/git/status` | 健康探测、切换工作目录与 Git 状态 |
| 直连会话 | `POST /v1/sessions`, `POST /v1/sessions/:id/turns`, `GET /v1/stream` | 多轮流式对话与 SSE 实时事件流 |
| 会话增强 | `POST /v1/sessions/:id/steer`, `.../compact`, `.../rewind`, `GET /v1/history/search` | 运行中纠偏、语义压缩、快照回退、FTS5 历史检索 |
| 审批控制 | `GET /v1/approvals`, `POST /v1/approvals/:id/decision` | 单次 (`once`) 或本会话前缀 (`session`) 放行 |
| 号池与模型 | `GET/POST /v1/accounts`, `POST /v1/accounts/:id/sync-models`, `GET /v1/models/pool`, `POST /v1/models/test` | 账号管理、模型拉取、别名映射与连通测试 |
| 签到中心 | `GET /v1/checkin/center`, `POST /v1/checkin/run`, `GET /v1/checkin/records` | Agent2API 协议桥接与本地插件签到 |

> 旧版 `/api/v1/*` DAG 路由继续保留以向后兼容。

## 扩展配置（工作区级）

- **项目规则**：在工作区或 `.git` 根目录放置 `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md`，Agent 自动按层级合并注入。
- **生命周期 Hooks**：在 `<workspace>/.agent-us/hooks.json` 或 `backend/var/hooks.json` 配置 `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop`。
- **MCP 工具**：在 `<workspace>/.agent-us/mcp.json` 或 `backend/var/mcp.json` 配置 stdio MCP Server，自动挂载为 `mcp__<server>__<tool>`。

## 检查与测试

```powershell
Set-Location D:\Agent_US\backend
npm run check

# 运行非 Docker/Magpie 全量回归测试（16 个文件 / 43 项用例）
$tests = Get-ChildItem test\*.test.js | Where-Object { $_.Name -notmatch 'docker|sandbox-container|integration|providers|security' } | ForEach-Object { "test/$($_.Name)" }
node --test @tests
```

详细架构说明见 [docs/architecture.md](docs/architecture.md)。
