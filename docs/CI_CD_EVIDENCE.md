# CI/CD 验收与证据保留

## 当前可证明的范围

本工作空间当前可以自动证明合同包在指定源码状态下通过质量门和 Node 测试。工作流位于 .github/workflows/hour-key-contract-ci.yml，会：

1. 检出触发工作流的精确修订；
2. 用 package-lock.json 执行 npm ci；
3. 执行 `npm run quality:verify`，包含 ESLint、TypeScript 声明检查、Node 覆盖率门槛（行 90%、分支 75%、函数 90%）、`internal-provider-sandbox`、`local-http-sandbox` 验证和生产依赖安全审计，并保留 `quality.log`；
4. 执行 npm run ci:verify；
5. 执行 `staging:rehearsal:verify`，验证 fenced transaction、重启恢复和制品摘要接缝；
6. 执行 `staging:gate:verify`，验证制品清单、健康检查决策、自动回滚、无上一版阻断和 gate 幂等，并记录每个场景的摘要与检查结果；同时记录脱敏的用户结果投影；
7. 执行 `staging:target:verify`，验证可替换部署目标的检查、激活、健康失败和回滚生命周期；当前 adapter 明确是本地 dry-run，不是远程 staging；
8. 上传 JSON 证据、Provider Sandbox 证据、本地 HTTP Sandbox 证据、staging rehearsal、staging gate、staging target 证据和原始测试日志。

npm run ci:verify 生成 evidence/ci/<run-id>.json、对应的 .log 和 LATEST.json。JSON 包含运行时间、Node/npm 版本、测试退出码、Git 修订（若当前目录属于 Git 仓库）以及排除生成目录后的源码 SHA-256 指纹。原始日志用于复核输出，JSON 用于机器读取。失败运行也会上传证据，避免只保留绿色结果。

## 证据判断

CI 的通过结论限定为：

> 在触发工作流的源码修订、Node 22 和 Node 24 矩阵、锁定依赖和 Ubuntu runner 上，npm test 返回退出码 0。

它不等同于真实 Provider、持久化存储、交易执行或生产部署已经通过。`staging-rehearsal` 和 `staging-gate-rehearsal` 都只是本地故障、发布门禁和回滚接缝演练，不等同于真实 staging。当前工作空间没有真实部署目标，也没有可验证的远端 CI 运行记录；本地运行产生的证据只能证明本地源码状态。`engines` 声明 Node 22 至 Node 24 的支持范围，矩阵用于验证最低和当前支持版本。

用户验收层与内部证据分开：用户只看到 `可发布`、`已激活`、`已自动回滚` 或 `需要处理`；源码、锁文件、运行时、Provider、摘要和 gateId 由系统自动核对并保留在证据中。`可发布`只来自无副作用预检，真正写入成功后才显示 `已激活`。

事务存储的当前验证针对 `StagingTransactionalStorePort` 契约和本地 adapter；部署目标的当前验证针对 `StagingTargetPort` 和本地 dry-run adapter。它们都不证明任何具体云数据库、云平台或真实 staging。真实接入必须复用相同契约测试，并单独记录事务、fence、制品激活、健康检查、重启和回滚证据。

当前工作流已把 lint、TypeScript 类型检查和覆盖率阈值纳入通过条件。`npm audit --audit-level=high` 会同时检查运行时和开发依赖；它不是完整 SAST，仍需在安全工具和规则固定后另行接入。覆盖率阈值是合同包整体阈值，不代表每个文件都达到同一比例。

## CD 的建议门禁

当前不添加没有真实目标的自动发布。接入部署环境后，CD 应采用制品晋级流程：

- 仅允许从已上传的 CI 证据中选择 status=passed 且源码指纹匹配的制品；
- 在受保护环境中要求人工审批；
- 发布前后记录制品摘要、环境、版本、迁移状态和冒烟结果；
- 每个副本回读运行版本，确认运行制品与已批准摘要一致；
- 保留可回滚的上一制品和回滚结果。

这样可以把“测试通过”“制品可发布”和“生产运行正确”分成三个可独立核验的判断，避免用绿色 CI 代替部署或真实 Provider 验收。
