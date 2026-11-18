# Agent US Backend

本服务用 DSH 驱动 Router、执行 Worker 和验收会话。前端通过 REST 创建任务，订阅 SSE，并向指定审批记录提交决定。任务、工作结果和事件由 SQLite 保存。运行环境为 Node.js 24、PowerShell 7、Docker Linux containers 和 linux/amd64 工具镜像。

## 启动和验证

在 PowerShell 运行以下命令。镜像构建下载带校验和的 Codex CLI、Magpie CLI 和基础系统组件。后续启动复用已构建的镜像。

```powershell
Set-Location D:\Agent_US\backend
npm ci
npm run images
npm run check
npm test
$env:BACKEND_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

服务默认监听 `127.0.0.1:8787`。`GET /health` 可以匿名检查存储连接。`GET /api/v1/providers/health` 需要 Bearer token，返回模型路由就绪状态。模型目录为空时可联调项目、任务和事件接口，任务在数据库中等待可用配置。`npm run test:integration` 可以在没有供应商密钥时复现完整任务交付。

## 连接真实模型

1. 复制 `config.example.json` 到 `var/config.json`。将 `model` 替换为供应商账户可调用的模型 ID，填写实际上下文、工具能力、能力评分和每百万输入及输出 token 的美元费率。示例中的零费率用于占位。
2. 将 `BACKEND_CONFIG` 指向该 JSON 文件。用操作系统的 secret 注入机制提供 `keyRef` 指定的环境变量，如 `AGENT_DEEPSEEK_KEY`。配置文件仅保存引用。设置 `magpie: true` 时 Backend 自动启动私有网关。
3. 重新启动服务。`GET /api/v1/providers` 可核对发现结果，`GET /api/v1/models` 可核对 Router 能使用的模型。可为某个 Provider 配置 `defaultCapabilities`，为发现的新模型赋予管理员认可的默认能力。该对象使用模型字段，省略 `provider` 和 `model`。

每次健康检查间隔 60 秒。Magpie 的凭证通过容器 stdin 注入，配置写入容器内 tmpfs。网关关闭账户发现，仅注册显式供应商。Backend 拥有容器生命周期和临时访问令牌。请求在流开始前失败时可转到原生通路。流中断时结束该次尝试，Task Engine 按租约重试。

`BACKEND_DATA` 指定数据库和 Worker 目录，默认是启动目录下的 `var`。`PORT` 设置服务端口。`BACKEND_VAULT` 可以指向 AES-256-GCM 密钥文件，由 `BACKEND_MASTER_KEY` 解密。`node scripts/seal.js var/provider-keys.enc` 从 stdin 读取一份以 keyRef 为键的 JSON 对象。主密钥是 base64 编码的 32 个随机字节，应保存在服务外部。文件创建采用独占写入。

## 前端联调

通过同源反向代理将 `/api/v1` 转发给 Backend。浏览器可使用 `client/index.ts` 的类型和 fetch 封装。下列操作按表中顺序进行。

| 操作 | 接口 | 关键数据 |
| --- | --- | --- |
| 建项目 | `POST /api/v1/projects` | `{"name":"demo"}` |
| 提交任务 | `POST /api/v1/tasks` | `projectId`、`input`、`idempotencyKey`。可选 `files` 是相对路径到 base64 内容的映射，可选 `budget` 见客户端类型。|
| 查看规划 | `GET /api/v1/router/{taskId}` | DAG、风险、验收标准、最终裁决 |
| 等待审批 | `GET /api/v1/approvals?taskId=…` | 查看 `tool`、`action`、`digest`、`workerId`、`version`、`expires` |
| 裁决 | `POST /api/v1/approvals/{id}/decision` | `{"decision":"approve","version":1}` 或 `deny`。重复或过期裁决返回 409。|
| 取结果 | `GET /api/v1/artifacts?taskId=…` | 每个已发布分派的文本、文件名和 base64 内容。`published` 标识当前版本。|
| 查验证记录 | `GET /api/v1/evidence?taskId=…` | 退出码、截断输出、审批关联和文件变更前后内容 |

`projects`、`tasks`、`workers`、`assignments`、`sessions`、`approvals`、`artifacts`、`evidence`、`memory`、`usage` 支持集合和按 ID 查询。集合支持 `projectId`、`taskId`、`limit`（1–200）和 `offset`。项目可用 `PATCH /api/v1/projects/{id}` 更新名称，提交当前版本号。`GET /api/v1/tasks/{id}/versions/{version}` 读取任务旧版本。

`POST /api/v1/tasks/{id}/pause|resume|cancel|retry` 的请求体为 `{"version":当前版本号}`。暂停会撤销在途租约。恢复后，调度器从已完成的分派继续。`GET /api/v1/sessions/{id}/history?after=0` 提供分页历史和下一页游标。

`GET /api/v1/events?taskId=…&after=0` 返回一页事件。发送 `Accept: text/event-stream` 开启 SSE。客户端用 fetch 保留 Authorization 头，通过 `Last-Event-ID` 或 `after` 从已确认序号之后重放，按 `seq` 去重。事件只含状态和关联 ID。审批详情、文件内容分别在对应资源读取。错误形如 `{"error":{"code":"STALE_VERSION","message":"…","requestId":"…"}}`，其中 `message` 为可选项。

## 运行和恢复

- 每个分派尝试拥有独立 DSH Session、逻辑目录、工作文件快照和权限。读工具可以并发。修改操作独占工作快照，所有命令都在各自的无网络容器中执行。
- Codex `command/exec` 负责命令、PTY、输出限制和超时。Docker 强制非 root、删除 capabilities、只读镜像、空的私有 tmpfs 工作区、进程数和内存上限。Worker 容器没有宿主目录挂载。短时 MCP stdio server 在同一限制下启动，配置中的命令必须已存在于 Worker 镜像。
- SQLite 的 WAL、事务、版本比较、durable jobs outbox 和带 fencing token 的 15 秒租约允许恢复进行中的 DAG。完成节点按事务发布一次。执行进程崩溃后，新尝试重新申请授权。上一次失联工具的证据可以是 `outcome_unknown`。
- 管理员可在 `BACKEND_DATA/skills/<name>/SKILL.md` 放入受信任的说明，`roles: Coder,Tester` 可限制角色。每次创建会话时重新读取。任务历史和已验收记忆按项目或会话隔离。`ContextPolicy.hooks.on` 注册 `session.start`、`usage` 和 `session.finish` 处理器。
- 备份时停止服务后复制整个数据目录，或用 SQLite 在线备份。数据目录含任务正文、产物和执行记录，按用户私有数据设置文件权限。`Ctrl+C` 会关闭 HTTP、停止调度并回收网关。

详细设计、验证记录及适用范围见 `docs/architecture.md`、`docs/test-report.md` 和 `docs/limits.md`。上游审计入口及源码提交见 `docs/audit.md`、`docs/upstream-lock.json`。

## 嵌入 Cordis

`@agent-us/backend/bundle` 的默认导出是可挂载的 `BackendBundle`，接受 `{store, persona}`。它注册 DSH 核心服务和 `agent-us-task-engine` 插件。每个执行会话额外挂载 `agent-us-worker-tools`，绑定此次分派的模型适配器与授权工具。
