# 内置网关网页登录

在「账号池 → 添加账号」选择 WorkBuddy（国内或国际）、CodeArts（华为云中国站）或 Trae（国内或国际），点「打开网页登录」。授权后返回账号池即可；勾选自动获取模型会同步该账号的目录。不需要启动 Agent2API、Magpie、浏览器调试端口，也不需要配置签到桥。授权失败或超时请重新发起。CodeArts、Trae 的浏览器与后端须在同一台电脑。

| 供应商 | 内置网关如何接收授权 | 如何访问推理 API |
| --- | --- | --- |
| WorkBuddy | 获取 state，在供应商网站选择账号，后端轮询 token 和账号信息 | Bearer 与该账号/团队的请求头；用 `/v3/config` 获取模型 |
| CodeArts | 临时回环端口、PKCE 和 DPoP 向华为云 STS 换证 | 用临时 AK/SK 签名每个请求；签名涵盖实际发送的请求体。目录来自 `/v1/model/builtin` |
| Trae 个人版 | 分地区的授权页和 `/authorize` 回环回调；授权码使用 PKCE，旧的 token 回调须能核对网页来源或登录追踪 ID | 从该地区的模型目录选取 function/config，转换供应商 SSE；不将国内凭证送到国际站，亦不将企业席位静默转到个人额度 |

每次成功授权在相应供应商下建号。结构化凭证单独用账号池主密钥加密存储；刷新令牌、签名私钥不进入账号元数据或前端。模型同步、OpenAI/Anthropic 兼容入口和 Direct Agent 共用传输逻辑。账号删除时会话级联删除。原有手动添加的兼容网关不会被改写或自动迁移。

## 源码对照（只作参考，非运行时依赖）

- Agent2API 的 [会话入口](https://github.com/aimod-cc/Agent2API/blob/e8bed7397aaf9d8962489074557c2f1f1a8d4f97/desktop-tauri/src-tauri/server/src/server/api/session.rs)；[Agent2Providers 供应商适配器源码](https://github.com/ProvidersPlugin/Agent2Providers/tree/6a1c36c0a092630c031102bc3ed0ef0611c6c3d8/crates/providers/src/providers)，参见 `workbuddy`, `codearts`, `trae`。
- Magpie 社区的 [WorkBuddy](https://github.com/magpie-community/plugins/blob/5846ae517588024debed6c4d3d9f9319c67607fa/packages/workbuddy/index.mjs)、[CodeArts](https://github.com/magpie-community/plugins/blob/5846ae517588024debed6c4d3d9f9319c67607fa/packages/codearts/index.mjs)、[Trae](https://github.com/magpie-community/plugins/blob/5846ae517588024debed6c4d3d9f9319c67607fa/packages/trae/index.mjs) 插件；仅对照授权及模型协议，不加载插件或读取其他客户端登录态。

测试：`node --test test/native-provider-login.test.js` 使用临时数据库、真实的临时回环监听器和模拟的上游 HTTPS 响应，不需要用户凭证。真实站点、套餐模型范围及企业 SSO 并非这些测试的覆盖范围。
