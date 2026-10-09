# CI/CD 验收与证据保留

## 当前可证明的范围

本工作空间当前可以自动证明合同包在指定源码状态下通过质量门和 Node 测试。工作流位于 .github/workflows/hour-key-contract-ci.yml，会：

1. 检出触发工作流的精确修订；
2. 用 package-lock.json 执行 npm ci；
3. 执行 `npm run quality:verify`，包含 ESLint、TypeScript 声明/类型示例检查及 `reservation-store.mjs` 的严格 `checkJs` 实现检查、Node 覆盖率门槛（行 90%、分支 75%、函数 90%）、`internal-provider-sandbox`、`local-http-sandbox` 验证和依赖安全审计，并保留 `quality.log`；
4. 执行 npm run ci:verify；
5. 执行 `staging:rehearsal:verify`，验证 fenced transaction、重启恢复和制品摘要接缝；
6. 执行 `staging:gate:verify`，验证制品清单、健康检查决策、自动回滚、无上一版阻断和 gate 幂等，并记录每个场景的摘要与检查结果；同时记录脱敏的用户结果投影；
7. 执行 `staging:target:verify`，验证可替换部署目标的检查、激活、健康失败和回滚生命周期；当前 adapter 明确是本地 dry-run，不是远程 staging；
8. 执行 `staging:runtime:verify`，验证本地 loopback 服务能回读当前版本与摘要，并验证当前/上一制品槽位回滚；
9. 上传 JSON 证据、Provider Sandbox 证据、本地 HTTP Sandbox 证据、staging rehearsal、staging gate、staging target 证据和原始测试日志。

Dahono 模型池有两个独立的受保护入口：单次 `dahono:live:smoke` 和有界容量验收 `dahono:capacity:verify`。CI 验证二者在没有显式确认时不读取密钥、不出网并返回 `blocked`；实际执行使用对应手动工作流，由 `staging` 环境审批后注入 `DAHONO_API_KEY`。二者共享 `kai-dahono-live` 并发组，避免同仓库测试互相占用额度；外部调用仍需由操作者隔离。容量工作流要求已预约的精确起止时间与回执 slot ID，证据只保存身份哈希；最多 14 次推理、2 次遥测读取、5 分钟、零自动重试。门禁或模拟测试通过不等于真实推理或容量通过。

