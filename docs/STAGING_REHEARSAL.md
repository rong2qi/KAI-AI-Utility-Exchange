# Staging rehearsal 分层说明

## 用户能感知到的目标

这层验证的是：请求重试、进程重启或发布失败时，用户仍得到一个明确结果；额度不会因为旧 worker 的迟到写入而重复扣减；新制品健康检查失败时，可以回到上一份摘要匹配的制品。

## 当前 rehearsal

`staging:rehearsal:verify` 在不出网的条件下验证三条可观察行为：

1. 新 worker 获得更高 fence 后，旧 worker 的事务提交被拒绝；
2. Receipt 写入暂时失败后重启 Ledger，已记录的 Provider 结果和 Holding 状态不会重复执行；
3. 发布制品按 SHA-256 摘要激活，摘要不匹配时拒绝回滚，匹配时记录回滚历史。

它使用可丢弃的 JSON Ledger 和进程内 fenced transaction model，证据等级固定为 `staging-rehearsal`，并记录 `networkDisabled=true`、`realStagingProof=false`、`productionProof=false`。这证明本项目的故障恢复和发布控制接缝，不证明云数据库、真实 staging、每个副本或生产回滚已经通过。

运行：

```text
npm run staging:rehearsal:verify
```

证据写入 `work/kai-hour-key-contracts/evidence/staging-rehearsal/`，包含 JSON 指针和原始测试日志。真实 staging 仍需要事务数据库、受保护环境、真实 Provider 沙盒、部署制品、健康检查、回滚权限和人工审批。
