# Provider Sandbox 分层说明

## 当前层级：internal-provider-sandbox

`SandboxProviderAdapter` 是不出网的进程内 Provider 实现。它只实现 `ProviderAdapterPort`，不读取凭据，也不改变 Runtime、Holding 或 Usage Ledger 的职责。

可用 profile：

- `success`：返回确定性的 Provider request ID、回显结果和用量；
- `transient_failure`：同一幂等键第一次失败，重试成功；
- `timeout`：返回可重试的超时错误；
- `permanent_failure`：返回不可重试的永久失败；
- `malformed_result`：返回故意不完整的结果，验证上层拒绝坏响应。

同一个 `idempotencyKey` 加同一组 `model`、`region` 和输入事实会返回同一个结果。相同幂等键如果请求事实改变，会返回 `IDEMPOTENCY_CONFLICT`。`requestId` 不参与请求事实指纹，因此重试可以使用新的请求 ID。

运行验证：

```text
npm run provider:sandbox:verify
```

证据写入 `evidence/provider-sandbox/`，等级固定为 `internal-provider-sandbox`，并记录网络关闭、未使用凭据、Git 提交和源码指纹。该证据只证明本项目内部的适配器契约、幂等和故障处理，不代表真实供应商、staging 或生产通过。

## 后续层级

`local-http-sandbox` 通过 `npm run http:sandbox:verify` 验证只监听 `127.0.0.1` 的 HTTP 边界，证据写入 `evidence/local-http-sandbox/`。它覆盖 HTTP 序列化、状态码、超时、请求体上限、未知路径和服务关闭，但仍不访问外网。

`upstream-provider-sandbox` 才需要供应商账号、endpoint、token、配额和预算；`staging` 需要真实 Provider 沙盒、事务数据库、故障注入和回滚制品。

## 讯飞星火第三层适配

`XfyunSparkProviderAdapter` 对接讯飞星火文档中的非流式 Chat 接口。它只接受已声明的 `spark-x2.5`、`spark-x2.5-4b` 和 `spark-x2.5-1.7b` 模型，把项目的 `input.messages` 映射为供应商请求，并把 `id`、首个 `choices[].message` 和 `usage` 映射回 `ProviderExecutionResult`。

官方接口依据是 [讯飞星火 Chat API 文档](https://maas.xfyun.cn/doc/guide/3%E3%80%81API%20%E6%8E%A5%E5%8F%A3/3.1%20%E6%98%9F%E7%81%AB%E6%A8%A1%E5%9E%8B%20API/3.1.1%20Chat.html)：请求使用 `POST /v2/chat/completions`、`Authorization: Bearer` 和 `messages`；适配器默认关闭流式输出，避免把 SSE 细节泄漏到 Runtime。

密钥由适配器内部解析：本地 smoke 可使用 `XFYUN_API_KEY` 环境变量或注入一个 Keychain 读取函数。密钥不写入请求结果、错误文本、证据 JSON 或 Git。仓库只提供 `.env.example`，不提供真实值。

### 你需要怎样把密钥交给本地适配器

不需要把密钥贴到对话或写进项目。macOS 上只需在本机终端执行一次：

```text
security add-generic-password -a "$USER" -s "kai-xfyun-api-key" -w
```

系统会在终端中隐藏输入内容。然后在项目目录运行：

```text
npm run xfyun:keychain:check
```

看到 `keychain_status=available` 后，只需告诉我“密钥已就位”，我就可以在你明确授权后运行一次最小化 live smoke。检查命令只输出 available/missing/unavailable，绝不打印密钥。若只想临时运行，也可在当前终端设置 `export XFYUN_API_KEY='...'`，适配器默认读取该环境变量。

第三层合同证据可用 `npm run xfyun:contract:verify` 生成；它使用假 fetch，固定记录 `networkDisabled=true`、`credentialsUsed=false`，因此不会冒充真实供应商连通性证据。

真实连通性只通过受保护的单请求入口执行：

```text
npm run xfyun:live:smoke -- --confirm-live
```

没有 `--confirm-live` 时脚本直接写入 `EXPLICIT_LIVE_CONFIRMATION_REQUIRED` 并退出，不读取密钥也不出网。带确认时只发送一条固定的 `Return exactly the word OK.` 请求，使用 `spark-x2.5`（可用 `--model=spark-x2.5-4b` 或 `--model=spark-x2.5-1.7b`），并将证据限制为状态、Provider request ID、用量和输出长度，不保存正文或密钥。一次 smoke 通过只证明该时刻、该账号和该模型的最小连通性，不能替代 staging、额度、故障恢复、数据库事务或生产回滚验收。

讯飞文档没有声明幂等键语义，因此适配器不会宣称供应商侧 exactly-once。项目的 `UsageExecutionLedger` 只在已记录 Provider 结果时避免重复调用；要把“上游也只执行一次”升级为可证明结论，需要供应商明确的幂等支持或 staging 级别的去重代理。
