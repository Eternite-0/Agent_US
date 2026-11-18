# 源码决策记录

检出点见 upstream-lock.json。后端独立安装，npm ci 校验发布包完整性。

| 来源 | 调用链与采用方式 |
| --- | --- |
| DSH | `packages/core/agent-loop/tests/loop.spec.ts` 中的 Cordis 服务组合，`agent-loop/src/index.ts` 的 create / dispose 生命周期，以及原生工具执行器。直接依赖发布包，固定 `dsh-v0.2.2-rc.5`。|
| SuperAgent | `src/app/tools/executor.ts` 绑定 ticket，`src/app/outbox.ts` 提交外部投递，`tests/core-engine.spec.ts` 覆盖分派及重试。吸收授权范围与可靠投递语义，用 SQLite DAG 支持单个任务的多分派。|
| Codex | `codex-rs/core/src/tools/orchestrator.rs`、`approvals.rs`、`unified_exec/mod.rs`。分别检查权限裁决、执行、进程生命周期。集成点选择无模型的 command/exec。|
| Claude Code | 官方公开 hooks 示例和 mod-tests 工作流用于理解输入事件与生命周期。社区研究 README 标明其分析涉及泄露源码，排除其分析正文、bundle 与 prompt。|
| Magpie | `main.go` → `internal/cli` → `serve`，`internal/cli/healthcheck_cli.go` 检查根路由标识，`account_discovery_cli.go` 确认 `MAGPIE_NO_ACCOUNTS`，`internal/provider/provider.go` 定义显式配置协议。|
