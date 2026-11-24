# 架构

> English: [docs/en/architecture.md](en/architecture.md)

<!-- docs-nav -->
[文档](../README.md#文档) · **架构** · [配置](configuration.md) · [命令行](cli.md) · [控制台](console.md) · [基准测试](benchmarks.md) · [限制](limitations.md) · [开发](development.md)

本插件把官方 JSONL 会话后端换成「一个会话一个 SQLite 库」。它实现 DSH（`@deepseek-ai/dsh-session`）的 `sessionPersistence` 契约，因此宿主、控制台、压缩、fork 与恢复都不需要改动。

```
DSH 宿主进程
├── sessionPersistence 服务        src/index.ts, src/storage.ts
├── worker 线程（storageThread）   src/worker-entry.ts  →  src/database.ts
├── HTTP 控制台（仅 owner）        src/console.ts       →  src/inspect.ts
└── 客户端插件（web）              client/              ←  lib/client.js
```

## 磁盘布局

```
<root>/
├── --<projectKey(cwd)>--/                编码与官方后端逐字节一致
│   └── <encodeSegment(sessionId)>/
│       ├── session.db                    会话本体
│       ├── session.db-wal                预写日志
│       ├── session.db-shm                共享内存索引
│       └── session.lock                  写租约（flock）
├── .migrating/                           整根迁移的暂存区
└── <stateDirectory>/                     默认 <dirname(root)>/session-backends
    ├── session-backends.json             路由表（哪个 id 在哪个后端）
    ├── console-settings.json             控制台偏好
    └── latency.json                      延迟日志
```

目录以 `0700` 创建，库与边车文件 `0600`。header 里没有 `cwd` 的会话落在 `_no-cwd/`。目录名编码与官方后端完全一致，因此同一个会话在两个后端里指向同一个路径。

## Schema

```
PRAGMA application_id = 0x44534853 ('DSHS')
PRAGMA user_version   = 2
PRAGMA auto_vacuum    = INCREMENTAL
PRAGMA journal_mode   = WAL
PRAGMA synchronous    = FULL
PRAGMA busy_timeout   = 5000
```

| 表 | 形态 | 作用 |
| --- | --- | --- |
| `storage_meta` | 单行 | `store_uuid`、`schema_version`、`dsh_contract_version`（4）、时间戳 |
| `session` | 单行 | `session_id`、`header_json`、`inherited_event_count`、`event_count`、`revision`、`state`（`importing` \| `ready`） |
| `session_event` | `seq` 主键，`STRICT`、`WITHOUT ROWID` | `event_type`、`event_time_ms`、`event_json`，即尚未分块的尾部 |
| `session_event_fold` | `(seq, event_time_ms, event_type)` 索引 | 窗口读的键折叠 |
| `session_seal` | 单行 | `marker` = `<event_count>@<revision>`，`checksum` = `n:Σlength(type):Σtime:min(seq):max(seq)` |
| `event_chunk` | `first_seq` 主键 | `last_seq`、`event_count`、`raw_bytes`、`compressed_bytes`、`codec='zstd'`、`types_bytes`、`times_total`、`types_json`、`payload BLOB` |

`READABLE_VERSIONS = [1, 2]`。只读连接绝不建表：空文件按空库打开，`application_id` 不符按损坏上报，不做静默修补。

## 写路径

1. `append()` 先对批次做深度快照，并校验每个事件经过一次 JSON 往返后不失真。
2. 批次进入单条 promise 链，同一会话的提交严格串行。
3. `persistContiguous()` 取写租约，断言首个序号正好等于 `event_count`，截掉撕裂尾，然后在一个事务里 `INSERT`、`event_count` 与 `revision` 自增。
4. 提交后刷新封口（seal），必要时分块。

一次 `append` 就是一个 `BEGIN IMMEDIATE … COMMIT`。`flush()` 是屏障：队列内全部提交后才 resolve。实时钩子用固定 200ms 窗口、单飞 drain；drain 失败把批次放回队首并暂停定时器，等下一次 `flush()` 唤醒。drain 与释放租约同时失败时抛 `AggregateError`。

## 读路径

`open(id, 'read')` 只读 header。`open(id, 'write')` 扫描 `root/*/<encodeSegment(id)>/session.db`；同一 id 命中两个项目目录即视为损坏。id 的唯一权威是库内 header。

撕裂尾的判定：`seq` 与行下标不符、JSON 解析失败、冗余列与 JSON 不一致。从首个不合法行起整段算坏：读只给出合法前缀并记录 `tornTruncateTo`，写路径删除尾巴并记一条警告。后端从不猜内容。

窗口读：

| 条件 | 行为 | 典型耗时 |
| --- | --- | --- |
| `session_seal` 有效且覆盖该区间 | 走 `session_event_fold` 键折叠，跳过的行不解码 JSON | 2–7ms |
| 无封口或封口失效 | 逐行解码整条日志 | 700ms 以上 |
| 整段读 | `decodeTrusted()` 只取 `seq, event_json` | 47,374 事件 669ms |

封口由写路径在每次提交后重算（`appendBatch`、`appendImported`、`truncateTail`、`markReady`、`materializeHeader`）。

## worker 线程

`storageThread: 'worker'`（默认）把所有同步 SQLite 调用移出宿主线程。协议是 `{rid, op, args}` → `{rid, ok, result}`，错误按名字重建。worker 崩溃时在飞的请求立即 reject，不会挂住。`inline` 只用于测试。

## 写租约

一个会话一个写者，用 `session.lock` 上的 `flock` 实现。拿不到抛 `SessionAlreadyOwnedError`。租约比对 `fd` 的 inode 与 device 以扛住文件替换，释放时只关闭描述符——锁文件永不删除。

## 分块（`compact()`）

`compact()` 在提交与重封口之后运行，未分块行不足半块时直接返回。它把行按 512KiB（未压缩）切组，每组 zstd level 3，在一个事务里写 `event_chunk` 并删行；`reclaim()` 把页还给文件系统。

* 512KiB 是实测拐点：1MiB 只多省 2MB，却让窗口读翻倍（6.44ms → 10.68ms）。
* 分块后**不**重算封口：`types_bytes`、`times_total`、`first_seq`、`event_count` 折叠出的值完全相同，结果与分块前逐字节一致。
* `auto_vacuum` 必须在建库时打开：未打开时首次封口会把 163MB 涨到 186MB。
* `truncateTail` 跨块安全：切进块内会把前缀重新物化。

## 帧缓存与预热

解压后的块进入 8MiB 字节 LRU（`src/lru.ts`）。任何写入都会清空缓存（重封口、分块、`truncateTail`）。8 块常驻时，95 页回溯只需 269 次解码（原 445 次），951ms → 637ms。整段读取按 `'lines'` 取页（页以字符串交出，省掉 join/encode/transfer/decode/split 一整圈），`readPage` 对外仍按协商格式返回。

`warmupSessions`（默认 5）在 mount 后预热最近会话的尾部并补建检索索引：首屏尾窗 6.1ms → 1.0ms，老库首次检索 5.7s → 约 50ms。预热有 30 秒预算，失败保持安静。

## 派生的会话

fork 必须存三样，并在打开时校验：`header.isSeeded = true`、`inherited_event_count`、切点处 `session/end-seed` 事件的 `data.inherited = true`。错误文案是 `seeded session header requires an inherited event count` 与 `unseeded session header inherited event count must be 0`。继承的前缀事件要重新追加，序号从 0 连续。

从 0.2.3 起宿主的 `create()` 还会带 `parentSource: { sessionId, endSeq, events }`，把整段种子日志和它的父会话一起递过来，并要求后端在 `create()` 返回之前就落盘。本插件是一会话一库，无法像官方 segment 后端那样引用父前缀，所以按「复制型后端」实现：`copyForkLog()` 先排空仍在内存里的父写者，校验父库存在且 `endSeq` 不超过它已存的事件数，`assertContiguous` 之后用**同一个事务**把整段种子（含切点后的子事件）写进子库，句柄的游标从种子末尾起算，调用方不再重复追加。

父库不存在抛 `SessionPersistenceNotFoundError`；`endSeq` 超过父库长度抛 `SessionPersistenceCorruptionError`，文案带 `SESSION_FORK_PREFIX_NOT_PERSISTED`（对应官方错误码语义）。两条都在 `registerCreated` 之后、写盘之前判定，失败会 `abandonCreated` 撤掉占位，所以同一个 id 可以立刻重试，不会被答「already exists」。

## 版本

`user_version = 2` 只表示「允许有帧」。缺表用 `CREATE TABLE IF NOT EXISTS` 补齐，不改版本号。真正的升级是 `compact()` 或显式的 `dsq upgrade --root <sqliteRoot> [--session <id>]`，后者在一个 `BEGIN IMMEDIATE` 里同时改 `user_version` 与 `storage_meta.schema_version`。

## 混合路由

`HybridSessionPersistence` 占据唯一的 `sessionPersistence` 席位；`cordis.patch.yml` 里的官方 JSONL 条目必须 `disabled: true`。`open` 先查路由表，查不到去另一侧找并自愈路由表。`create` 用 `newSessionBackend`（默认 `sqlite`）。`list` 合并两侧并按 id 去重。路由表损坏只告警，可重建。

## 源码职责

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口、配置 schema、`apply`、预热调度 |
| `src/storage.ts` | handle 生命周期、200ms 窗口、批次追踪、根扫描 |
| `src/database.ts` | 同步引擎：PRAGMA、schema、事务写、语句缓存、`compact`/`reclaim`、窗口读、`sliceTrusted`/`decodeTrusted`、封口、撕裂尾、`storedEventCount`/`trustedLength` |
| `src/chunk.ts` | `encodeChunk`、`decodeChunk`、`decodeChunkLines`、`decodeChunkRange` |
| `src/lru.ts` | `ByteLru` 与 `deletePrefix` |
| `src/warmup.ts` | 30 秒预算的静默预热 |
| `src/schema.ts` | DDL、`SCHEMA_VERSION`、`APPLICATION_ID` |
| `src/format.ts` | 与官方后端共用的目录编码 |
| `src/lease.ts` | 写租约 |
| `src/executor.ts` | `StorageExecutor`、按 device/inode 判键的 LRU、`HeaderCache`、`listHeaders`、`InlineExecutor` |
| `src/worker-client.ts`、`src/worker-entry.ts`、`src/rpc.ts` | worker 传输 |
| `src/router.ts`、`src/catalog.ts` | 混合路由、路由表原子写 |
| `src/migrate.ts`、`src/transfer.ts`、`src/discover.ts` | 转换引擎、暂存与发布、根发现 |
| `src/inspect.ts`、`src/console.ts` | 只读探查与 HTTP 控制台 |
| `src/search.ts`、`src/query-engine.ts` | 可选 FTS5 索引与查询引擎 |
| `src/metrics.ts`、`src/metrics-journal.ts` | 延迟采样与日志 |
| `src/preferences.ts`、`src/about.ts`、`src/diagnostics.ts` | 控制台偏好、构建信息、诊断环形缓冲 |
| `src/cli.ts` | `import` / `export` / `verify` / `uninstall-check` |
| `client/` | 控制台界面：`ConsolePage.tsx`、`TransferTab.tsx`、`MetricsTab.tsx`、`SettingsTab.tsx`、`i18n.ts`、`api.ts` |
| `tests/vendor/` | 测试中作为判定基准的官方契约源码 |
