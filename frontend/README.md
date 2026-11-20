# Agent_US Frontend

React + TypeScript + Vite 工作台，直接对接 `Agent_US` 后端的 `/v1` REST 与 SSE 流式接口（兼容 Electron 桌面壳 `../desktop` 及本地演示模式）。

## 快速启动

### 1. 开发模式（内置 `/v1` 与 `/api/v1` 同源反向代理）

```powershell
Set-Location D:\Agent_US\frontend
$env:BACKEND_URL = "http://127.0.0.1:8787"
$env:BACKEND_TOKEN = "<与 backend 相同的 BACKEND_TOKEN>"
npm run dev
# 打开 http://127.0.0.1:5173
```

### 2. 类型检查与生产构建

```powershell
Set-Location D:\Agent_US\frontend
npx tsc --noEmit
npm run build
```

## 核心界面能力

- **直连流式对话**：实时渲染 Markdown 回复、思考过程折叠盒、`update_plan` 进度条与步骤清单、流式 `bash` 实时终端输出、工具调用胶囊与文件 Diff 检查器。
- **运行中控制**：支持运行中直接输入 **实时纠偏指令 (Steer)**、审批卡片 **「本会话允许 `<前缀>`」**、确定性 **回退代码 (`/rewind`)** 与 **压缩上下文 (`/compact`)**、以及推理强度 (`effort`) 滑块透传。
- **号池与签到工作台**：内置「添加账号」向导、「账号号池」优先级管理、「模型管理中心」（同步模型/开关/别名映射/连通测试）与「签到中心」。

## 常用快捷键与斜杠命令

| 快捷键 / 命令 | 功能 |
| --- | --- |
| `Ctrl + K` | 打开全局命令面板与搜索 |
| `Ctrl + N` | 新建对话 |
| `Ctrl + B` | 收起 / 展开侧边栏 |
| `Ctrl + Shift + L` | 切换浅色 / 深色主题 |
| `Ctrl + ,` | 打开设置（含账号号池、模型管理、签到中心） |
| `/compact` | 触发当前会话语义上下文压缩 |
| `/rewind` | 确定性回退上一轮工作区文件变更与对话状态 |
| `/diff` / `/events` | 打开右侧 Diff 或 SSE 事件流检查器 |
