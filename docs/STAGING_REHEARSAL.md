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

事务存储接口是 `StagingTransactionalStorePort`：只暴露 `snapshot()` 和带 fence token 的 `transact()`。当前 `StagingTransactionalStore` 是本地 adapter；真实数据库 adapter 必须在同一事务内完成 fence 校验和 mutator 提交，并通过相同契约测试后才能接入。

部署目标接口是 `StagingTargetPort`：它把“目标检查、激活、健康检查、回滚”固定为可替换接缝，平台身份、凭据和部署细节留在 adapter 内。当前 `LocalStagingTarget` 只做本地 dry-run，始终报告 `networkDisabled=true`、`realStagingProof=false`；它证明目标生命周期的调用顺序和审计形状，不证明任何远程 staging。接入真实目标前，需要目标身份、制品上传/激活权限、健康检查地址、回滚权限和受保护环境审批，并复用相同端口测试记录独立证据。

它使用可丢弃的 JSON Ledger 和进程内 fenced transaction model，证据等级固定为 `staging-rehearsal`，并记录 `networkDisabled=true`、`realStagingProof=false`、`productionProof=false`。这证明本项目的故障恢复和发布控制接缝，不证明云数据库、真实 staging、每个副本或生产回滚已经通过。

运行：

```text
npm run staging:rehearsal:verify
npm run staging:gate:verify
npm run staging:target:verify
npm run staging:runtime:verify
```

`staging:runtime:verify` 另外验证本地 loopback 服务能报告当前版本和摘要，且双制品槽位回滚后恢复上一版本。所有本地证据都固定记录 `networkDisabled=true`、`realStagingProof=false`、`productionProof=false`；真实 staging 仍需要事务数据库、受保护环境、真实 Provider 沙盒、部署制品、健康检查、回滚权限和人工审批。
