# Agent_US

本地多模型直连智能体（Direct Multi-Turn Streaming Agent）+ 多供应商号池网关 + 模型管理中心 + 签到中心，配套 React/Electron 桌面工作台。

## 目录结构

- `backend/` — Node.js 24 + Fastify + SQLite WAL 后端运行时（`DirectAgentRuntime`、`AccountPool`、`CheckinService`、本地工作区工具链与 MCP Stdio Hub）
- `frontend/` — React + TypeScript + Vite 前端工作台
- `desktop/` — Electron 桌面壳与同源代理
- `start-dev.ps1` — Windows 一键启动前后端开发环境

## 快速启动

```powershell
# 1. 启动后端（默认监听 127.0.0.1:8787）
Set-Location D:\Agent_US\backend
npm ci
npm start

# 2. 启动前端（默认 http://127.0.0.1:5173）
Set-Location D:\Agent_US\frontend
npm ci
npm run dev
```

或在项目根目录直接运行 `.\start-dev.ps1`。

## 核心能力

- **直连多轮流式 Agent (`/v1/sessions`)**：无需强制 DAG，支持实时 Token/思考/终端流、读并行写屏障调度、4 级模糊 `edit_file` + Codex 多文件原子 `apply_patch`、编辑后即时语法诊断、防脏写保护、确定性快照 `/rewind`、两阶段语义压缩 `/compact`、运行中实时纠偏 `/steer`、防死循环熔断、会话级命令前缀审批白名单、`AGENTS.md` 层级发现、生命周期 Hooks 与 MCP 工具挂载。
- **账号号池与模型管理 (`/v1/accounts`、`/v1/models/pool`)**：AES-256-GCM 凭证加密、支持本地 `agent2api`（默认 `127.0.0.1:3065/v1`）及多厂商 OpenAI/Anthropic 协议、自动同步上下文窗口与视觉能力元数据、模型别名映射、429 冷却与故障转移。
- **签到中心 (`/v1/checkin/*`)**：兼容 Agent2API 协议桥接模式与本地插件模式（`checkin-plugins/`），支持定时签到与补签记录。

## 验证命令

```powershell
# 后端检查与非 Docker/Magpie 回归测试
Set-Location D:\Agent_US\backend
npm run check

# 前端类型检查与构建
Set-Location D:\Agent_US\frontend
npx tsc --noEmit
npm run build
```

更多说明见 [backend/README.md](backend/README.md)、[backend/docs/architecture.md](backend/docs/architecture.md) 与 [frontend/README.md](frontend/README.md)。
