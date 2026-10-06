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
8. 执行 `staging:runtime:verify`，验证本地 loopback 服务能回读当前版本与摘要，并验证当前/上一制品槽位回滚；
9. 上传 JSON 证据、Provider Sandbox 证据、本地 HTTP Sandbox 证据、staging rehearsal、staging gate、staging target 证据和原始测试日志。

Dahono 模型池有两个独立的受保护入口：单次 `dahono:live:smoke` 和有界容量验收 `dahono:capacity:verify`。CI 验证二者在没有显式确认时不读取密钥、不出网并返回 `blocked`；实际执行使用对应手动工作流，由 `staging` 环境审批后注入 `DAHONO_API_KEY`。二者共享 `kai-dahono-live` 并发组，避免同仓库测试互相占用额度；外部调用仍需由操作者隔离。容量工作流要求已预约的精确起止时间，最多 14 次推理、2 次遥测读取、5 分钟、零自动重试。门禁或模拟测试通过不等于真实推理或容量通过。

npm run ci:verify 生成 evidence/ci/<run-id>.json、对应的 .log 和 LATEST.json。JSON 包含运行时间、Node/npm 版本、测试退出码、Git 修订（若当前目录属于 Git 仓库）以及排除生成目录后的源码 SHA-256 指纹。原始日志用于复核输出，JSON 用于机器读取。失败运行也会上传证据，避免只保留绿色结果。

## 证据判断

CI 的通过结论限定为：

> 在触发工作流的源码修订、Node 22、锁定依赖和 Ubuntu runner 上，npm test 返回退出码 0。

它不等同于真实 Provider、持久化存储、交易执行或生产部署已经通过。`staging-rehearsal`、`staging-gate-rehearsal` 和 `staging-runtime-rehearsal` 仍是本地故障、发布门禁、回滚和运行入口演练；真实 staging 另由受保护部署工作流和 `staging-remote` 证据证明。当前远端成功记录覆盖隔离服务、制品摘要、健康检查、当前/上一版识别和审计；回滚代码存在，但真实故障回滚仍需单独演练。`engines` 声明 Node 22 至 Node 24 的支持范围；当前远端工作流只运行 Node 22，本机 Node 24 结果单独记证，不能称为远端双版本矩阵。

用户验收层与内部证据分开：用户只看到 `可发布`、`已激活`、`已自动回滚` 或 `需要处理`；源码、锁文件、运行时、Provider、摘要和 gateId 由系统自动核对并保留在证据中。`可发布`只来自无副作用预检，真正写入成功后才显示 `已激活`。

事务存储的当前验证针对 `StagingTransactionalStorePort` 契约和本地 adapter；部署目标的当前验证针对 `StagingTargetPort` 和本地 dry-run adapter。它们都不证明任何具体云数据库、云平台或真实 staging。真实接入必须复用相同契约测试，并单独记录事务、fence、制品激活、健康检查、重启和回滚证据。

当前工作流已把 lint、TypeScript 类型检查和覆盖率阈值纳入通过条件。`npm audit --audit-level=high` 会同时检查运行时和开发依赖；它不是完整 SAST，仍需在安全工具和规则固定后另行接入。覆盖率阈值是合同包整体阈值，不代表每个文件都达到同一比例。

2026-10-05 起，真实远端证据已建立：GitHub contract CI run `37255589035` 成功，staging deploy run `37254995986` 的第 3 次尝试在 `staging` 环境经 `rong2qi` 审批后成功。部署目标是共享生产主机上的隔离服务，不代表整台主机或生产业务流量已被验证。脱敏记录见 `work/kai-hour-key-contracts/evidence/staging-remote/`。

2026-10-06 Dahono 有界容量入口切片：本地 `quality:verify` 通过 146/146 测试，行/分支/函数覆盖率分别为 93.75% / 78.77% / 93.60%，依赖审计 0 漏洞。原始日志为 `work/kai-hour-key-contracts/evidence/dahono-capacity/local-quality-20261006.log`。独立回读发现并修复 429 原因归因过度和测试覆盖正式证据文件两项问题，再次定向验证 14/14 通过。默认命令实测 `blocked`、未出网、未使用凭据；这些是离线实现证据，真实容量结果仍待新窗口。

## CD 的建议门禁

当前 staging 已有真实目标，CD 采用制品晋级流程：

- 仅允许从已上传的 CI 证据中选择 status=passed 且源码指纹匹配的制品；
- 在受保护环境中要求人工审批；
- 发布前后记录制品摘要、环境、版本、迁移状态和冒烟结果；
- 每个副本回读运行版本，确认运行制品与已批准摘要一致；
- 保留可回滚的上一制品和回滚结果。

这样可以把“测试通过”“制品可发布”和“生产运行正确”分成三个可独立核验的判断，避免用绿色 CI 代替部署或真实 Provider 验收。
