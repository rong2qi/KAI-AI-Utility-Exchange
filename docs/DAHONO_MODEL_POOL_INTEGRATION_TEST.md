# Dahono 模型池 60 分钟集成测试计划

这份计划把 Dahono Router 的 DeepSeek V4.1 Flash 纳入 KAI Hour Key 的 Provider 测试路线。它使用现有 `ProviderAdapterPort`，不改 Runtime、Usage Ledger 或 Receipt 契约；SSE、预约窗口和诊断响应头都封装在新 adapter 内。

## 已确认的接入事实

- Base URL：`https://kai.dahono.com/v1`
- 路由：`POST /v1/chat/completions`
- 模型：`deepseek-v4.1-flash`
- 协议：OpenAI-compatible，支持 SSE；调用方只需标准 Bearer 鉴权，不需要自定义请求头。
- 页面文档声明的容量：10 并发流、10 RPM、600 RPH、20M 输入 token/小时、4M 输出 token/小时，单请求通常 8192 token（可到 16k）。这些容量在 live slot 中再实测，不能仅凭页面声明标记为已证明。
- 文档验收套件包含模型/指纹握手、10 路 SSE、11 路触发 429、8 个诊断响应头校验。

页面当前返回“当前时间不在组织预约窗口”，Playground 和 Agent 检查均未执行实际模型推理。直接请求也返回 `403_OUTSIDE_RESERVED_WINDOW`。预约属于计费和外部副作用；在没有明确预约授权前不点击 Reserve，也不把页面展示的 demo key 写入仓库或证据。

这次守卫检查的机器证据在 `work/kai-hour-key-contracts/evidence/dahono-provider/guard-20261005.json`；它证明入口可达且窗口保护生效，不把 403 误判为 Provider 已可用。

## 60 分钟执行顺序

| 时间 | 测试 | 通过条件 | 证据 |
| --- | --- | --- | --- |
| 0–5 分钟 | 注入临时 API key、确认 endpoint/model、记录 Node 版本 | key 只存在于运行环境，日志无明文 | 脱敏配置摘要 |
| 5–12 分钟 | 单请求模型握手 | HTTP 200、模型名/指纹与预期一致、能解析 SSE | request hash、status、model、fingerprint hash |
| 12–22 分钟 | 单流完整推理 | 首包、末包、结束标记、usage 可解析，诊断头齐全 | 脱敏响应与 8 个 header 数值 |
| 22–35 分钟 | 10 路并发 SSE | 10 路无丢包、均完成、并发计数不越界 | 每路结果摘要、并发峰值 |
| 35–42 分钟 | 第 11 路过载 | 得到 429 和 `Retry-After`，不伪造成功 Receipt | status、retry-after、错误码 |
| 42–49 分钟 | 重试与超时 | 429 按退避重试；5xx/网络/超时可重试；401/403 不盲重试 | 错误映射和尝试次数 |
| 49–55 分钟 | Agent/遥测检查 | Capacity、EOD、KOD 检查结果可回读，不泄露 key | agent 状态、slot/region hash |
| 55–60 分钟 | 封存证据并释放窗口 | source fingerprint、usage、摘要、边界齐全 | `kai-dahono-provider-evidence.v1` |

## 代码接缝

新增 `dahono-router` Provider adapter，构造器注入 endpoint allowlist、key resolver、fetch、timeout 和 network mode。默认仍是 network-disabled；测试必须覆盖：payload 映射、SSE parser、usage、诊断头、401/403/429/5xx、超时、畸形响应和 key 不泄露。

Provider 没有被确认提供上游幂等语义，因此 evidence 记录 `upstreamIdempotency=unsupported`；有效的一次性重试仍由现有 Usage Execution Ledger 的 request hash/idempotency 负责。

## 验收边界

本计划完成后可以证明该 Provider adapter 和一次预约窗口内的真实模型调用。它仍不证明生产业务流量安全、数据库事务隔离、有效一次性执行，或坏制品触发的真实远端自动回滚；这些要按现有 staging 证据链分别验证。
