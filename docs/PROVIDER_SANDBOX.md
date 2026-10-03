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
