# Dahono 模型池 60 分钟集成测试计划

这份计划把 Dahono Router 的 DeepSeek V4.1 Flash 纳入 KAI Hour Key 的 Provider 测试路线。它使用现有 `ProviderAdapterPort`，不改 Runtime、Usage Ledger 或 Receipt 契约；SSE、预约窗口和诊断响应头都封装在新 adapter 内。

## 已确认的接入事实

- Base URL：`https://kai.dahono.com/v1`
- 路由：`POST /v1/chat/completions`
- 模型：`deepseek-v4.1-flash`
- 协议：OpenAI-compatible，支持 SSE；调用方只需标准 Bearer 鉴权，不需要自定义请求头。
- 页面文档声明的容量：10 并发流、10 RPM、600 RPH、20M 输入 token/小时、4M 输出 token/小时，单请求通常 8192 token（可到 16k）。这些容量在 live slot 中再实测，不能仅凭页面声明标记为已证明。
- 文档验收套件包含模型/指纹握手、10 路 SSE、11 路触发 429、8 个诊断响应头校验。

2026-10-05 的窗口外检查返回 `403_OUTSIDE_RESERVED_WINDOW`。2026-10-06 10:00–10:59（Asia/Shanghai）已获授权的 USD 30 窗口内，单次真实推理已通过，记录见 `work/kai-hour-key-contracts/evidence/dahono-provider/live-20261006020040126.json`。该记录不包含真实 10+1 并发和小时额度证明。后续付费预约须有对应时间和金额授权，不沿用已结束窗口的授权。

这次守卫检查的机器证据在 `work/kai-hour-key-contracts/evidence/dahono-provider/guard-20261005.json`；它证明入口可达且窗口保护生效，不把 403 误判为 Provider 已可用。

同一端点的 `GET /v1/models` 已在无凭据条件下返回 200，并列出 `deepseek-v4.1-flash` 及当前诊断计数；这只证明模型发现和网关遥测可读，证据见 `discovery-20261005.json`。

窗口外的无凭据 `POST /chat/completions` 先得到 403 窗口错误，不能据此验证 401 鉴权分支。错误 key 的真实鉴权检查属于独立负向测试，不夹带在有界容量测试中。Dahono 模型/provider 始终保持独立 scope，不覆盖现有讯飞 `spark-x2.5-4B` 结论。

## 测试路线与当前有界执行入口

下表是预约窗口内可选的完整测试路线，不是当前脚本会自动执行的所有动作。当前容量脚本不自动重试、不运行 Agent、不消耗整小时额度。

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

### 写入 staging 测试密钥

密钥由操作者在本机隐藏输入，脚本通过标准输入交给 GitHub CLI，写入仓库 `staging` Environment 的 `DAHONO_API_KEY`。脚本只核对密钥名称和更新时间，不读取或打印密钥值：

```sh
npm run dahono:staging:secret
```

脚本不会写服务器 Secret Store，也不会自动预约或发起模型请求；服务器侧接入必须在真实 Dahono adapter 和 staging 运行时都准备好后，按同一密钥来源单独配置。若 GitHub 环境密钥写入失败，脚本退出并明确报告失败。

密钥和有效预约窗口都准备好后，才由受保护入口执行单次 live smoke：

```sh
npm run dahono:live:smoke -- --confirm-live
```

未显式带 `--confirm-live` 时不会读取密钥或出网，并以 `blocked` 证据结束。live smoke 只保存请求次数、Provider 请求 ID 哈希、用量、诊断头和输出长度；它不保存密钥或模型正文，也不替代并发、限流、事务存储和回滚验证。

如果密钥已经写入 GitHub `staging` Environment，使用仓库中的 **KAI Dahono live smoke** 手动工作流即可执行同一入口；工作流仍需要 `staging` 环境审批，且不会随 push 自动运行。

Provider 没有被确认提供上游幂等语义，因此 evidence 记录 `upstreamIdempotency=unsupported`。现有 Usage Execution Ledger 只避免重复已经记账的步骤；如果上游已执行而本地尚未保存，崩溃后仍存在再次付费调用的风险。接入真实业务前须增加“结果待确认”状态和对账路径，或验证供应商幂等/结果查询能力，不能以本地 request hash 宣称跨系统有效一次执行。

### 真实 10+1 与小样本计数验收

`npm run dahono:capacity:verify -- --confirm-live` 使用同一个 Dahono adapter，通过环境变量读取 `DAHONO_API_KEY`、`DAHONO_WINDOW_START`、`DAHONO_WINDOW_END`。起止必须是带时区的 ISO 时间，间隔恰好一小时；启动时须位于窗口内并至少剩余五分钟。默认运行不取密钥、不出网。GitHub 的 **KAI Dahono capacity acceptance** 手动工作流提供同一入口，保存失败和未证明结果。

