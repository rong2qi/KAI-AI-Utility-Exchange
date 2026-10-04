# Staging rehearsal 分层说明

## 用户能感知到的目标

这层验证的是：请求重试、进程重启或发布失败时，用户仍得到一个明确结果；额度不会因为旧 worker 的迟到写入而重复扣减；新制品健康检查失败时，可以回到上一份摘要匹配的制品。用户只需要发起一次发布或预检，系统自动取得制品、执行检查和获取写入租约。

用户结果只返回四种状态：`可发布`（预检没有副作用）、`已激活`（发布成功）、`已自动回滚`（新版本失败但旧版本恢复成功）和 `需要处理`（门禁或基础设施暂时无法确认）。版本号可以展示给用户；源码提交、锁文件摘要、Node 范围、Provider 模型、gateId 和逐项检查留在后台证据。

## 当前 rehearsal

`staging:rehearsal:verify` 在不出网的条件下验证基础恢复接缝，`staging:gate:verify` 验证发布门禁接缝。

基础 rehearsal 验证三条可观察行为：

1. 新 worker 获得更高 fence 后，旧 worker 的事务提交被拒绝；
2. Receipt 写入暂时失败后重启 Ledger，已记录的 Provider 结果和 Holding 状态不会重复执行；
3. 发布制品按 SHA-256 摘要激活，摘要不匹配时拒绝回滚，匹配时记录回滚历史。

发布门禁 rehearsal 还验证：

1. 制品必须带有版本、源码提交、源码指纹、锁文件摘要、Node 范围、Provider 模型和制品摘要；摘要不匹配时不进入门禁；
2. 必需检查全部通过才激活，非必需 warning 不阻断；
3. 必需检查失败时回滚到摘要匹配的上一份制品，没有已验证上一份时阻断；
4. 同一个 gateId 重复提交不会重复写审计历史。

`StagingReleaseFacade.preview({ version })` 和 `StagingReleaseFacade.publish({ version })` 是用户入口；它们把 manifest、health checks 和 fence token 的取得封装在系统内部。`release()` 与 `releaseForUser()` 仍是内部控制器和脱敏投影，不能把内部结果当成用户操作清单。

它使用可丢弃的 JSON Ledger 和进程内 fenced transaction model，证据等级固定为 `staging-rehearsal`，并记录 `networkDisabled=true`、`realStagingProof=false`、`productionProof=false`。这证明本项目的故障恢复和发布控制接缝，不证明云数据库、真实 staging、每个副本或生产回滚已经通过。

运行：

```text
npm run staging:rehearsal:verify
npm run staging:gate:verify
```

证据分别写入 `work/kai-hour-key-contracts/evidence/staging-rehearsal/` 和 `work/kai-hour-key-contracts/evidence/staging-gate/`，包含 JSON 指针和原始测试日志。staging-gate 场景同时记录脱敏的 `userOutcome`；完整 gate 字段只用于后台复核。两类证据都固定记录 `networkDisabled=true`、`realStagingProof=false`、`productionProof=false`；真实 staging 仍需要事务数据库、受保护环境、真实 Provider 沙盒、部署制品、健康检查、回滚权限和人工审批。
