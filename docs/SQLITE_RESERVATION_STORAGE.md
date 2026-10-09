# SQLite 业务事务存储与恢复

日期：2026-10-09。范围：真实本地磁盘数据库、同一主机独立进程、合成 Provider、可替换 ReservationStorePort。技术验证不自动等于用户 ACCEPTED。

## 契约与目标

原子保存操作认领与额度预占；已保存成功结果后可恢复提交及回执，不重复调用或扣量；结果未知继续保留预占。数据库/进程重开不能重新发放初始化额度。验收必须实际使用独立子进程和 SIGKILL，而不以对象重建代替崩溃恢复；明确进程崩溃与物理掉电不同。

实现为 `src/adapters/sqlite-reservation-store.mjs`。`ReservationStateMachine` 提取原有同步规则，内存与 SQLite adapter 共用，不复制状态迁移逻辑。HTTP、Runtime 和 Ledger 的公开业务调用方式不变。生产端口仍无同步 snapshot 要求；SQLite 内部按 Holding 保存版本化状态，另以 SQL 表约束账户/幂等键唯一性及回执身份。

## 使用与运行条件

这是一个可选的本地磁盘 adapter，支持本机 macOS 与 Linux；需要带 `node:sqlite` 的 Node 22.13+（本项目 Node 22/24 验证范围）。不是最终生产数据库选型，未部署至共享生产主机。Windows 权限适配、多主机数据库与网络文件系统另行接入，不将此 adapter 的平台限制扩散到业务接口。Node 22 的该内置模块处于实验阶段；不引入第三方运行时包，升级 Node 需复跑契约与故障测试。

路径必须是绝对路径，父目录已存在、归当前服务用户、权限 0700，数据库文件 0600；拒绝文件符号链接、硬链接和宽权限文件。SQLite WAL/SHM 文件处于同一私有目录。权限阻止其他普通 OS 用户读取，不抵御同 UID、root 或宿主被攻破；数据未做应用层加密，磁盘/备份密钥管理属于部署要求。Agent 工作进程不直接访问数据库文件。

```js
import { SqliteReservationStore } from '../src/adapters/sqlite-reservation-store.mjs';
// 首次创建：holdings 必须来自已授权的权威持仓事实；现有文件时拒绝重建。
const store = new SqliteReservationStore({ path: '/private/service/usage.sqlite', holdings });
// 后续打开：省略 holdings，不重新初始化权益。
const reopened = new SqliteReservationStore({ path: '/private/service/usage.sqlite' });
// 组合根注入 Ledger store、HoldingPort.get 和 store.receiptWriter。
// 停止接收请求并等待在途操作结束后 close()。
```

`schema_version=1`（SQLite user_version）和 application_id 同时核验；未知版本拒绝打开，不自动迁移/清空。首次建表及初值同事务提交；创建中断留下的空文件需运维核查，不自动覆盖。已存在内存数据不会被暗中迁移。未来迁移需备份、校验、版本化迁移、回滚和独立证据。

## 事务、数据与恢复语义

- `holdings`：按账户/Holding 主键保存该 Holding 状态聚合；`claims`：按账户/幂等键唯一认领并关联 Holding；`receipts`：账户/幂等键主键、账户/回执 ID 唯一约束和认领外键。
- 写操作使用 `BEGIN IMMEDIATE`；读操作使用一致性读事务；值使用 SQL 绑定参数。`WAL` 与 `synchronous=FULL` 设置后回读确认，外键开启，扩展加载保持默认关闭。
- 事务函数完全同步，不包含 Provider 调用、await 或外部回调。失败回滚；回滚失败关闭连接。默认锁等待上限 2 秒，可配置为 0–5 秒，无自动业务重试。同步 SQLite 操作会短暂阻塞当前 Node 事件循环；高吞吐部署应使用工作线程或异步数据库 adapter 并另测容量。
- 认领和聚合同时提交；提交用量和状态同事务写入。Writer 只能保存已准备的同一回执。最终 receipt_committed 必须已有匹配的持久回执。序列化前检查 JSON 往返保真，不能静默丢弃 undefined 等业务值。
- SIGKILL 前未提交的数据库修改回滚；已记录 provider_succeeded/committed/receipt_prepared/已写回执/receipt_committed 的操作可恢复；reserved/dispatching 或结果未知保留占额，不自动认领、释放或调用。旧 owner/错误状态拒绝；未实现租约接管，因而不宣称已实现分布式 fencing。
- 回执和输出是私有数据；公共证据只包含测试结论和源码摘要，不上传数据库文件。损坏数据、认领与聚合不一致、回执绑定不一致均拒绝。

代价：每次操作需读取并校验一个 Holding 的历史聚合，历史增长时复杂度和写放大会增长；SQLite 单写者也限制写入吞吐。该 adapter 提供真实本地事务/崩溃恢复证据，不替代 PostgreSQL、多机租约或持续容量证明。后续可在同端口下采用索引化行存储，不能拿小样本测试声称已达生产规模。

## 验收

在合同包目录执行 `node --test test/sqlite-reservation-store.test.mjs`。覆盖真实文件重开、跨进程唯一认领和最后单位、SQL 失败回滚、事务未提交 SIGKILL、九阶段 SIGKILL/新进程恢复、权限与符号链接、Schema、JSON 保真、回执与账户隔离、锁竞争、HTTP 重建后同结果单次扣量，以及完成态回执丢失/篡改时拒绝重放。共新增 11 项正式测试，其中一项覆盖九个进程终止检查点。子进程只是测试进程，不是已实现的 Agent 沙箱。测试 Provider 完全合成，无付费调用。

完整质量门继续执行 `npm run quality:verify`，原始日志及固定源码 CI 由 `CI_CD_EVIDENCE.md` 索引。严格 checkJs 覆盖共享状态机和内存 adapter；SQLite adapter 当前由 lint、真实数据库/进程测试覆盖，未声称已完成全文件严格静态类型检查。

下一步：跨窗“只恢复结算”授权入口与待确认对账；明确结果的权威来源后才改变不确定占额。物理掉电、磁盘故障、备份恢复、网络数据库、生产规模负载、真实 Provider、staging 故障回滚和 Agent OS 隔离继续分别取证。

参考：[Node 22.13 SQLite](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)、[SQLite 事务](https://sqlite.org/lang_transaction.html)、[SQLite synchronous](https://sqlite.org/pragma.html#pragma_synchronous)。
