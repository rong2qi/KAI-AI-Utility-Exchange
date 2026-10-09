# KAI Hour Key Runtime：架构基线

2026-10-09 存储补充：共享预占规则提取为同步 `ReservationStateMachine`，内存 adapter 与可选 `SqliteReservationStore` 共用；SQLite 实现同机跨进程的数据库认领、余额及回执事务，契约/运行条件与证据范围见 [事务存储说明](../docs/SQLITE_RESERVATION_STORAGE.md)。其 JSON 聚合和单写者特性需在生产规模前另行评估。独立跨窗恢复、待确认对账、多机 fencing 和 [Agent 文件/网络联合隔离](../docs/AGENT_ISOLATION_PLAN.md) 仍分别建设，不能把 SQLite 进程测试当作这些能力已完成。

设计基线：以正式上线所需的接口、事实来源和验收条件组织实现；真实行情由 KAI 封装成小时权益，账户 Key 持续有效。  
本地证据：契约、纯策略、内存 Runtime、行情投影与共享进程内预占 Store 已有测试；供应商实测、真实账户履约和持久化接入分别保留各自运行证据，不互相替代。
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
  ├─ Reservation Store Port  # 执行认领、额度预占与持仓提交属于同一原子事实
  ├─ Provider Adapter Port   # 供应商执行适配器
  ├─ Usage Port              # 用量事实
  └─ Receipt Port            # 私有回执与公共脱敏证明

Adapters（实现层）
  ├─ Reference Market Adapter → pricing.kai.com/v1（只读真实行情、hourKeyStatus=unpackaged）
  ├─ Hour Key Packaging Adapter → 保留行情事实、幂等推进 hourKeyStatus
  ├─ Hour Key Packaging Store → 持久化 (account_id, idempotency_key) 唯一事实
  ├─ KaiKey Trade/Holding Adapter
  ├─ Usage Execution Ledger Store → 记录 request_hash 与状态跃迁
  ├─ Memory Reservation Store → 进程内共享预占、持仓余额与执行认领
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
- `server_now >= slot_end` 拒绝发起新的 Compute；窗内已准入且在途的调用可以完成结算，不追加 Provider 请求。
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

供应商 Adapter 只负责把统一的 `ComputeRequest` 转换为供应商请求并返回统一的 `ProviderUsage`；它接收由 Usage Execution Ledger 传入的幂等 Token，不负责意图判断、Key 授权、持仓扣减或手续费计算。兼容的旧 Usage Execution Ledger 保留 `started → provider_succeeded → holding_consumed → receipt_committed` 状态和 Runtime 内串行保护。新 Reservation Usage Ledger 通过独立预占端口实现下述八状态；两条路径共同满足业务返回 interface，真实 Provider 不承诺幂等时均不宣称外部 exactly-once。

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

第一片的旧 ledger 继续由 Runtime 以 Holding 串行保护。2026-10-07 预占片新增 `ReservationUsageLedger` 与 `MemoryReservationStore`，默认 sandbox 已改用该组合：同一 Store 以短原子操作同时记录唯一执行认领和额度预占，随后释放事务执行 Provider；有足额权益的同 Holding 请求可以在同一 Runtime 及多个 Runtime 实例间并发。只有服务端注入的 ledger 声明 `admissionMode='atomic-reservation'` 才选择此路径，请求 JSON 不能开启它。调用 Provider 前仍重新核对当前权限、时窗及 Holding 绑定。账户 Key 和小时 Grant 分开到期；到期、撤销和真正资源越权分别判断，不让不相关 Grant 掩盖当前失败原因。

预占状态共八种：

```text
reserved → dispatching → provider_succeeded → committed → receipt_prepared → receipt_committed
    └────────┴─→ released        # 仅 ledger 已确认没有调用 Provider 的本地拒绝
             └─→ uncertain      # 结果未知，继续占用预占额度
```

余额遵守 `total = available + reserved + committed`。Holding 的 `unitsRemaining` 含预占量，真实可用量为 `unitsRemaining - reserved`；提交只扣减一次，释放不扣减持仓。异常、超时或上游成功但结果未记录时保留在 `dispatching/uncertain`，不自动释放或重新发送。`receipt_prepared` 在写外部 Receipt 前固定已验证的账户、权益、请求和用量候选，外部 writer 返回值还须与候选一致；此阶段已经提交用量，不重复预占或扣减。

当前验证覆盖共享进程内 Store、多 Runtime 同幂等键唯一调用、足额调用真实重叠、最后单位竞争、跨窗准入检查、在途完成与恢复候选。内存 adapter 的 `snapshot()` 仅深复制私有状态并在重建时检查记录/余额/绑定一致性，包含 Provider 私有正文，不进入公共证据；它不是生产端口的必需方法，不写磁盘，也不证明持久化或跨进程 fencing。生产下一步是异步事务存储适配器与结果待确认/结算恢复接缝，分别验证唯一约束、状态竞争、崩溃恢复和对账；Receipt writer 需按账户/幂等键原子写入或返回同一已验证候选。已在途调用跨窗结算已验证；新的跨窗恢复 HTTP 入口与其独立授权尚待实现，不能重新开放过期 Compute。

本片完成技术验证，等待用户验收确认，不自动记录 `ACCEPTED`。主类型检查已对 `src/reservation-store.mjs` 开启 strict `checkJs`，同时保留领域声明检查；这不表示所有 `.mjs` 实现已静态类型化。下一步继续本地及隔离环境取证，不产生新预约或供应商费用。

边界：此片 HTTP 只监听 `127.0.0.1`；非流式、合成预授权权益、内存记录、无真实成交/支付。旧 Ledger 无 binding 时失败关闭，持久化升级需可信数据迁移。没有本次生产或共享主机变更。
