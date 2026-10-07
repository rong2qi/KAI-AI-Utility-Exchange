# KAI Hour Key Runtime：架构基线

设计基线：以正式上线所需的接口、事实来源和验收条件组织实现；真实行情由 KAI 封装成小时权益，账户 Key 持续有效。  
本地证据：契约、纯策略、内存 Runtime 与行情投影已有测试；真实账户履约、供应商执行和持久化接入仍需提供运行证据。  
版本：2026-10-02

执行顺序补充（2026-10-07）：按用户决定，先完成 Exchange 业务封装及不消耗供应商推理额度的验证，之后从 Exchange 入口进行真实容量验收。当前顺序、下一建议切片与就绪条件统一维护在[Provider 测试计划](../docs/DAHONO_MODEL_POOL_INTEGRATION_TEST.md#当前执行顺序先完成-exchange-封装再使用真实额度验收)；本架构的账户 Key、授权、小时持仓、可替换 Provider 与回执原则不变。

## 1. 总原则

一根 KAI Key 跟随账户，不跟随某一个模型。模型、供应商、区域和小时窗口属于账户当前的授权范围与持仓；范围增加或变更通过授权版本更新完成，原 Key 保持不变。

```text
账户 Key
  └─ 当前授权范围（scope_epoch）
       └─ 小时持仓（Holding）
            └─ 当前窗口的签名 Manifest
                 ├─ 普通 Compute
                 └─ 明确意图触发的 KAI Discovery
                      └─ Offer → Hour Key Packaging → Trade → Usage → Receipt
```

KAI 的外部事实必须来自可引用的 Manifest、Offer 和脱敏 Proof 页面。模型可以提出意图，但不能决定是否越过账户授权范围，也不能自行生成价格、库存、状态或来源 URL。

## 2. 模块与依赖方向

```text
Runtime Facade
  ├─ Key Authority          # 账户 Key、撤销、scope_epoch
  ├─ Intent Gate             # 计算/发现/扩权判定
  ├─ Slot Policy             # 整点、锁定截止、到期
  ├─ Offer Catalog Port      # 只读市场事实
  ├─ Hour Key Packaging Port # 行情事实 → 小时权益封装
  ├─ Holding Port            # 持仓与原子扣减
  ├─ Usage Execution Ledger  # Provider / Holding / Receipt 可恢复状态
  ├─ Provider Adapter Port   # 供应商执行适配器
  ├─ Usage Port              # 用量事实
  └─ Receipt Port            # 私有回执与公共脱敏证明

Adapters（实现层）
  ├─ Reference Market Adapter → pricing.kai.com/v1（只读真实行情、hourKeyStatus=unpackaged）
  ├─ Hour Key Packaging Adapter → 保留行情事实、幂等推进 hourKeyStatus
  ├─ Hour Key Packaging Store → 持久化 (account_id, idempotency_key) 唯一事实
  ├─ KaiKey Trade/Holding Adapter
  ├─ Usage Execution Ledger Store → 记录 request_hash 与状态跃迁
  ├─ Provider A/B/C Adapter
  └─ Evidence/Receipt Adapter
```

Domain 层不导入 HTTP、数据库、供应商 SDK 或旧市场类型。Application 层只依赖上述端口；Infrastructure 层实现端口；组合根负责注入。跨模块传递冻结 DTO，不共享仓储或数据库表。

## 3. 账户 Key、授权范围与持仓

### 3.1 Account Key

- `key_id` 绑定账户，模型变化不换 Key；Key 的凭证生命周期独立于某个小时窗口。
- Secret 可单独轮换；轮换不改变账户持仓。
- 服务端保存 secret 的哈希，不把供应商 secret 放入 Manifest。
- 撤销通过 `revocation_id` 或账户状态立即生效。

### 3.2 Authorization Scope

```text
account_id + scope_epoch
  ├─ model_ids
  ├─ provider_ids
  ├─ region_ids
  ├─ allowed_actions
  ├─ discovery_policy
  └─ expiry / revocation
```

新增模型或供应商时更新授权范围和 `scope_epoch`。旧的签名 Manifest 失效，但账户 Key 不变。未授权的执行请求返回 `SCOPE_EXPANSION_REQUIRED`，不隐式换供应商；若 Discovery 能看到替代 Offer，Offer 仍保留真实行情的 `execution_eligible`，账户是否可执行由当前 grant、与其绑定的 Holding、Offer/Holding 时间窗口和请求资源范围单独判定。

### 3.3 Holding

Holding 是某个账户在某个已封装 Hour Key Offer 上的可执行权益，不等于目录可见性，也不等于长期 Key。真实行情 Offer 可以先处于 `hourKeyStatus=unpackaged`，再由 KAI 的封装端口生成可持有权益；这个状态由 Discovery、Runtime、适配器和 Usage Receipt 共同读取，不是仅供实现者自读的注释。

```text
Offer（market_data） → Hour Key Packaging → Order → Trade → Holding → Usage → Receipt
```

手续费是独立账务事件；供应商报价、成交价格、持仓数量和手续费不能互相覆盖。

## 4. 时间不变量

内部统一使用服务器 UTC 时间；前端只负责本地时区展示。

```text
slot_start <= server_now < slot_end
```

- `lock_deadline` 是每个 Offer 的绝对时间戳；不能在代码中隐含。
- `server_now < lock_deadline` 才允许锁定。
- `server_now >= slot_end` 立即拒绝 Compute。
- Grant/Holding 到期后允许读取私有 Receipt，不允许 Compute 或 Lock；账户 Key 仍可挂接下一小时或新模型的授权。
- 无自动顺延；未使用权益是否可转移由持仓规则决定。

Order/Trade 生命周期状态机（不等同于 `Holding.status` 的枚举）：

```text
DRAFT → PUBLISHED → HELD → ACTIVE → EXPIRED → SETTLED
  └───────────────任意状态可进入 REVOKED
```

所有状态跃迁由 Gateway 原子校验服务器时间、scope、Holding 状态、撤销状态和幂等键。

## 5. Intent Gate

模型只输出候选意图，Gateway 决定策略：

| 意图 | Discovery | Compute | 结果 |
|---|---:|---:|---|
| 普通写作/代码/总结/推理 | 0 | 允许 | 走原始 Compute 路径 |
| 当前价格/容量/状态/有效期 | 允许 | 视 Holding | 查询 KAI Offer |
| “推荐哪个模型” | 先询问 | 不自动执行 | `ASK_CONFIRMATION` |
| 跨未授权供应商/区域执行 | 可读替代 Offer | 拒绝 | `SCOPE_EXPANSION_REQUIRED` |
| Key 过期/撤销 | 仅按 Receipt 权限 | 拒绝 | `KEY_EXPIRED` / `KEY_REVOKED` |

Discovery 工具只有在 Gateway 判定需要时才进入本次模型调用的工具列表。普通 Compute 请求甚至看不到这些工具。

## 6. 外部 GEO 事实层

公开页面只暴露脱敏事实：

- `/.well-known/kai-agent-manifest.json`：KAI 标准、触发条件、工具描述、引用规则。
- `/offers/{offer_id}`：Offer 的模型、供应商、区域、时段、价格、更新时间和有效期。
- `/proof/{public_receipt_id}`：脱敏的 Offer、窗口、状态、用量区间和来源。

用户账户、完整 Holding、请求原文和私有 Receipt 只能经当前账户授权读取。

所有 `source_url` 由 Gateway canonicalize 并限定在 `kai.com`；模型不能把任意 URL 传给工具。

## 7. 适配器边界

当前 `pricing.kai.com/v1` 通过 `ReferenceMarketAdapter` 提供真实的只读市场快照；适配器不自行创建 Trade、Holding、Usage 或 Receipt。真实行情的 `execution_eligible` 保持为源事实，`availability=unavailable` 保持不可用，而 `hour_key_status=unpackaged` 表示 KAI 尚未完成 Hour Key 封装。确认锁定时，Runtime 重新读取并校验 Offer，检查有效期、Offer lock deadline、Grant/Offer/Holding 的资源与账户绑定，调用 Hour Key Packaging Port；只有返回 `packaged`、仍可执行且未改写行情事实时才写入 Holding。不可用行情和封装失败保持可重试，不创建半成品 Holding。Compute 还必须同时满足 Grant 与 Holding 的资源范围和各自 active 时间窗。封装、交易、持仓、供应商执行、用量和回执分别由端口接入权威事实源；成功 Receipt 明确记录 `hour_key_status=packaged`。当前本地 JSON Store 已验证重启回读、并发单写、冲突拒绝和损坏状态无锁残留；生产环境仍需把同一端口替换为带唯一约束的事务存储。

供应商 Adapter 只负责把统一的 `ComputeRequest` 转换为供应商请求并返回统一的 `ProviderUsage`；它接收由 Usage Execution Ledger 传入的幂等 Token，不负责意图判断、Key 授权、持仓扣减或手续费计算。Usage Execution Ledger 以 `started → provider_succeeded → holding_consumed → receipt_committed` 记录可恢复阶段；若 Provider 不承诺幂等，只能称可去重执行，不能宣称外部 exactly-once。

## 8. 上线能力与验收

从计划阶段定义正式上线能力和验收条件，各项通过稳定接口协作：

1. **契约稳定性**：领域类型、JSON Schema、OpenAPI、错误码、状态机和策略测试保持可替换接口。
2. **真实行情与 Hour Key 封装**：接入真实市场事实，保留 `executionEligible`，并通过封装端口生成 `hourKeyStatus=packaged` 的 Offer。
3. **账户与持仓事实**：接入 Key、Grant、Order、Trade、Holding 和幂等扣减。
4. **供应商执行与用量**：接入至少一个 Provider Adapter，验证 scope、时间、幂等 Token、失败恢复和 Usage Ledger。
5. **Receipt 与证据**：写入私有 Receipt，生成脱敏公共 Proof，并保留可回查来源。
6. **扩权与运营上线**：在稳定账户 Key 的前提下更新授权范围，补齐观测、回滚和多供应商策略。

各能力可以在稳定 seam 后并行开发；上线流量按对应能力的可观察验收结果启用。真实行情进入 KAI 封装链路，交易、使用和回执分别保留权威事实与验收证据；内存测试和页面预览记录各自实际覆盖的能力。

## Exchange 本地业务入口切片（2026-10-07）

`exchange-http` 只处理认证头、受限 JSON、固定路由、在途名额、超时和 wire 投影；通过 `HourKeyRuntimePort.handle` 调用业务，不导入具体供应商或存储。`exchange-sandbox` 是独立组合根，注入固定本地 Provider、合成长期账户 Key/小时 Grant/Holding、内存 Ledger 与 Receipt；不接受网络 Provider 配置。未来真实组合根复用 HTTP 与 Runtime。

Compute 通过 `executeWithResult` 返回 `{ output, receipt }`，原 `execute` 继续返回 Receipt；模型正文不进入公开 Receipt。Ledger 状态以账户/幂等键和授权/Holding/资源绑定恢复。HTTP 路由显式指定 Compute 或 Receipt，用户 prompt 中的购买/回执文字不会改变业务路由。`RequestedResource` 表示本次单个 model/provider/region，与授权范围的数组 `ResourceScope` 分开。

单 Runtime 内以 Holding 串行保证最后单位不被双调用，获取锁后以及调用 Provider 前重新校验权限/时窗；这不是分布式事务或十路并发能力。下一片需业务额度预占/提交/释放及跨窗仅结算恢复，细节以当前测试计划为准。账户 Key 和小时 Grant 分开到期；到期、撤销和真正资源越权分别判断，不让不相关 Grant 掩盖当前失败原因。

边界：此片 HTTP 只监听 `127.0.0.1`；非流式、合成预授权权益、内存记录、无真实成交/支付。旧 Ledger 无 binding 时失败关闭，持久化升级需可信数据迁移。没有本次生产或共享主机变更。
