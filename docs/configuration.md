# 配置

> English: [docs/en/configuration.md](en/configuration.md)

<!-- docs-nav -->
[文档](../README.md#文档) · [架构](architecture.md) · **配置** · [命令行](cli.md) · [控制台](console.md) · [基准测试](benchmarks.md) · [限制](limitations.md) · [开发](development.md)

插件通过 `profile/cordis.patch.yml` 里的 Cordis 条目配置。除 `root` 外所有键都可省略。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `root` | ——（必填） | 存放 SQLite 会话的目录 |
| `journalMode` | `wal` | SQLite 日志模式 |
| `synchronous` | `full` | SQLite 持久化级别 |
| `busyTimeoutMs` | `5000` | 语句等待锁的时长 |
| `writeBatchMaxDelayMs` | `200` | 实时写合批窗口 |
| `preparedSessionCacheSize` | `5` | 执行器 LRU 保留的句柄数 |
| `warmupSessions` | `5` | mount 后预热的会话数；`0` 关闭预热 |
| `storageThread` | `worker` | `worker` 让 SQLite 调用离开宿主线程，`inline` 仅用于测试 |
| `hybrid` | `false` | 让 SQLite 与 JSONL 共处一张路由表 |
| `jsonlRoot` | `''` | 混合模式与转换器使用的 JSONL 根 |
| `stateDirectory` | `''` | 路由表、偏好、延迟日志的存放目录；默认 `dirname(root)/session-backends` |
| `newSessionBackend` | `sqlite` | 混合模式下新会话落在哪个后端 |
| `ownSearch` | `false` | 用库内 FTS5 索引提供检索，替代官方 query 包 |

## 补丁文件

`cordis.patch.yml` 关掉官方 JSONL 持久化并挂载本插件：

```yaml
- id: session-persistence
  disabled: true
- id: session-persistence-sqlite
  module: dsh-session-optimizer
  config:
    root: ~/.dsh/sessions-sqlite
```

`hybrid: false` 时插件独占整个后端。`hybrid: true` 时官方条目必须保持挂载但 `disabled: true`，因为 `HybridSessionPersistence` 占用同一个唯一席位，并且通过官方 provider 读取 JSONL 一侧。

## 控制台偏好

控制台写 `<stateDirectory>/console-settings.json`：

```json
{ "format": "sqlite", "stabilityFixes": true, "language": "zh" }
```

| 键 | 作用 |
| --- | --- |
| `format` | 新会话落在哪个后端；改完立即生效，只挂一个后端时另一张卡为 disabled |
| `stabilityFixes` | 映射到 `seal`；关闭后不再产生新封口（`SessionDatabase.retune` 对缓存中的句柄同步生效） |
| `language` | 仅控制台语言（`client/i18n.ts`），从不改动已存数据 |

写盘是原子的：`0600` 临时文件 rename 覆盖目标，目录 `0700`。失败时返回 HTTP 500，前缀为 `cannot write the preferences file:`。这是部分更新接口，省略的键保持原值；seed 值本身从不落盘，否则会覆盖 profile 的 `newSessionBackend`。

## 延迟日志

`src/metrics.ts` 用 `performance.now()` 包住真实调用，每个操作在 5 分钟窗口内保留 8192 个样本，按 5 秒一桶统计 p50/p95/p99/max。`src/metrics-journal.ts` 每 15 秒把窗口写入 `<stateDirectory>/latency.json`（`0600`、`version: 1`），读回时只保留窗口内的记录；`lastObservedAt` 不恢复，写盘失败静默处理。

## 检索

可选的库内检索索引是每个 `session.db` 里的一张 contentless FTS5 表（`event_fts`，`content=''`，`rowid = seq + 1`，`contentless_delete=1`）。索引消息正文、工具调用与工具输出，不索引 reasoning 与 turn 收尾。

* 需要 `ownSearch: true`，并移除 `@deepseek-ai/dsh-session-query-sqlite`，避免两个检索提供方争抢席位。
* 中文按相邻二字组索引，查询时二字组相与，因为 FTS5 的 `unicode61` 分词器会把一段汉字当作一个 token。
* 游标是不透明 base64url JSON；游标失配报 `SESSION_QUERY_STALE_CURSOR`。
* 即使关闭 own-search，表仍随写入维护，之后开启只需一次预热 `indexStore()`。
* 覆盖到的行数记在同库的 `event_fts_state.built_rows`：每次追加在自己那个事务里把它推进到「已索引到第几条」，所以插件自己写的会话首搜直接查索引。由更早版本写下的会话没有这一行，会付一次全量重建，那次重建顺带把计数补上——之后同样直接查。索引与日志一旦不连续（截断、扩容、外部改写），计数就对不上，读者退回重建，而不是拿一个残缺索引给出「没有匹配」的假答案。
