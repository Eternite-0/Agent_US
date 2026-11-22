# Agent_US Frontend

React 19 + TypeScript + Vite 6 工作台。前端通过 [`src/api/client.ts`](src/api/client.ts) 和 [`src/api/runtimeClient.ts`](src/api/runtimeClient.ts) 对接 Agent_US 的 `/v1` REST 与 SSE 接口，也可以由 Electron Desktop Host 托管。

## 快速启动

### 开发模式

```powershell
Set-Location D:\Agent_US\frontend
npm ci
$env:BACKEND_URL = "http://127.0.0.1:8787"
$env:BACKEND_TOKEN = "<与 backend 相同的 BACKEND_TOKEN>"
npm run dev
```

访问 `http://127.0.0.1:5173`。Vite 开发服务器代理 `/v1` 和 `/api/v1`，后者只为旧客户端兼容保留。

### 类型检查、生产构建与测试

```powershell
Set-Location D:\Agent_US\frontend
npx tsc --noEmit
npm run build
node --test test/subagent-progress.test.js
```

## 当前界面能力

- 多轮流式会话、Markdown、思考过程、工具调用、终端输出、计划进度和 SSE 事件。
- 工作区文件浏览、Diff 检查、`/steer`、`/compact`、`/rewind`、取消和审批卡片。
- Autonomous Run 与 Dynamic Swarm 的节点进度、消息、Artifact、Reviewer 结论、Evidence 和 Apply All 冲突门禁。
- 账号号池、Provider 健康度、模型目录、模型映射、默认模型、网页登录和签到中心。
- 工具收据、证据状态和未知副作用的 Reconciliation 卡片。后端另提供 Checkpoint、Metrics、Trace 和审计查询。

前端界面展示后端返回的状态和证据。后端是否完成真实执行，以 `backend/src/` 中的运行时和 `/v1` 响应为准。

## 主要客户端分层

```text
src/
├─ api/
│  ├─ client.ts          # REST API、会话、账号、模型和自治运行
│  ├─ runtimeClient.ts   # 运行时概览、收据、Swarm、调度和 Reconciliation
│  └─ simulator.ts       # 无后端演示数据，不代表真实执行结果
├─ components/           # 会话、审批、Swarm、交付、设置和 Provider UI
├─ assets/               # Provider、插件和产品图标
├─ types/                # 后端 payload 和前端状态类型
├─ App.tsx               # React 应用入口
└─ main.tsx              # Vite 入口
```

## 相关 API

| 前端区域 | 后端接口 |
| --- | --- |
| 会话和 SSE | `/v1/sessions/*`、`/v1/stream` |
| 工作区与 Git | `/v1/workspace/*`、`/v1/git/*` |
| 审批和运行时 | `/v1/approvals/*`、`/v1/runtime/*`、`/v1/reconciliations/*` |
| Autonomous Run 与 Swarm | `/v1/autonomous/*`、`/v1/plans/*`、`/v1/swarm/*` |
| Provider 与模型 | `/v1/providers/*`、`/v1/accounts/*`、`/v1/models/*`、`/v1/auth/*` |
| 记忆与 Swarm 通信 | `/v1/memory`、`/v1/communication/messages` |
| 调度、MCP 和审计 | `/v1/schedules/*`、`/v1/runtime/mcp/status`、`/v1/audit/*` |

## 常用快捷键与斜杠命令

| 快捷键 / 命令 | 功能 |
| --- | --- |
| `Ctrl + K` | 打开全局命令面板与搜索 |
| `Ctrl + N` | 新建会话 |
| `Ctrl + B` | 收起或展开侧边栏 |
| `Ctrl + Shift + L` | 切换浅色或深色主题 |
| `Ctrl + ,` | 打开设置 |
| `/compact` | 触发当前会话上下文压缩 |
| `/rewind` | 回退上一轮工作区文件变更与会话状态 |
| `/diff` / `/events` | 打开 Diff 或 SSE 事件流检查器 |
