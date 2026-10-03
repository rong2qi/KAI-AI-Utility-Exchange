# CI/CD 验收与证据保留

## 当前可证明的范围

本工作空间当前可以自动证明合同包在指定源码状态下通过质量门和 Node 测试。工作流位于 .github/workflows/hour-key-contract-ci.yml，会：

1. 检出触发工作流的精确修订；
2. 用 package-lock.json 执行 npm ci；
3. 执行 `npm run quality:verify`，包含 ESLint、TypeScript 声明检查、Node 覆盖率门槛（行 90%、分支 75%、函数 90%）和生产依赖安全审计，并保留 `quality.log`；
4. 执行 npm run ci:verify；
5. 上传 JSON 证据和原始测试日志。

npm run ci:verify 生成 evidence/ci/<run-id>.json、对应的 .log 和 LATEST.json。JSON 包含运行时间、Node/npm 版本、测试退出码、Git 修订（若当前目录属于 Git 仓库）以及排除生成目录后的源码 SHA-256 指纹。原始日志用于复核输出，JSON 用于机器读取。失败运行也会上传证据，避免只保留绿色结果。

## 证据判断

CI 的通过结论限定为：

> 在触发工作流的源码修订、Node 22 和 Node 24 矩阵、锁定依赖和 Ubuntu runner 上，npm test 返回退出码 0。

它不等同于真实 Provider、持久化存储、交易执行或生产部署已经通过。当前工作空间没有真实部署目标，也没有可验证的远端 CI 运行记录；本地运行产生的证据只能证明本地源码状态。`engines` 声明 Node 22 至 Node 24 的支持范围，矩阵用于验证最低和当前支持版本。

当前工作流已把 lint、TypeScript 类型检查和覆盖率阈值纳入通过条件。`npm audit --audit-level=high` 会同时检查运行时和开发依赖；它不是完整 SAST，仍需在安全工具和规则固定后另行接入。覆盖率阈值是合同包整体阈值，不代表每个文件都达到同一比例。

## CD 的建议门禁

当前不添加没有真实目标的自动发布。接入部署环境后，CD 应采用制品晋级流程：

- 仅允许从已上传的 CI 证据中选择 status=passed 且源码指纹匹配的制品；
- 在受保护环境中要求人工审批；
- 发布前后记录制品摘要、环境、版本、迁移状态和冒烟结果；
- 每个副本回读运行版本，确认运行制品与已批准摘要一致；
- 保留可回滚的上一制品和回滚结果。

这样可以把“测试通过”“制品可发布”和“生产运行正确”分成三个可独立核验的判断，避免用绿色 CI 代替部署或真实 Provider 验收。