- 固定 HTTPS 目的地址，禁重定向；最多 14 次 POST、2 次 GET、总时长五分钟、单次推理三十秒，不自动重试。
- 前十个请求正常消费 SSE；只有十路都返回成功 SSE 响应头且尚未结束时才发第十一路。响应过快无法观察重叠时记录 `not_proven`，不延迟读取来伪造重叠。
- “十路成功”“十路未结束重叠”“第十一路 429”“429 可归因于并发”“小样本计数一致”分别出结论。Dahono 同时声明 10 RPM 和 10 并发，429 时若 RPM 已耗尽，不能将它归因于并发；即使 RPM 尚有余量，当前诊断头也没有足以排除其他额度限制的原因字段。因此本版本保留限流原因的 `not_proven`，其他观察项可分别通过；未来取得可审查的供应商原因契约后再增强判断。这是本次证据的边界，不是 Provider 的执行禁令。
- 在最多三次间隔 65 秒的小样本调用后，比较前后计数、成功请求 usage 和 slot 身份。计数统计时点或单位不一致时保留未证明结论，不能推导 20M/4M 整小时吞吐。其他客户端同窗口调用会污染计数，应隔离测试流量。
- 证据仅包含白名单状态、用量、诊断数值、身份哈希和源码指纹；不包含密钥、模型正文或原始异常。保存于 `evidence/dahono-capacity/`，CI artifact 保留 30 天。

通用 `concurrency-quota-acceptance` 只判断 burst 请求结果和合法 usage，不依赖 adapter 私有的 `peakConcurrency`，也不替调用方宣称禁网。离线 runner 另外记录 sandbox 的实际峰值和清理状态；真实流重叠与限流归因由 Dahono 验收入口负责。

### 将真实 Provider 组合进 staging，并逐步证明生产边界

当前 staging HTTP 服务只有 `/healthz` 与 `/version`，制品没有打包 Runtime/Provider；其 systemd 出网限制也没有开放上游访问。下一步采用以下顺序，不把健康检查成功当作业务成功：

1. 增加独立组合入口：受认证 HTTP → `HourKeyRuntime` → 注入的 `ProviderAdapterPort`。同一请求可在 sandbox 和 Dahono 间更换配置，供应商细节仍留在 adapter。
2. 接入账号/Grant/Holding 校验、请求大小/时间/并发/用量限制和取消；保留白名单限流、窗口、认证错误，防止所有错误被统一成可重试“不可用”。先用隔离测试账号，经受保护通道验收。
3. 将密钥注入服务器侧 resolver，不进入制品和日志；仅调整本项目服务的受控 HTTPS 出网，继续隔离共享主机上其他项目。GitHub Environment Secret 不会自动进入服务器服务。
4. 为业务账本、Holding 和 Receipt 接真实数据库，验证多进程唯一约束、原子领取、fencing、恢复与扣减。已有发布状态事务的证据不替代业务事务；处理上游成功但本地结果未落盘的“待确认”间隙。
5. 同步修改 bundle 清单、远端 broker 白名单和工作流；回读源码/制品/运行版本，并从真实 HTTP 入口取得 Provider 结果及 Receipt。存活探针、配置就绪和付费推理分开检查。
6. 在隔离 staging 实际演练 A→B→故障→A，检查在途请求、数据兼容和审计，再用测试账号、流量上限和可关闭入口逐步验证生产流量。

以上是可实施的待接入边界，不是固定的“不可执行”结论。每项以对应实测记录推进，用户确认后才记为 `ACCEPTED`。

## 验收边界

2026-10-06 17:00–17:59（Asia/Shanghai）的一小时预约已由用户授权并在 Billing 确认，基础价 USD 30，授权含税上限 USD 33.30；本次新账单尚未生成，不记录为已支付。预约回执和页面截图本地保存在 `work/kai-hour-key-contracts/evidence/dahono-provider/booking-20261006-1700.json` 与同名 `.jpg`。一次性线程任务 `dahono-17` 已安排 17:00 执行上述有界验收，窗口参数的排他结束时间为 18:00。当前状态是“已预约、待执行”，尚无本窗口容量结论。执行时先检查同窗口运行记录，避免重复触发；不会因 `not_proven` 自动重跑、续约或增加费用。

本计划完成后可以证明该 Provider adapter 和一次预约窗口内的真实模型调用。它仍不证明生产业务流量安全、数据库事务隔离、有效一次性执行，或坏制品触发的真实远端自动回滚；这些要按现有 staging 证据链分别验证。