2026-10-07 用户调整了后续顺序：先完成 Exchange 产品封装与不消耗供应商推理额度的验证，再从 Exchange 入口安排真实验收，详见[当前测试计划](DAHONO_MODEL_POOL_INTEGRATION_TEST.md#当前执行顺序先完成-exchange-封装再使用真实额度验收)。已有直连工作流及成功/失败证据保留；本次计划调整不启动 live、不预约、不自动扩大额度，也不把既有 CI 结果升级为产品完整验收。

npm run ci:verify 生成 evidence/ci/<run-id>.json、对应的 .log 和 LATEST.json。JSON 包含运行时间、Node/npm 版本、测试退出码、Git 修订（若当前目录属于 Git 仓库）以及排除生成目录后的源码 SHA-256 指纹。原始日志用于复核输出，JSON 用于机器读取。失败运行也会上传证据，避免只保留绿色结果。

## 证据判断

CI 的通过结论限定为：

> 在触发工作流的源码修订、Node 22、锁定依赖和 Ubuntu runner 上，npm test 返回退出码 0。

它不等同于真实 Provider、任意持久化后端、交易执行或生产部署已经通过。本轮 SQLite 本地磁盘与进程恢复的独立证明范围见下文。`staging-rehearsal`、`staging-gate-rehearsal` 和 `staging-runtime-rehearsal` 仍是本地故障、发布门禁、回滚和运行入口演练；真实 staging 另由受保护部署工作流和 `staging-remote` 证据证明。当前远端成功记录覆盖隔离服务、制品摘要、健康检查、当前/上一版识别和审计；回滚代码存在，但真实故障回滚仍需单独演练。`engines` 声明 Node 22 至 Node 24 的支持范围；当前远端工作流只运行 Node 22，本机 Node 24 结果单独记证，不能称为远端双版本矩阵。

用户验收层与内部证据分开：用户只看到 `可发布`、`已激活`、`已自动回滚` 或 `需要处理`；源码、锁文件、运行时、Provider、摘要和 gateId 由系统自动核对并保留在证据中。`可发布`只来自无副作用预检，真正写入成功后才显示 `已激活`。

事务存储的当前验证针对 `StagingTransactionalStorePort` 契约和本地 adapter；部署目标的当前验证针对 `StagingTargetPort` 和本地 dry-run adapter。它们都不证明任何具体云数据库、云平台或真实 staging。真实接入必须复用相同契约测试，并单独记录事务、fence、制品激活、健康检查、重启和回滚证据。

当前工作流已把 lint、TypeScript 类型检查和覆盖率阈值纳入通过条件。`npm audit --audit-level=high` 会同时检查运行时和开发依赖；它不是完整 SAST，仍需在安全工具和规则固定后另行接入。覆盖率阈值是合同包整体阈值，不代表每个文件都达到同一比例。

2026-10-05 起，真实远端证据已建立：GitHub contract CI run `37255589035` 成功，staging deploy run `37254995986` 的第 3 次尝试在 `staging` 环境经 `rong2qi` 审批后成功。部署目标是共享生产主机上的隔离服务，不代表整台主机或生产业务流量已被验证。脱敏记录见 `work/kai-hour-key-contracts/evidence/staging-remote/`。

2026-10-06 Dahono 有界容量入口切片：本地 `quality:verify` 通过 146/146 测试，行/分支/函数覆盖率分别为 93.75% / 78.77% / 93.60%，依赖审计 0 漏洞。原始日志为 `work/kai-hour-key-contracts/evidence/dahono-capacity/local-quality-20261006.log`。独立回读发现并修复 429 原因归因过度和测试覆盖正式证据文件两项问题，再次定向验证 14/14 通过。默认命令实测 `blocked`、未出网、未使用凭据；这些是离线实现证据，真实容量结果仍待新窗口。

对应远端 [contract CI run 37410477935](https://github.com/rong2qi/KAI-AI-Utility-Exchange/actions/runs/37410477935) 已成功，源码为 `a8fac380166b078613c242b8da69e2aafa4f17af`，Node `22.23.3`。质量门、测试和三项 live 门禁检查均成功；artifact `kai-hour-key-ci-evidence-37410477935-1`（ID `11388839326`）的 SHA-256 为 `17d7e21890213798420bc7846f4c3081b662549b5db45c46e7a529c7e11fa211`。已下载至 `work/kai-hour-key-contracts/evidence/ci/github-37410477935-artifact/`，回读测试状态与容量 guard 的未出网/未用凭据字段相符。因本切片没有更改服务器运行制品，自动触发且等待审批的重复部署 run `37410477934` 已取消；此前成功部署不受影响。

17 点受保护真实容量验收 [run 37440028834](https://github.com/rong2qi/KAI-AI-Utility-Exchange/actions/runs/37440028834) 已执行一次，源码 `2027450c7fd364276599e775f762e256e1f155d1` 的运行代码与上述已审核版本一致。离线检查通过，live 步骤结论 `failure`：十次请求本身均成功且匹配预约，但 `/models` 与 chat 的 slot 身份不一致，客户端十路重叠未观察到，故未发第十一路和后续样本。不能将 CI 成功替代这些尚未证明的容量边界。原始 live JSON SHA-256 为 `7b73255e52438d6d900496cc38954629e865ed8747529661c2eedd3a2ef20379`；artifact ID `11400224330`，摘要 `6d52b655683a3049186455f55c2ccbc5456035e0193666eb1a047ff26e69f629`，完整下载保存在 `work/kai-hour-key-contracts/evidence/dahono-capacity/artifacts-37440028834-1/`。执行文件指纹已独立重算匹配；原始证据同时报告 `workingTreeDirty=true`，因此不宣称 runner 整体工作树干净。具体结果和派生解释由 `work/kai-hour-key-contracts/evidence/dahono-capacity/LATEST-LIVE.json` 指向，原始失败记录不改写。

2026-10-06 离线判断拆分切片：实时采集与历史回放共用纯评估器，分别判断调用成功、预约绑定和发现接口一致性；小样本计数不再依赖先发过载请求。新增预约身份输入，错预约独立于数值诊断头触发取消，过载入场要求已知正确身份和有效诊断。独立回读复现并修复“不可能时间轴证明重叠”“坏统计头掩盖错预约”两项关联问题，再验证 38/38 定向测试通过，未发现遗留阻断。本机完整质量门 170/170 测试通过，行/分支/函数覆盖率 94.05% / 81.76% / 94.49%，lint、声明类型检查通过，依赖审计 0 漏洞；原始日志保存为 `work/kai-hour-key-contracts/evidence/dahono-capacity/local-quality-split-20261006.log`。

本片回放记录为 `work/kai-hour-key-contracts/evidence/dahono-capacity/replay-37440028834-split-v1.json`：使用上述未改写 live 原件及本地预约回执哈希，十次调用成功与预约绑定分别为 `proven`，发现接口身份一致性为 `failed`，整体为 `not_proven`；观察到的流重叠峰值仍为 7。记录绑定评估器 SHA-256，新增 Provider 请求为 0，不改写 `LATEST-LIVE.json` 或原始失败记录。该判断拆分不会追认真实十路重叠、第十一路 429、整小时额度或生产安全通过。用户验收状态仍待用户确认。

对应远端 [contract CI run 37444693813](https://github.com/rong2qi/KAI-AI-Utility-Exchange/actions/runs/37444693813) 已成功，固定源码 `c16872b98ef1fc1d60b19a1df15b25e641aadbe6`，Node `22.23.3`，170/170 测试与全部质量门通过，行/分支/函数覆盖率 96.79% / 85.99% / 94.53%。本地 Node `24.21.0` 结果单独记证，不称为远端双版本矩阵。三项真实调用入口均在未确认时保持门禁；容量 guard 为 `blocked`，出网/使用凭据均为 false。artifact `kai-hour-key-ci-evidence-37444693813-1`（ID `11402966993`）已下载至 `work/kai-hour-key-contracts/evidence/ci/github-37444693813-artifact/`，原始 ZIP 同目录旁以 `.zip` 保存，其实算 SHA-256 与 GitHub 摘要一致：`066a252e4799ad19593a3abc54d1570edf901c1c4706e7c40ba55433f76bc225`。已回读 JSON 和原始日志，87 文件包指纹 `aec496337816bcd342c268935efd504ce5f39c3c87d04564657ac4597a68b54d` 与 5 文件容量入口指纹均按当前固定源码重算匹配；runner 因生成证据报告 `workingTreeDirty=true`，不宣称其整棵工作树干净。此次仅触发合同 CI，无新增付费容量运行或 staging 部署。

## 2026-10-07 Exchange 本地业务入口切片

本片在 Exchange HTTP 入口组合账户/小时权益、Runtime、Usage Ledger 与固定 sandbox Provider。独立回读发现并修复最后单位双执行、异步读取跨小时放行、编码回执 ID 无法读取、其他 Grant 掩盖到期原因；补入正式回归。后续还修复质量命令经 `tee` 输出日志时的失败传播：显式 `pipefail`，防止日志保存步骤掩盖 lint/typecheck/audit 失败。

本机 Node 24.21.0 完整质量门：209/209 测试，覆盖率行/分支/函数 94.79% / 83.99% / 93.32%，lint、声明类型检查和依赖审计均通过（0 漏洞）。声明检查覆盖 `.d.ts`/类型示例，不表示全部 `.mjs` 已静态类型化。原始质量日志：`work/kai-hour-key-contracts/evidence/exchange-entry/local-quality-20261007.log`；209 测试原始证据：`evidence/ci/local-20261007024712457.json` 与同名 `.log`。

一键 Exchange 验收 `node scripts/exchange-sandbox-verify.mjs` 通过八项：错密钥、越权、输出+回执、幂等重放、内容冲突、耗尽、小时到期、到期后私有回执读取。只发生一次本地 Provider 执行，扣一个单位，生成一份回执；外部 Provider 调用为 0。证据仅保存白名单结果/计数、源码摘要、Node/Git 与工作区状态，不保存账户 Key、供应商密钥、模型输入输出或原始异常。真实 loopback HTTP 不写成完全禁网；CI 的新增独立步骤上传该证据目录。

对应远端 [contract CI run 37563812050](https://github.com/rong2qi/KAI-AI-Utility-Exchange/actions/runs/37563812050) 已通过，固定源码 `89ff521c5a79032b79fc90b43543b20692e9d793`，Node `22.23.3`，209/209 测试；行/分支/函数覆盖率 97.24% / 87.81% / 94.23%。新增 Exchange 八项验收全部通过，计数为 Provider 调用/执行各 1、余额 0、回执 1，均为本地合成场景。三项 live 门禁仍为 blocked；Dahono capacity evidence 中 networkAttempted/networkUsed/credentialsUsed/credentialResolved 均为 false，POST/GET 均为 0。

已下载并回读 artifact `kai-hour-key-ci-evidence-37563812050-1`（ID `11458575561`），ZIP 位于 `work/kai-hour-key-contracts/evidence/ci/github-37563812050-artifact.zip`，解包目录为同名无 `.zip` 路径。实算 SHA-256 `da1559d1a557373acf1d9c295117b8dda14c5f84f1ac964c198767652e12a285` 与 GitHub 摘要相符。回读了 `ci/quality.log`、该 run 的测试 JSON/原始日志、Exchange JSON 及三份 guard；96 个 Git 跟踪包文件重算指纹 `198ae3e1cbae05711b97c6c8116243487707d673d92b8a3d1fd946e7ffbd77e6` 与 CI 相符，Exchange 证据中的逐源文件摘要亦相符。本机完整目录另有未跟踪 `.DS_Store`，因此本机目录指纹与远端跟踪源码指纹分开记录；没有为匹配而改写原始证据。Runner 的 workingTreeDirty=true 来自生成证据，不称其整棵工作区干净。此次仅触发合同 CI，没有新增 staging 部署或真实供应商运行。

本片技术验证不自动记为用户 `ACCEPTED`。仅覆盖同进程、内存 sandbox、非流式结果与窗内幂等恢复；跨进程业务事务、同 Holding 并发、跨窗只结算恢复、真实 Provider、生产安全和真实 staging 回滚继续分别取证。当前部署制品未新增业务模块，没有本次部署动作。

## 2026-10-07 Exchange 业务额度预占切片

新增可替换 `ReservationStorePort`、`MemoryReservationStore` 与 `ReservationUsageLedger`，将操作唯一认领、额度预占及状态迁移放入同一存储边界。Exchange sandbox 已组合新账本；原 Ledger 保持串行兼容路径。余额满足 `available + reserved + committed = total`，Provider 网络调用位于短事务之外。

本机 Node 24.21.0 完整质量门通过 238/238 测试，行/分支/函数覆盖率为 95.43% / 84.94% / 93.42%，依赖审计 0 漏洞。`npm run typecheck` 现在同时检查声明、类型示例和新存储 `.mjs` 实现；`npx tsc -p tsconfig.reservations.json` 可单独复核该实现。两者均不代表所有旧 `.mjs` 已静态类型化。原始日志保存为 `work/kai-hour-key-contracts/evidence/exchange-entry/local-quality-reservations-20261007.log`。

正式回归覆盖共享同一 Store 的两个 Runtime、同 Holding 三路在途、同幂等键唯一调用、最后单位竞争、跨时窗拒绝/在途结算、未知结果保留预占、已知成功后的结算恢复、五个状态写入后的 ACK 丢失。独立回读发现非法 Receipt 曾先进入 Writer 才被 Store 拒绝；现通过 `receipt_prepared` 先验证并固定候选，再写外部回执，坏候选的 Writer 调用为 0。该反例和修复已加入正式回归。

一键 Exchange 验收保留原八项，并增加受控本地 Provider 的两路重叠与余额前后核对；显式同步门使重叠验证不依赖固定延迟。白名单证据只记录余额、计数和源码摘要，不输出模型正文、密钥、原始异常或私有 snapshot。本次无真实供应商调用、预约、部署或费用。

本片证明范围为同进程共享内存 Store 和内存 snapshot 重建协议。没有落盘数据库或跨进程事务/fencing；owner token + expected-state 是当前状态保护，不是分布式租约。未知上游结果仍需受保护的对账/恢复流程；过期后新的 Compute 仍被拒绝，独立跨窗恢复入口待后续实现。Provider 原生幂等、真实 staging 回滚和生产安全继续单独取证。技术验证通过不自动写为用户 `ACCEPTED`。

最终独立回读另复跑六组关键测试 49/49 通过。回读还移除了生产 `ReservationStorePort` 对同步 `snapshot()` 的要求，增加只有四个异步方法的类型验收；内存 snapshot 保留为具体 adapter 的私有能力。Receipt Writer 现在比较完整规范化候选，13 类冲突均拒绝且不覆盖原回执。上述修订已包含在最终本地 238 项测试中。

对应远端 [contract CI run 37579261793](https://github.com/rong2qi/KAI-AI-Utility-Exchange/actions/runs/37579261793) 已成功，固定源码 `e6bfd37701b30c16e8e4ec2d8dc7121e05b4792b`，Node `22.23.3`。质量门、严格存储实现类型检查、238/238 测试、原八项入口验收及新增两路并发预占验收全部通过；行/分支/函数覆盖率为 97.63% / 88.68% / 94.57%，依赖审计 0 漏洞。本地 Node 24 与远端 Node 22 分别记证，不称为远端双版本矩阵。三个 live guard 均为 blocked；本 run 的 Dahono capacity guard 记录四项出网/凭据标志均 false，POST/GET 为 0。

已下载并回读 artifact `kai-hour-key-ci-evidence-37579261793-1`（ID `11463891261`）。原始 ZIP 保存在 `work/kai-hour-key-contracts/evidence/ci/github-37579261793-artifact.zip`，解包目录为同名无 `.zip` 路径；实算 SHA-256 `1b3673d36208633cad33a105bd0eb590b7bc16545e5c70e2c80b203cd8cf88b3` 与 GitHub 摘要一致。已读取 `ci/quality.log`、该 run 测试 JSON/原始日志、Exchange JSON 和三份 guard；103 个 Git 跟踪包文件重算指纹 `7c72c93f429cadb9958cd32e2f553fa373a367bb1f81e0df31f38063cfbfbc73` 与 CI 相符，Exchange 32 份执行相关文件的逐文件摘要及总指纹亦匹配。预占证据为 `total=2, reserved=2, committed=0` 到 `reserved=0, committed=2`，外部 Provider 调用为 0。Runner 因生成证据报告 workingTreeDirty=true，不称其整棵工作区干净；artifact 中的历史 live 原件不是本次新增调用。此源码仅触发合同 CI，无新增部署或付费运行。

## 2026-10-09 SQLite 事务存储切片

2026-10-09 SQLite 事务存储片的本地质量门通过 249/249 测试，Node 24.21.0，行/分支/函数覆盖率 95.62% / 85.48% / 93.88%，依赖审计 0 漏洞。日志保存在 `work/kai-hour-key-contracts/evidence/exchange-entry/local-quality-sqlite-20261009.log`。新增验收采用真实 SQLite 磁盘文件、独立子进程、SQL 写入失败以及九阶段 SIGKILL 后新进程恢复；HTTP 重建后返回同结果，Provider 总调用一次。结果未知仍保留预占，不自动恢复上游调用。详见 [存储契约与边界](SQLITE_RESERVATION_STORAGE.md)。这不证明物理掉电、多机数据库/fencing、Agent 隔离或真实供应商容量；本次 MixRoute 只登记公开信息，未调用。

独立 Standards / Spec 回读均发现同一 P2：完成态聚合重放未复核持久回执行，可能掩盖回执丢失或篡改。新增正式反例先复现失败，再修复为同一事务校验回执存在、状态、ID 和完整内容；定向回归及全量质量门通过。损坏回执不触发 Provider 重调。

## CD 的建议门禁

当前 staging 已有真实目标，CD 采用制品晋级流程：

- 仅允许从已上传的 CI 证据中选择 status=passed 且源码指纹匹配的制品；
- 在受保护环境中要求人工审批；
- 发布前后记录制品摘要、环境、版本、迁移状态和冒烟结果；
- 每个副本回读运行版本，确认运行制品与已批准摘要一致；
- 保留可回滚的上一制品和回滚结果。

这样可以把“测试通过”“制品可发布”和“生产运行正确”分成三个可独立核验的判断，避免用绿色 CI 代替部署或真实 Provider 验收。
