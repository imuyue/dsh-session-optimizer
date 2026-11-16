# 控制台

> English: [docs/en/console.md](en/console.md)

<!-- docs-nav -->
[文档](../README.md#文档) · [架构](architecture.md) · [配置](configuration.md) · [命令行](cli.md) · **控制台** · [基准测试](benchmarks.md) · [限制](limitations.md) · [开发](development.md)

控制台是客户端插件（`dsh.client.platform = web`，构建到 `lib/client.js`），通过 `ctx.slots` 注册进 `main` 与 `sidebar.panellist` 两个插槽。它自己从不读 SQLite：所有数字都来自 `src/console.ts` 在宿主侧实现的路由。

## 路由

| 路由 | 方法 | 返回 |
| --- | --- | --- |
| `/overview` | GET | 会话数、事件数、字节数、WAL 字节、损坏库数、生效 PRAGMA、目录权限、用量明细 |
| `/metrics` | GET | `read`、`append`、`flush`、`open`、`list`、`stat`、`search` 的真实延迟；无注册表时 `available: false` |
| `/roots` | GET | `configured`、`dsh-home`、`sibling-of-root` 三个候选根 |
| `/source` | GET | 某个后端/根下的会话列表（必填 `backend`、`root`，可选 `offset`/`limit`/`q`），目标后端已有则标注 |
| `/migrations` | GET | 转换记录，单条或 `404` |
| `/migrate` | POST | `202` 与作业 id；body `{direction, mode, sessions?, newSessionId?, verify, jsonlRoot?, sqliteRoot?}` |
| `/search` | GET | `{available, query, hits: [{sessionId, seq, type, time, score, snippet}]}`；`q` 必填，`limit` 默认 20、上限 100 |
| `/diagnostics` | GET | 最多 200 条 `{at, level, scope, message}` |
| `/diagnostics/clear` | POST | 清空环形缓冲 |
| `/uninstall-check` | GET | `{sqlite, jsonl, orphaned, unreadable, ok}` |
| `/settings` | GET/POST | 部分更新 `format`、`stabilityFixes`、`language` |

路由层强制的约束：

* 仅在 `connection` 服务存在时注册，且 `apply` 里不 await；
* 仅对 `principal.kind === 'owner'` 生效；
* 所有响应带 `cache-control: no-store`；
* `POST` 先判 `content-type`（纯文本返回 `415`），同一路径按 method 分派（非混合模式返回 `409`）。

## 只读探查

除 `/migrate` 外的所有路由都用 `new DatabaseSync(path, { readOnly: true })`（`src/inspect.ts`）：不建目录、不写一个字节、不产生 `-wal`/`-shm`。单库损坏不会抛错，问题记在条目上，判定顺序为：读错误 → `application_id` → `user_version` → 无 `session` 行 → header 不可读 → header id ≠ `session_id` → 目录名 ≠ `encodeSegment(id)` → 序号不连续。

## 视图

| 视图 | 内容 |
| --- | --- |
| 总览 | 状态行、四个计数卡、逐库空间占用表、生效 PRAGMA（折叠 details） |
| 对话转换 | 方向切换、重新扫描、过滤、表格、勾选、覆盖/新会话两种模式、回读校验开关、最近转换 |
| 延迟 | 窗口摘要、p50/p95/max 折线、六行统计表；无样本时显示「未采样」 |
| 设置 | 存储两张卡（SQLite 带默认徽标）、长对话稳定性修复、语言、版本与构建信息、仓库链接、支持与许可 |
| 诊断 | 上述环形缓冲 |

## 转换语义

* **覆盖**保留 `session_id`，把原日志移入 `<sourceRoot>.replaced/<migrationId>/`，新库按同名目录发布。
* **新会话**生成新 id，原会话原位保留，列表里多出一条。
* 「已转换」由路由表里的 `originSessionId` 判定，不看文件名。

不变量：先写暂存再发布（`<session.db>.importing`、`<session dir>.exporting`），回读比对先于 rename，发布前取写租约，JSONL 一侧只走官方 provider。

## 延迟采样

`src/metrics.ts` 用 `performance.now()` 包住真实调用。每个操作在 5 分钟窗口内保留 8192 个样本，5 秒一桶，桶内保留 p50、p95、p99 与 max；摘要卡与表格按同一窗口过滤。`src/metrics-journal.ts` 每 15 秒把该窗口持久化（见[配置](configuration.md)）。
