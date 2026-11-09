# dsh-session-optimizer

DeepSeek Harness 的 SQLite 会话持久化后端：替换官方 `@deepseek-ai/dsh-session-persistence-jsonl`，行为与 `SessionPersistence` 契约等价，**一个会话一个 `session.db`**。

- 基线：DSH `0.2.2-rc.1`（commit `fcc0ad4`，`SESSION_FORMAT_VERSION = 4`）
- 验收：官方 `runPersistenceContract`（20 例）+ `runLiveWritePathContract`（12 例）在 `inline` 与 `worker` 两种模式下全绿；另有布局编码、迁移 CLI、迁移引擎、混合路由、控制台、偏好文件、分支会话、分块压缩、预热、LRU、损坏修复、compaction 回归测试，**共 252 例**
- 混合模式（`hybrid: true`）：SQLite 与官方 JSONL 两个后端同时挂载，由一份路由表决定每个会话读哪边；**装好之后新建的对话默认落 SQLite**，已有 JSONL 历史原地可读
- 附带 Web GUI 控制台：五个视图（总览 / 对话转换 / 延迟 / 诊断 / 设置），其中「对话转换」在浏览器里把对话在两个后端之间迁移，不必碰命令行；「设置」改的是新对话落哪个后端、长对话稳定性修复，以及插件面板自己的界面语言（只作用于面板，不改 DSH 宿主界面）
- 真实样本回放：三个真实 DSH 会话（47374 / 2466 / 1434 事件，含子代理、job、compaction、llm/retry 等 30 种事件类型）在 VM 上完成 import → verify → export → verify 往返，逐事件零差异（§9.3）
- 体积与延迟：47374 事件 / 155MB 的会话经分块压缩到 **24.9MB（6.57×）**；**首屏 100 条 2.05ms、尾页 500 条 6.7ms、header 0.2ms**，同一会话冷读 JSONL 需要 740–904ms。整段读取 SQLite 669ms（压缩后 490ms）、JSONL 冷读 743–905ms（§9.4）
- 界面只读：控制台自带的一律是 `readOnly: true` 连接，不建目录、不写盘、不产生 `-wal` / `-shm` 边车（§7.2）
- 平台：**Linux 已验证**（`local_vm_linux`，Node 24.9+）；**Windows 未验证**（见 §10）

仓库结构：

- `dsh-session-optimizer/` — 插件本体：`src/`（Host 侧）、`client/`（面板）、`tests/`、`scripts/`、`package.json`、`cordis.patch.yml`，以及这份 `README.md`、`开发计划.md`、`阶段四任务表.md`
- `资料/` — 不是构建产物：`参考资料/`（设计稿与调研）、`参考界面设计/`（HTML 设计稿与预览图）、`开发脚本/`（早期探针），以及 `特别感谢.txt`
- 两个目录互不依赖：删掉 `资料/` 不影响构建与测试

---

## 1. 它做什么，不做什么

做：

- 把会话日志（`SessionEvent` 序列）存进 SQLite，一行一个事件，`seq` 从 0 连续
- 与官方 JSONL 后端共享同一套目录编码，两种后端可以在同一 root 下并存
- **混合模式**：两个后端同时在线，一份路由表（`session-backends.json`）记住每个会话住在哪边；新对话默认落 SQLite，老对话留在 JSONL 也能直接打开、续聊
- **对话转换**：把一个对话整体搬到另一个后端——覆盖模式让同一个 `session_id` 换承载（对话列表里还是那一条），新对话模式复制出一份新 `session_id`（对话列表里多一条，可点开、可续聊）
- 提供 `import` / `export` / `verify` / `uninstall-check` 迁移工具，读写 JSONL 一律走官方 provider
- **分支会话**（fork）按运行期的语义存：`isSeeded` 的 header 必带 `inheritedEventCount`，被继承的前缀属于子会话自己的日志，cut 处坐着 `session/end-seed` 标记事件（§5.10）
- 跨进程写租约、`0700`/`0600` 权限、Worker 线程隔离（历史实现阻塞事件循环的缺陷不再存在）
- **分块压缩**：封口水位线之前的日志按 512KiB 未压缩预算压进 `event_chunk`（zstd），`session_event` 只留未封口的尾巴；实测 155MB → 24.9MB
- **跨会话检索自建**：每个 `session.db` 里一张 FTS5（`unicode61` + 索引时补 CJK 二字组），开启 `ownSearch` 后由本插件回答 `ctx.sessionQuery`，替代 `@deepseek-ai/dsh-session-query-sqlite`（见 §7.9）；不开时一切照旧
- 附一个 Web GUI 控制台（§7），在浏览器里看空间占用、完成对话转换、看真实延迟

不做（V1 明确边界）：

- **不做分支 / tombstone 表**（2026-11-09 复查后的结论，不是「留给后续」而是「做了没有服务对象」）。fork 本身是运行期行为——`create(header, { inheritedEventCount })` 之后调用方把前缀与标记事件当普通事件追加，插件只负责把 cut 原样存回（§5.10）。真要做「同一个 `session.db` 里分多条 branch」，先得有调用方：宿主 `SessionHeader` 只有 `isSeeded`，`create` 的选项只有 `inheritedEventCount`，**父会话 id 从未被持久化**（`buildForkSeed` 只搬事件，不搬来源），cut 也已经存在 `session.inherited_event_count` 里。所以现在加一张「分支血缘」侧表，等于把已有的一个数字抄到第二处，再加一套永远没人读的 tombstone 语义——与删除功能那次同一个错误。等上游有了多分支调用方再谈结构。
- **不合成 `turn/end` / `step/end`**（设计稿 §5.8）。崩溃回合的收尾由 agent-loop 在持有写权时补写，持久化层只丢弃物理撕裂尾
- **不隐式迁移旧库布局**。读 v1 与 v2（`READABLE_VERSIONS = [1, 2]`），v1 库的整份日志就是未封口的尾巴；只有真正写入块才把 `user_version` 提到 2。更高版本直接拒绝，不做降级或猜测。
- **不用 DSH 的 fork 做复制**。官方 fork 复制前缀并加 inherited-seed 标记与合成 fork 事件，会改变 transcript 语义；这里的「新对话」复制全部事件、只换身份

---

## 2. 启用

### 2.1 作为 profile bundle

```bash
dsh plugin --profile <name> add dsh-session-optimizer
```

`package.json` 里的 `dsh.bundle.patch` 指向仓库根的 `cordis.patch.yml`，它做两件事：

```yaml
- id: session-persistence-jsonl
  disabled: true          # 两个后端共享 sessionPersistence 服务，只能挂一个

- insert:
    - id: session-persistence-optimizer
      name: dsh-session-optimizer
      config:
        root: !!js dshHomePath('sessions-sqlite')
        storageThread: worker
```

验证补丁层生效（应看到 jsonl 行带 `disabled: true`，末尾多出本插件段）：

```bash
dsh --profile <name> --dump-config | grep -A6 session-persistence
```

离线环境（VM 无 registry 访问）用软链装载：

```bash
mkdir -p ~/.dsh/profiles/<name>/node_modules
ln -sfn /path/to/dsh-session-optimizer ~/.dsh/profiles/<name>/node_modules/dsh-session-optimizer
# package.json: dependencies { "dsh-session-optimizer": "link:/path/to/dsh-session-optimizer" }
#               dsh.profile.bundles: ["@deepseek-ai/dsh-base", "dsh-session-optimizer"]
```

### 2.2 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `root` | string | 必填 | 会话根目录；每会话在其下 `<project>/<session>/session.db` |
| `journalMode` | `wal`\|`delete`\|`truncate`\|`persist` | `wal` | 每次打开连接时设置 |
| `synchronous` | `full`\|`normal` | `full` | 持久化屏障强度；不以性能换掉崩溃安全 |
| `busyTimeoutMs` | natural | `5000` | `PRAGMA busy_timeout`；历史实现缺此项，遇锁直接失败 |
| `writeBatchMaxDelayMs` | natural ≥1 | `200` | 实时事件批量窗口；窗口从首事件起算，后续事件不重置 |
| `preparedSessionCacheSize` | natural ≥1 | `5` | 打开中的数据库 LRU 容量 |
| `warmupSessions` | natural ≥0 | `5` | mount 之后预热最近改动的几个会话（尾部 100 条 + 检索索引）；`0` 关闭 |
| `storageThread` | `worker`\|`inline` | `worker` | `inline` 仅供契约测试与故障排查 |
| `hybrid` | boolean | `false` | 打开混合模式：SQLite 与 JSONL 同时在线，按路由表分派 |
| `jsonlRoot` | string | `''` | 混合模式下 JSONL 后端的数据目录（官方 `dshHomePath('sessions')` 的值） |
| `stateDirectory` | string | `''` | 路由表所在目录，默认 `<root 的父目录>/session-backends` |
| `newSessionBackend` | `sqlite`\|`jsonl` | `sqlite` | 新建对话落在哪边。**默认 SQLite**：装好插件后新对话不再进 JSONL |

混合模式的最小配置：

```yaml
- id: session-persistence-optimizer
  config:
    root: /home/me/.dsh/sessions-sqlite
    jsonlRoot: /home/me/.dsh/sessions
    hybrid: true
```

`stateDirectory` 缺省时路由表写在 `dirname(root)/session-backends/session-backends.json`。它记的是「哪个会话住哪边」（`backend`、`originSessionId`、`migrationId` 等），删掉也无损——重建时按「两个后端里谁有这个 id」重新推断，只在两边都有时才会需要人判断。

---

## 3. 磁盘布局

```
<root>/
  --<projectKey(cwd)>--/            # '/' '\' ':' 折叠成单个 '-'，--<slug≤251>--
    <encodeSegment(sessionId)>/      # 非 [A-Za-z0-9._-] 一律 ~XXXX（大写 hex）
      session.db                    # ← 会话库
      session.db-wal                # WAL 模式边车
      session.db-shm
      session.lock                  # 跨进程写租约（POSIX 永不删除）

<stateDirectory>/                   # 默认 dirname(root)/session-backends
  session-backends.json             # 混合模式的路由表：谁住 SQLite、谁住 JSONL、克隆的溯源

<root>.migrating/                   # 转换中的 staging（只在任务运行期存在）
<sourceRoot>.replaced/<migrationId>/ # 覆盖转换后留档的原日志
```

- `cwd` 缺失的会话落在 `_no-cwd/`
- 目录 `0700`、`session.db` 与边车 `0600`、`session.lock` `0600`（创建后立刻 `chmod`，不依赖 umask）
- 目录编码与官方 JSONL **逐字节一致**，因此迁移期同一个会话目录里可以同时存在 `session.v4.jsonl.zstd` 与 `session.db`，回退不破坏官方后端
- 同一个 `session_id` 的 `cwd` 决定它落在哪个 `--project--` 桶里；两个桶同时有这个 id 会被 `findDatabasePath` 报成损坏，而不是猜一个

---

## 4. 库内 schema

```sql
PRAGMA application_id   = 0x44534853;  -- 'DSHS'
PRAGMA user_version     = 2;           -- 布局版本（1 = 无 chunk 的旧库，仍可读）
PRAGMA auto_vacuum      = INCREMENTAL; -- 封口删掉的页要能还给文件系统
PRAGMA foreign_keys     = ON;
PRAGMA journal_mode     = WAL;
PRAGMA synchronous      = FULL;
PRAGMA busy_timeout     = 5000;

CREATE TABLE storage_meta (
  singleton            INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_uuid           TEXT    NOT NULL,     -- 建库时随机生成，此后不变
  schema_version       INTEGER NOT NULL,
  dsh_contract_version INTEGER NOT NULL,     -- = 4
  created_at_ms        INTEGER NOT NULL,
  updated_at_ms        INTEGER NOT NULL
) STRICT;

CREATE TABLE session (
  singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
  session_id            TEXT    NOT NULL,
  header_json           TEXT    NOT NULL CHECK (json_valid(header_json)),
  inherited_event_count INTEGER NOT NULL CHECK (inherited_event_count >= 0),
  event_count           INTEGER NOT NULL CHECK (event_count >= 0),
  revision              INTEGER NOT NULL CHECK (revision >= 0),
  state                 TEXT    NOT NULL CHECK (state IN ('importing','ready')),
  created_at_ms         INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL
) STRICT;

CREATE TABLE session_event (
  seq           INTEGER PRIMARY KEY CHECK (seq >= 0),
  event_type    TEXT    NOT NULL,
  event_time_ms INTEGER NOT NULL,
  event_json    TEXT    NOT NULL CHECK (json_valid(event_json))
) STRICT, WITHOUT ROWID;

-- 只含小列的覆盖索引，让「整条日志的键折叠」是毫秒级
CREATE INDEX session_event_fold ON session_event (seq, event_time_ms, event_type);

-- 写者提交后盖的摘要，让窗口读不必解码窗口外的行（见 §5.3）
CREATE TABLE session_seal (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  marker    TEXT    NOT NULL,   -- "<event_count>@<revision>"
  checksum  TEXT    NOT NULL    -- "n:Σlength(type):Σtime:min(seq):max(seq)"
) STRICT;

-- v2：封口后的日志块。一个块是不可变的，块内事件连续、按 seq 升序
CREATE TABLE event_chunk (
  first_seq       INTEGER PRIMARY KEY CHECK (first_seq >= 0),
  last_seq        INTEGER NOT NULL CHECK (last_seq >= first_seq),
  event_count     INTEGER NOT NULL CHECK (event_count > 0),
  raw_bytes       INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  codec           TEXT    NOT NULL,     -- 'zstd'
  types_bytes     INTEGER NOT NULL,     -- Σ length(type)，喂给 seal 的折叠
  times_total     INTEGER NOT NULL,     -- Σ time
  types_json      TEXT    NOT NULL CHECK (json_valid(types_json)),  -- 类型直方图
  payload         BLOB    NOT NULL,
  CHECK (last_seq = first_seq + event_count - 1)
) STRICT, WITHOUT ROWID;
```

`session_seal` 与 `session_event_fold`、`event_chunk` 都是**辅助对象**：旧库（`user_version = 1`，只有三张核心表）按需原地补齐（`CREATE TABLE IF NOT EXISTS`），因此不触发「版本不符就拒开」。`READABLE_VERSIONS = [1, 2]`，写总是把库升到 2；纯读连接（控制台、索引器、预热）**绝不建表**——v1 文件的整份日志就是未封口的尾巴，这正是 v1 的定义。

四个设计点：

1. **`singleton = 1`** 把「一库一会话」写进 schema，而不是靠调用方自觉
2. **`event_type` / `event_time_ms` 是冗余列**：读取时与 `event_json` 内的 `type`/`time` 交叉校验，任何不一致按撕裂尾处理。将来做按类型过滤或诊断不必解 JSON。唯一的例外是 seal 已验证的整段读（`decodeTrusted`，§5.3）：那里只取 `seq` 与 `event_json`，不再逐行比对——省下的正是这 47374 次比对
3. **`state='importing'`** 只由迁移 CLI 写：整份日志在一个事务里落库并标记 `importing`，回读比对通过后才 `markReady()`。运行时会拒绝从未 ready 的库（半个历史不是日志，不能 resume）
4. **`session_seal` 是惰性摘要**：`reseal()` 只在写者提交后运行（2–7ms / 47k 事件，走 fold 索引），读路径只在能对上 `marker` 且重算折叠一致时才信它——对不上就退回逐行解码，与没有这张表时完全同义
5. **`event_chunk` 让体积降下来、窗口读更快**（§5.8）：未压缩字节量超 512KiB 的尾巴被切成块压缩，块内是 `JSON.stringify` 逐行 `\n` 连接后的 zstd 流；块一旦封口不再改写，`types_json` 让控制台的类型筛选不必解压

---

## 5. 运行时语义

### 5.1 建会话不落盘

`create()` 只做 header 快照（并按 JSONL 编码器语义补 `delegationDepth: 0`）、`isSeeded`/`inheritedEventCount` 一致性校验、进程内 pending 登记，**零文件足迹**。首次 `append`/`flush` 才建库——这正是契约里「created-but-unwritten 仅本实例可见、新实例不可见、未写就 close 等于不存在」的实现。

### 5.2 写路径

```
append(events)
  ├ assertOpen('append')
  ├ materializeAppendBatch(events)     # 深度快照 + 无损 JSON 校验，先于入链
  └ 单条 promise chain → persistContiguous(batch)
       ├ 只读 handle → SessionReadOnlyError
       ├ ensureLease()                 # 首次写盘才拿 session.lock
       ├ assertContiguous(id, batch, cursor)
       ├ 有撕裂尾 → truncateTornTail() # 先删坏行再写
       └ 单事务：INSERT 事件 + event_count + revision+1
```

- 一次 `append` = 一个 `BEGIN IMMEDIATE … COMMIT`
- `flush` 是持久化屏障；空会话 flush 会物化出只有 header 的库
- 实时路径（`session/event` 钩子）按固定 200ms 窗口聚合；窗口到期单飞 drain；drain 失败时把批次放回队首并**暂停**定时器（后台失败不自动重试），由下一次 `session/flush` 唤醒
- 循环结束时若 drain 与释放租约都失败，抛一个 `AggregateError`

### 5.3 读路径与撕裂尾

`open(id,'read')` 只读 header（不解码事件），句柄的游标取自 header 的 `eventCount`；`open(id,'write')` 先扫描 `root/*/<encodeSegment(id)>/session.db` 定位路径并解码前缀。同一 id 命中两个目录视为损坏。目录名是转义的，**id 的唯一权威是库内 header**。

撕裂尾的定义：从第一个不合法行起全部算坏——`seq` 不等于行下标、JSON 解析失败、或冗余列与 JSON 不符。读只返回合法前缀并把下标记在 `tornTruncateTo`；写路径在下次 append 前删除这些行并 warn。**不猜内容、不做事件级修复**。

窗口读为什么不能只看窗口：`seq` 是 `WITHOUT ROWID` 表的主键，`count(*)` 与 `min/max` 能证明键覆盖（即 `[0, count)` 每个 seq 恰有一次），但**证明不了某一行的 JSON 与它的列一致**，而窗口读必须与全量读给出同一个答案。两条路：

```
coverage && seal 仍有效（sliceIsTrusted）
  → 键折叠 2–7ms 代替整条解码：写者提交时已经替这些行背书
     · 要整段日志时：只取 seq + event_json 两列解码，不再与冗余列逐行比对（decodeTrusted）
     · 只要一段窗口时：四列走查窗口内的行，窗口外的行直接跳过
否则
  → 逐行解码整条日志（游标迭代，不复制第二份数组），再按窗口切片
```

`decodeTrusted` 让整段读取少取三列、少做 47374 次列比对：实测 743ms → 669ms（同一会话、同一台机器，5 轮交替）。它承担的风险与 `sliceIsTrusted` 对窗口承担的完全相同——**只在 seal 仍然描述这份日志时才信它**；seal 缺失、`marker` 不符、折叠对不上，任何一条都退回逐行解码。被 seal 之后的外部改写若连 `count` / `Σlength(type)` / `Σtime` / `min` / `max` 都没改动，这条快路径不会发现——这是有意的取舍，写者每次提交都会重算 seal。

`reseal()` 由写路径在提交后调用（`appendBatch` / `appendImported` / `truncateTail` / `markReady` / `materializeHeader`），读路径只在**同一读事务内**校验 `marker`（`event_count@revision`）与重算折叠；任何不符（旧库、被外部改过、另一进程持有写锁时改过）就退回全量解码——语义与没有 seal 时一致，只是慢。窗口外校验与全量兜底保证 **同一份日志不论被切成哪一段读，两次报告的 `events` / `eventCount` / `tornTruncateTo` 完全相同**。

### 5.4 Worker 线程

`storageThread: 'worker'`（默认）把全部 SQLite 调用送进一个 worker 线程，主线程只做 RPC：`{rid, op, args}` → `{rid, ok, result}`，错误按 `name` 在原进程重建为契约错误类（`instanceof` 成立）。worker 崩溃时**所有在飞请求立刻 reject**，不会挂住会话。

`inline` 模式跑同一套引擎，用于契约测试和排查 worker 层问题；两种模式跑同一组契约测试。

### 5.5 跨进程写租约

`session.lock` 与库同目录，POSIX 用 `flock`：

- 拿不到锁 → `SessionAlreadyOwnedError`
- 加锁后比对 `fd` 的 `ino`/`dev` 与路径当前值，防止锁到被替换的文件
- 释放只关闭 fd，**永不删除锁文件**（删除会让两个进程各锁一个 inode）
- 单个进程内也是单写者：`open(id,'write')` 取得的租约直接交给 handle 复用，不重复 flock

跨进程实测：

```
holder: acquired
while held  -> second: REFUSED SessionAlreadyOwnedError
holder: released
after release -> second: ACQUIRED
```

### 5.6 版本与外来库拒绝

| 情况 | 行为 |
|---|---|
| 空文件（无表、`application_id = 0`） | 单事务建全部表 + 写 `storage_meta` + 盖两个 pragma |
| `application_id` 不是 `0x44534853` | `SessionPersistenceCorruptionError` |
| `user_version` 不在 `[1, 2]` | `SessionFormatUnsupportedError`（提示升级 harness，而非「损坏」） |
| 有 app id 但无表 | `SessionPersistenceCorruptionError` |

`user_version = 1` 是可读的：没有 `event_chunk` 表时整份日志就是 `session_event` 里的尾巴，读路径据此关掉全部 chunk 查询（`chunks: false`），**纯读连接不会给旧库建表**，也就不改动它的字节。首次写入才会补表并把版本抬到 2。

导入中途崩溃留下 `state='importing'` 的库：运行时 `open`/`read` 直接拒绝，CLI 可识别并整体替换。

### 5.7 混合模式的路由

`hybrid: true` 时，插件仍然只占 `sessionPersistence` 这**一个**服务席位（`HybridSessionPersistence`），两个真实后端挂在隔离作用域里，由一张路由表分派：

```
open(id)  → 路由表说在哪边就开哪边
          → 该边说「没有这个会话」→ 去另一边找；找到就改路由（陈旧路由自愈）
create()  → newSessionBackend（默认 sqlite）
list()    → 两边合并，同一个 id 只留路由指向的那份
```

三条取舍：

- **只占一个席位**：DSH 的 `sessionPersistence` key 在一条上下文链上只能注册一次，官方 JSONL 条目必须先 `disabled: true`，否则 `service "sessionPersistence" has been registered at …` 直接让插件不激活。bundle 自带的 `cordis.patch.yml` 就是这么做的。
- **路由表坏了不影响日志**：写表失败只 `logger.warn`，不拿已提交的事件去换簿记；表删掉也能按「哪边有这条日志」重建，只有两边都有时才需要人判断（会 warn 出两边是谁）。
- **新对话默认 SQLite**：`newSessionBackend` 缺省 `sqlite`。老对话留在 JSONL 不动，仍可打开、续聊、被转换。

### 5.8 分块压缩

写路径在每次提交并 `reseal()` 之后调用 `compact()`：尾巴的未压缩字节量还不到半个块就直接返回（廉价门槛，`SELECT sum(length(event_json))`），否则单遍扫描尾巴、按 512KiB 未压缩预算切块，一次性在事务里写入 `event_chunk` 并删掉对应的行，然后 `reclaim()` 把空出来的页还给文件系统。

三个数来自实测，不是估计：

- **块大小 512KiB**：500 事件的历史页是真实读取单位。512KiB 时一页落在 1–2 块内，窗口读 p50 6.44ms、文件 23.1MB；1MiB 时窗口读退到 10.68ms，但只多省 2MB。逐行压缩被否决——zstd 每行单独压只有 2.36×，全量读还要 1229ms。
- **zstd level 3**：1MiB 块 L3 压 635ms / 5.57×，L9 要 1315ms / 6.12×。压缩发生在写路径上，多花 0.7 秒换 0.5× 不划算。
- **`auto_vacuum = INCREMENTAL`**：删行之后空出来的页默认留在 freelist 里，文件不会变小（实测首次封口后 163MB → 186MB）。新库在 `initializeStore()` 建表后立刻设 `auto_vacuum` + `VACUUM`（空库瞬间完成），旧库在首次 `compact()` 时一次性转换。

封口不重算 seal：`event_chunk` 里记着每块对 checksum 的贡献（`types_bytes` / `times_total` / `first_seq` / `event_count`），`logChecksum()` 把「所有块的汇总 + 尾巴的行」折在一起，**结果与封口前逐字节相同**，因此旧 seal 继续匹配、不会被一次压缩作废。

`truncateTail()` 跨块安全：先删掉整块在切点之后的，再对跨切点的那块解压、把幸存事件写回 `session_event`、删块，最后删尾巴。帧不能切，切点两侧必须相接。

### 5.9 帧缓存与预热

`sliceTrusted()` 每次解一块就需要 `zstdDecompressSync` + UTF-8 解码 + `split('\n')` + 逐行 `JSON.parse`，单页 500 事件实测 8.5ms，其中解压与解码占 5.6ms。历史页边界很少正对块边界，翻页时同一块被解两次很常见，所以解出来的数组进一个**按字节预算**的 LRU（`FRAME_CACHE_BYTES = 8MiB`）：8 块让 95 页的回溯从 445 次解码降到 269 次（951ms → 637ms）。

用字节而不是条数：一块解码后是十几个还是上千个事件只有上界，按「8 块」计数意味着 2–20MB 的浮动，而同进程里还跑着模型与 worker。缓存**任何写入都清空**（`reseal()` / `compact()` / `truncateTail()`）——块键会在重写后指向不同内容，陈旧的解码不能当成日志发出去。

`warmupSessions`（默认 5）在 mount 之后把最近改动的几个会话的尾部窗口读一遍：先 `listHeaders` 批量拿 header，再 `loadHeader` + `loadSession(尾部 100 条)`，每批之间 `setTimeout(0)` 让出事件循环。实测首屏尾部窗口读从 6.1ms 降到 1.0ms（约 6×）——把解压的等待挪到点击之前。它在 mount 完成之后才跑，disposer 注册在存储资源之后（先执行），因此卸载时先停读再关 worker。预热还会**给最新几个库补建检索索引**（`indexStore`）：`event_fts` 是后加的，老库没有它，不在这里补就要由第一次检索付账。实测 5 个老库（含 47,377 事件）在 mount 后补齐，之后首次检索 50ms；不预热时首查 5.7s。

### 5.10 分支会话（fork）

fork 在运行期是「新建一个 `isSeeded: true` 的会话 + 把父会话的事件前缀当种子」。三件事必须原样存下来，否则分支就是断的：

| 存什么 | 谁写的 | 为什么不能丢 |
|---|---|---|
| `header.isSeeded = true` | `create()` 的 header | 少了它，子会话被当成普通会话，`inheritedEventCount` 立刻非法 |
| `inherited_event_count` | `create()` 的 `options.inheritedEventCount` | 这是「前 N 条是继承来的」的唯一记录；它不是事件，日志里没有任何事件能重建它 |
| cut 处的 `session/end-seed` 标记 | 调用方作为普通事件追加（`data.inherited === true`） | 运行期用它区分「继承到这里的切点」与「此处恰好有一条同名事件」 |

两条校验与官方 JSONL 后端逐字一致：`isSeeded` 却没给 cut → `seeded session header requires an inherited event count`；没 `isSeeded` 却给了非零 cut → `unseeded session header inherited event count must be 0`。**前缀事件必须被重新追加**：`inheritedEventCount` 不是跳过，而是声称「这 N 条是我的」——写入从 `seq = 0` 开始连续，`assertContiguous` 会拒绝从 N 起跳的批次。`tests/fork.spec.ts` 的 4 例按这个语义走：`forkSeed(cut)` 造出 `[前缀…, end-seed]`，再追加子会话自己的 turn，重开进程后断言 cut、标记事件与 `seq` 连续都在。这条此前**一条测试都没有**——全仓库其它 fixture 的 `inheritedEventCount` 都是 0。

---

### 5.11 冷加载：只解码一次

`open(id, 'write')` + `handle.read(0)` 是宿主恢复一个会话的固定两步。2026-11-09 之前这两步各解码一遍 123MB 的日志：写打开时 `trustedLength()` 为了省一次 `SELECT DISTINCT event_type`（实测 10.5ms）而对「无 chunk 且行数 > 4096」的库直接放弃快路径，退回去走全量校验——47k 事件上约 1.1s。现在的做法是：

- `trustedLength()` 不再拒绝，索引扫描照做（10ms 买回 1s）；
- `read(0)` 走**分页**：每页 8192 个事件，worker 只把编码后的**字节**转移给主线程（不克隆对象），主线程逐页 `JSON.parse` 后 `validateStoredEvents` 一次。
- 实测同一台 VM、同一个 47k 事件库（163MB，v1 行存储）：`stat` 42ms、`open(write)` 14ms、`read(0)` **932ms**，合计 **≈0.99s**（改造前 2.1–3.2s）。剩下的成本是一次 `JSON.parse`：契约要求 `read()` 一次返回全部事件对象，这一趟省不掉。

### 5.12 布局版本升级

`user_version` 说的是**行怎么排**，不是「哪些表存在」。打开一个旧库时附加表会用 `IF NOT EXISTS` 补齐（否则老库读不了），但**版本号不会被顺手改掉**：v2 只是「允许有封帧」，没有帧的库仍然是一个合法的 v1 库，而维持 v1 让旧版本还能打开它。把库真正搬到 v2 只有两条路：写满阈值触发封帧（`compact()` 自己会改版本），或者显式 `dsq upgrade --root <sqliteRoot> [--session id]` —— 它在 `BEGIN IMMEDIATE` 里同时改 `PRAGMA user_version` 与 `storage_meta.schema_version`，失败回滚并报错，成功则打印每个库的 `旧 -> 新`。

## 6. 迁移 CLI

```bash
dsh-session-optimizer import --from <jsonlRoot> --to <sqliteRoot> [--session <id>] [--force] [--json]
dsh-session-optimizer export --from <sqliteRoot> --to <jsonlRoot> [--session <id>] [--force] [--json]
dsh-session-optimizer verify --from <jsonlRoot> --to <sqliteRoot> [--session <id>] [--json]
dsh-session-optimizer uninstall-check --root <sqliteRoot> --jsonl <jsonlRoot> [--json]
```

退出码：`0` 成功 / `1` 校验或安全失败 / `2` 用法错误。

- **JSONL 侧只走官方 provider**（`@deepseek-ai/dsh-session-persistence-jsonl`，`compression: 'none'`）。我们自己不解析也不生成 JSONL，格式与世代命名由官方负责。因此该包是本 CLI 的运行时依赖；未安装时 CLI 会明确提示装在哪
- `import` 与 `export` 都先写 staging 目录（`<target>.importing` / `<target>.exporting`），**回读逐事件比对通过后**再原子 rename 到目标；Windows 上 rename 不能覆盖，实现里用「挪开旧的 → 挪入新的 → 失败回滚」
- `export` 的 staging 目录下官方 provider 会再建一层 `<project>/<session>/`，因此 rename 的是**内层会话目录**，不是 staging 根
- `verify` 比对 header（含 `delegationDepth` 归一化）与每条事件的 `seq/type/time/data`
- `uninstall-check` 列出「只存在于 SQLite、JSONL 侧没有」的会话并返回非零——**卸载前必须 export，否则历史随插件消失**
- 未 `--force` 时已存在的目标会话会被跳过并报告，不覆盖

CLI 做的是**文件层面的复制**（`import` / `export`），它不动路由表；「让某个会话改从另一边读」是 §7.4 的对话转换。两者共用同一套 staging/回读/租约原语，只是后者多一步写路由并留档源日志。

### 卸载流程

```bash
# 1. 确认没有孤儿：非零退出说明有会话没导出
dsh-session-optimizer uninstall-check --root <sqliteRoot> --jsonl <jsonlRoot>
# 2. 全部导出
dsh-session-optimizer export --from <sqliteRoot> --to <jsonlRoot>
# 3. 删除插件、切回官方 JSONL 后端（去掉 cordis.patch.yml 的两条补丁）
```

DSH 没有可假设的 pre-uninstall 钩子，所以第 1 步是必须由用户执行的 CLI 动作。混合模式下第 1 步尤其要紧：路由表指向 SQLite 的会话，在插件消失后就是彻底看不见的历史。

---

## 7. Web GUI 控制台

插件自带一个「会话存储」面板：装进 Web profile 后，左侧栏出现入口，右侧主面板只有五个视图——**总览 / 对话转换 / 延迟 / 诊断 / 设置**。除「对话转换」里显式提交的转换任务与「设置」里改写偏好文件外，面板只读。

账本、事件、诊断三个旧视图在 2026-11-08 按设计稿删除：会话列表与事件表只是把后端已有的事实搬进浏览器，诊断的每条结论总览里都有，留着它们既是重复入口也是一份要跟着改的代码。删视图的同时把背后的路由、只读探查、帧缓存读数与渲染器采样一并删掉，见 §7.10。

它不是独立网页，而是 DSH 的**客户端插件**（`package.json` 的 `dsh.client.platform = "web"`，产物 `lib/client.js` 由 `window.__ModuleLoader__.load` 包裹），通过 `ctx.slots` 注册到 `main` 与 `sidebar.panellist` 两个座位。数据来自 Host 侧的 11 条 exact Fetch 路由。

### 7.1 通道

```ts
// src/console.ts
registerConsole(ctx, {
  root, settings, storageThread, jsonlRoot, migrations,
  preferences: { host, formats },  // 偏好文件；没有存储的挂载不传
  about,                           // 版本与链接
})
```

| 路由 | 方法 | 返回 |
|---|---|---|
| `/api/session-optimizer/overview` | GET | 会话数、事件总数、字节数、WAL、损坏数、实际生效的 PRAGMA、目录权限，以及每个会话的占用明细（`usage`，按大小降序） |
| `/api/session-optimizer/metrics` | GET | 七项操作（`read`/`append`/`flush`/`open`/`list`/`stat`/`search`）的真实延迟快照；没有注册表时 `available: false` + 原因 |
| `/api/session-optimizer/roots` | GET | 自动识别出的候选根目录（`configured` / `dsh-home` / `sibling-of-root`）及其会话数目 |
| `/api/session-optimizer/source` | GET | `backend` + `root` 必填；`offset` / `limit` / `q` 可选；列出该后端里的对话（标题、事件数、大小），并标出目标后端已有的那些 |
| `/api/session-optimizer/migrations` | GET | 无 `id` 返回转换任务列表 + 两侧根目录；带 `id` 返回单个，未知 404 |
| `/api/session-optimizer/migrate` | POST | body `{direction, mode, sessions?, newSessionId?, verify, jsonlRoot?, sqliteRoot?}`；受理 202 + 任务对象，`text/plain` 415，非混合 profile 409 |
| `/api/session-optimizer/search` | GET | `q` 必填（空白返回空页）、`limit` 默认 20 上限 100；返回 `{available, query, hits}`，每条是 `{sessionId, seq, type, time, score, snippet}` |
| `/api/session-optimizer/diagnostics` | GET | 进程内的问题记录（最多 200 条），每条 `{at, level, scope, message}` |
| `/api/session-optimizer/diagnostics/clear` | POST | 清空问题记录，返回 `{cleared}` |
| `/api/session-optimizer/uninstall-check` | GET | 比 SQLite 与 JSONL 两侧的会话 id，返回 `{available, sqlite, jsonl, orphaned, unreadable, ok}`；没有 `jsonlRoot` 时 `available: false` + 原因 |
| `/api/session-optimizer/settings` | GET / POST | GET 返回 `{available, preferences, formats, about}`；POST 是**部分更新**，body 里出现哪个键就改哪个（`format` / `stabilityFixes` / `language`），回 200 + 改后的三项；`text/plain` 415，无偏好文件 409，非法值 400 |

三条约束：

- 路由只在 profile 同时加载 Web 传输（`connection` 服务存在）时注册。**headless profile 不带这层 UI**。注册代码在 `apply()` 里刻意不 `await`，否则没有 `connection` 的 profile 会永远 pending。
- 只有 `principal.kind === 'owner'` 的 Peer 能到达，其他一律 403（传输层行为，插件不额外鉴权）。
- 全部响应带 `cache-control: no-store`。三个 POST 路由都先判 `content-type: application/json`，跨源简单请求（`text/plain`）在预检之前就被 415 挡住。`/settings` 的读与写注册在**同一个 path 上、按 `request.method` 分派**——传输层以 path 为键，同一 path 注册两次会让后一次把前一次顶掉，GET 也会走进 POST 分支。

### 7.2 只读语义

除 `/migrate` 之外，每个请求都用 `new DatabaseSync(path, { readOnly: true })` 打开会话库（`src/inspect.ts`），因此：

- 不建目录、不写盘、**不产生 `-wal` / `-shm` 边车**；写进程正持锁时也能读
- 单个损坏库只在总览的「异常」卡与空间占用表的那一行填 `problem`，不抛异常、不遮蔽同目录其他会话
- `problem` 的判定顺序：读错误 → `application_id` 不符 → `user_version` 不符 → 无 session 行 → header 不可读 → header id 与 `session_id` 不符 → 目录名不是 `encodeSegment(id)` → 事件 seq 不连续

### 7.3 五个视图

| 视图 | 内容 |
|---|---|
| 总览 | 状态行（「存储正常，N 个会话均可读取」+ 更新时间）→ 四张卡（会话 / 事件 / 占用空间 / 异常）→ 左「空间占用」表（会话、事件数、大小、占比条）→ 右「存储配置」（存储格式、写入模式、存储线程、锁等待、目录权限），`<details>` 里按需展开 `application_id` / `journal_mode` / `synchronous` / `busy_timeout` 与根目录 |
| 对话转换 | 方向切换 + 重新扫描 → 过滤框 → 对话表（标题、事件数、大小、创建时间，已转换过的带徽标）→ 勾选与两个模式单选 + 回读校验 + 开始转换 → 「最近转换」卡片（进度条、逐对话状态） |
| 延迟 | 窗口摘要（最近 5 分钟 / 样本数 / 失败数 / 聚合粒度）→ 选中操作的折线图（p50 / p95 / max 三条线、坐标轴刻度、悬停读数）→ 六项操作的统计表，点行切图；没有样本时写「最近 5 分钟没有采样」，不画平线 |
| 设置 | 存储段（两张格式卡，`SQLite` 带「默认」徽标）→ 长对话稳定性修复（开启 / 关闭）→ 语言 / Language（简体中文 / English）→ DSH Session Optimizer（版本 + 检查更新、构建信息、仓库、支持与许可）。文案逐字取自设计稿，一字未改 |


### 7.4 对话转换

这里的语义不是「导出文件」，而是**把一个对话搬到另一个承载上**，两种模式的区别只在转换后它叫什么：

| 模式 | `session_id` | 对话列表 | 原日志 |
|---|---|---|---|
| 覆盖 | 不变 | 还是那一条 | 移进 `<sourceRoot>.replaced/<migrationId>/` 留档 |
| 新对话 | 新分配 | **多一条**（可点开、可续聊、带来源标记） | 原位保留 |

页面上不需要手填任何路径或 id：`/roots` 给出机器上真实存在的候选目录（当前 profile 配的、`~/.dsh` 下的默认位置、根目录的同级目录），`/source` 列出该目录里的对话与标题。判断「这个对话已经转换过」靠的是路由表里的 `originSessionId`——新对话模式的副本有新 id，只有溯源能让源对话也显示「已在 SQLite」，否则用户会重复转换、得到两份副本。

三条不变量在 GUI 路径上同样成立：

1. **staging 先写后发布**：`<session.db>.importing` / `<session dir>.exporting`，回读逐事件比对通过才 rename 到目标；崩溃只会留下 staging，`/overview` 的 `staging` 字段会把它报出来（只报不删，它可能是唯一副本）
2. **发布前拿目标目录的写租约**：POSIX 下 rename 之后旧 inode 仍被活句柄持有，正在跑的 DSH 会写进已 unlink 的 inode——租约把这种情况挡在门外
3. **JSONL 侧只走官方 provider**：与 CLI 同一约束，插件不解析也不生成 JSONL

跨平台一条额外要求：header 的 `cwd` 必须被写成**打开方宿主能接受的绝对路径**（Windows 上写的 `C:\APP\x` 在 Linux 上是 `/mnt/c/APP/x`）。做不到就直接拒绝而不是写一个打不开的库——否则对话会出现在列表里、点开却报 `cwd must be an absolute path`。

转换完成后控制台立刻刷新对话列表，因此新对话不必重开页面就能看见。

### 7.5 延迟（真实采样）

`src/metrics.ts` 只用 `performance.now()` 包住真实调用：`read`/`append`/`flush`/`open`/`list`/`stat`/`search` 七个操作，每个操作保留最近 8192 个样本，窗口 5 分钟、5 秒一桶，桶内算 p50/p95/p99/max。**没有样本就显示「未采样」，不画平线、不造数据**——`/metrics` 在 profile 没接上注册表时返回 `available: false` 并附原因。

摘要里的「N 个样本 / N 次失败」**和 op 统计一样按窗口过滤**，不是进程生命周期累计。早先这里报的是 `totalCount`：静置五分钟后界面写着「13 个样本」，而六行表格全是 0、图区写着「没有采样」——同一张卡片自相矛盾。现在两边同口径，`tests/console.spec.ts` 里用 `registry.snapshot(Date.now() + 10 * 60_000)` 钉住这条边界。

代价：每进程最多 7 × 8192 个 `{at, ms, ok}` 样本（几百 KB 上限），不影响持久化布局。

**窗口会跨重启**（`src/metrics-journal.ts`）：每 15 秒把窗口写进 `<state>/latency.json`（0600、`version: 1`），挂载时读回来。读回时**只保留还在五分钟窗口内的样本**，更早的丢弃——图区的标题写着「最近 5 分钟」，复活一条十分钟前的记录就是冒充。`lastObservedAt`（预热用来判断「应用是否忙碌」）不从文件恢复：上一个进程的调用不能说明这一个进程现在忙。写盘失败（只读目录、磁盘满）静默忽略，延迟统计不能因为记不下来就让一次已完成的调用变成失败。实测：做一次检索与一次总览后杀掉进程，重启后 `/metrics` 直接报 `read:6 open:4 list:4 stat:2 search:1`（共 17 条，含恢复的 10 条）。

### 7.6 构建

```bash
npm run build          # tsc -p tsconfig.json && node scripts/build-client.mjs
npm run build:host     # 只编译 Host 半边
npm run build:client   # 只打浏览器 bundle → lib/client.js
```

浏览器 bundle 用 `rolldown` 打到 CJS，与上游 `packages/client/tsdown.client.ts` 相同的 banner/footer；`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`、`@tanstack/react-virtual` 等留在外部，由宿主的模块表提供（宿主 `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 里已含 `@tanstack/react-virtual` 3.14.10，与官方 Session Inspector 用的是同一个版本）。

`client/` 里的 TSX 不依赖 `@types/react`（离线环境装不到），类型由 `client/ambient.d.ts` 的本地声明 + `tsconfig.client.json` 保证；`tsconfig.json` 只编译 `src/`，两套配置互不干扰。

### 7.7 已验证

在 `local_vm_linux` 的真实 Web profile（`dsh --profile sqlite-web --patch hybrid-overlay.yml --host <local-vm-ip> --port 3925`）里，对真实会话逐 tab 核对：

- 总览：4 张卡（会话 6 / 事件 50,336 / 占用 165MB / 异常 0）、空间占用六行与其占比条（94.3% / 4.1% / 1.4% / 0.08% / 0.05% / 0.05%，填充色 `rgb(122,170,255)`）、存储配置五项与 `<details>` 里的四项 pragma 全部与磁盘一致；状态行写「存储正常，6 个会话均可读取」
- 「对话转换」自动识别根：源目录下拉里只有一项「3 个对话 · 当前 profile · `<home>/e2e/real-samples`」，目标目录显示本 profile 的 SQLite root，**不需要手填任何路径**
- 对话列表带真实标题（`session/title` 事件）、事件数、大小、创建时间：`[完成]排位赛`(1434) / `[完成]服务器后台面板`(2466) / `You are 沐月, a direct, (1)`(47374)
- 勾选一个对话 → 新对话模式 → `completed · 1/1`、1.5s、`migrated 1434/1434`；总览立刻从 1 个会话变 2 个，侧栏出现新对话，**点开历史正常加载**（能翻轮次、能「加载更早」）
- 覆盖模式：同一个 id 转换后在对话列表里仍是那一条，原 JSONL 日志移进 `<home>/e2e/real-samples.replaced/<migrationId>/`
- 已转换标徽：`JSONL → SQLite` 方向，源对话对应的那条显示「已在 SQLite」；`SQLite → JSONL` 方向，克隆出来的新对话显示「已在 JSONL」（它自己不在 JSONL，靠 `originSessionId` 溯源判定）
- 新建对话默认落 SQLite：在 GUI 里新建并对话一轮后，`session.db-wal` 里能 `strings` 到输入文本，同时间段 JSONL 根下**没有**新文件；当时的 `/events` 返回 22 条 0–21 连续的事件，含两条 `session/title`（该路由随后随事件表一起删除，§7.10）
- 延迟视图：`最近 5 分钟 10 个样本 0 次失败 每 5 秒聚合一次`（样本数与表格同为窗口内计数）、三条折线各一条 path（p50 `rgb(122,170,255)` / p95 `rgb(245,158,11)` / max 虚线 `rgb(173,178,184)`）、Y 轴单位角标独占一行 + 5 个刻度值 + 2 个时间刻（首尾分别左/右对齐，避免被面板边缘裁掉）、统计表六行可点；数字随交互变化，点页头「刷新」会重新采样并刷新「更新于」。**Y 轴单位随峰值切换**：峰值不到 1 秒写 `ms`，超过就整轴换成 `s`（冷启动那次 `open` 峰值 116.8s，用毫秒会印成 `127192.5`，而上方统计卡写的是 `115.63s`——同一张图两种读法）
- 等宽字体、页脚小字、工具栏换行、深色模式均按 `--dsw-*` token 实测通过。**token 名必须从宿主样式表枚举后再写**：`client/styles.ts` 曾把强调色挂到不存在的 `--dsw-alias-state-info-primary` 上（宿主只有 `state-business-primary`），缺失的自定义属性解析成空串、不报错，结果占比条、图例、p50 折线、主按钮底色**全部透明**——宽度算对了所以看起来像渲染正常。现在四个 `var()` 全部带字面回退，宿主改名只会变暗，不会整块消失（§17.7）。
- 转换页按钮与提示语一致：空选 → 提示「未选择对话」、主按钮禁用且标签 `开始转换`；勾一个 → 「已选择 1 个对话」、按钮解禁、标签变 `转换 1 个对话`；取消后回到原样。空选时**不会**声称「转换整个目录」——服务端接受这种请求，但这一版界面发不出去
- 设置视图与设计稿逐项一致：`存储` 段两张格式卡（`SQLite` 卡蓝描边 + 深底 + 「默认」徽标，`JSONL` 卡未选中）、`长对话稳定性修复` 的 `开启|关闭`、`语言 / Language` 的 `简体中文|English`、`DSH Session Optimizer` 四行（`v0.1.0` / `DSH 0.2.2-rc.1` / `打开仓库 ↗` / `反馈 ↗` + `许可证 · MIT ↗`）、段间细横线与无卡片底色、页脚不变。交互实测：点 `JSONL` → `data-active` 翻到 `[false,true]`，点回 `[true,false]`；点 `检查更新` → 约 650ms 后出现「已是最新版本」；点 `English` → 插件面板内的文案全部切成英文（tabs `Overview / Conversation transfer / Latency / Settings`、`h1 Session Storage`、页脚 `6 conversations …`、面板根节点 `lang="en-US"`），面板之外的 DSH 宿主界面（侧栏、对话区）不受影响，仍是中文；点 `简体中文` 面板全部回来；落盘文件 `state/console-settings.json` 内容随之改写，目录 `drwx------`、文件 `-rw-------`、无 `.tmp` 残留
- 视图切换后整页 DOM 节点随数据量变化（视图是卸载而不是隐藏），无控制台错误

### 7.9 跨会话检索：自建 FTS5，可选替代官方

官方 `@deepseek-ai/dsh-session-query-sqlite` 默认是关的（`path: ':memory:'` + `openAt: never`），而它的 `unicode61` 分词把连续汉字当成一个 token、查询串又整串加引号做短语匹配——「排位赛」命中，「排位」在内容侧不命中。本插件因此自建了一份索引：每个 `session.db` 里多一张 `event_fts`（`content=''` 的 contentless FTS5，`rowid = seq + 1`，`contentless_delete=1`），**索引时**把每段连续 CJK 的所有相邻二字组补进同一列，**查询时**把 CJK 词拆成二字组做 AND。实测「排位」「排位赛」「位赛」「一场排位赛」「输了三把」「工具 失败」都命中，英文 `quick` / `ENOSPC` 照常；索引范围是消息正文、工具调用与工具输出，reasoning 块与 `completed` 的 turn 收尾不索引。

**开启方式**：profile 里设 `ownSearch: true`，并**移除** `@deepseek-ai/dsh-session-query-sqlite`——`ctx.sessionQuery` 只能有一个主人。开启后由本插件回答 `ctx.sessionQuery` 的 `searchSessions` / `searchEvents`，游标是不透明的 base64url JSON，日志长度或指纹不符时报 `SESSION_QUERY_STALE_CURSOR`。

**不开启时**：`event_fts` 仍然建、仍然随写入更新（它就在写路径上），只是没有人会查它；它不参与读写正确性，删掉整张表也能被下一次检索自动重建。

**老库的索引由预热补建，检索时兜底**：`event_fts` 是后来加的，2026-11-09 之前的 `session.db` 里没有它。正常路径是 mount 之后的预热给最新 5 个库补建（`indexStore()`，分批让出事件循环），所以第一次检索就已经是 50ms。预热没覆盖到的库（更老的、预热没跑完就检索的）由检索自己兜底：借一个可写连接补建再回答——这条路径实测 5.7s（5 个库、含 47,377 事件），只付一次。若那个库根本不可写（只读挂载、别人的文件），检索返回「未建索引」而不是抛错——搜索不该因为建不出索引而失败。

**代价与边界**：索引与日志同库，所以 `session.db` 会变大；某个库坏了只影响它自己的那次检索（Host 记一条 `warn` 诊断后跳过，不让一个坏库拖垮整次查询）；`ui-chat` 仍然只接收 `{sessionId, snippet}`，所以「搜到即跳到某一行」依旧做不到，那要改上游。

### 7.10 删掉的两个视图与它们背后的代码

设计稿把面板收成三个视图（「设置」与「诊断」是随后补上的第四、第五个）。被删掉的东西不是「先隐藏、以后再说」——每个视图背后都有一整条链路，留着就是一份要跟着改的代码：

| 删掉的 | 背后的代码 |
|---|---|
| 会话列表 + 事件表 | `/sessions`、`/events` 两条路由；`src/inspect.ts` 的 `inspectSessions` / `inspectSession` / `inspectEvents`（含穿透块的分页与类型直方图）；`src/database.ts` 的 `streamEvents()`；`client/EventTable.tsx`、`client/window.ts`（窗口算术）与它们各自的单测 |
| 诊断 | `/diagnostics` 路由；`inspectDiagnostics`；`frameBytes` 的整条链（`StorageExecutor` → worker 的 RPC handler → `consoleTarget` → 前端），因为它唯一的消费者就是诊断面板 |
| 渲染器采样 | `client/probe.ts`、`client/ProbePanel.tsx` 与 10 例单测 |

总览接过诊断的两件事：目录权限（「仅当前用户可访问 0700」）与每个库的 `problem`（「异常」卡 + 空间占用表那一行）。`readOnly: true` 的只读语义不变——它现在是总览唯一的数据来源。

同一轮还扫掉了 14 个「只有声明、没有任何引用」的导出：`planChunks`（封块计划，写路径早已自己切）、`sessionPath`、`NULL_METRICS`、`leaseTarget`、`DSH_CONTRACT_VERSION`（`SCHEMA_VERSION` 已足够）、`jsonlRootCompression` / `jsonlCompression` / `readJsonlHeader` / `listJobs` / `jobById` / `stagingLeftovers` / `targetFor` / `jsonlTargetFor` / `under`。它们曾经是各阶段给测试或 CLI 留的口子，调用方搬走后没人删；留着就要跟着改签名。判据是「名字在代码里只出现一次（声明处）」，注释里的提及不算。

### 7.11 设置：写的是偏好，不是会话数据

三个开关都落在**一个 JSON 文件**里，与会话数据无关：`<stateDirectory>/console-settings.json`（`src/preferences.ts`）。`stateDirectory` 没配时取 `dirname(root)/session-backends`——和混合模式放路由表的地方是同一个目录，一个 profile 只有一份设置。

```json
{"format":"sqlite","stabilityFixes":true,"language":"zh"}
```

- **`format`（新对话数据存储格式）**：只决定「下一次新建对话落到哪个后端」。混合模式下它写进 router 的 `newSessionBackend`（`create()` 每次调用现读该字段，**改完立刻生效，不用重启**）；单后端挂载只提供自己那一种，另一张卡是 `disabled` 的——给一个点了没反应的开关比不给更糟。已有的对话不受影响，它们各自的路由记录在 `session-backends/catalog.json` 里。

  文件还不存在时，开关显示的是**profile 自己的配置**（`newSessionBackend`），不是编译期的默认值：`createPreferencesHost` 接受一个 seed，挂载时只是把它当作起始值，**不落盘**。这条不是修饰——若无 seed，面板读回默认的 `sqlite` 并 apply，会把配置好的 `newSessionBackend: jsonl` 在第一个请求之前就覆盖掉，新对话静默落到 SQLite，而日志还在说 jsonl。
- **`stabilityFixes`（长对话稳定性修复）**：映射到 `SqliteSettings.seal`。关掉等于**不再封帧**（`compact()` 不再在每次 `appendBatch` 末尾跑），已经封好的帧照样读得出，`dsq compact <id>` 这条显式命令也不受影响。生效是**活连接级**的：`SessionDatabase.retune(settings)` 在每次缓存命中时同步这个开关（`src/executor.ts` 的 `DatabaseCache.get`），所以不必等句柄过期。默认开启。
- **`language`**：只影响插件面板本身（`client/i18n.ts`），面板内立刻切换——页头、页脚、四个 tab、表格列名、空态文案都跟着变；`lang` 设在面板根节点（`div.dshsql-page`）上，宿主的 `document.documentElement.lang` 不动，侧栏与对话区也不动。这是「插件的界面语言」，不是 DSH 的界面语言。

写入是**部分更新**：body 里出现哪个键就改哪个，没出现的保持原值；未知键、错类型、`format` 不在本挂载能提供的集合里，一律 400 且**不落盘**；写盘本身失败（目录只读、磁盘满）是 **500**，消息带 `cannot write the preferences file:` 前缀——把「磁盘满」报成 400 会让运维去改一个本来正确的 body。落盘用「临时文件 0600 → rename」，目录 0700，读的时候逐字段回退（文件被手改成非法值不会让面板打不开，坏字段退回默认值）。

「文件里记的」和「当前生效的」是两件事：profile 丢了某个后端时，面板显示能用的那个（`formats[0]`），文件里仍然保留运维选的那个；此时改语言等**无关开关**，写盘的基准是文件内容，不会把文件里的 `jsonl` 顺手改成 `sqlite`（否则重新启用该后端就再也恢复不了原选择）。显式点名一个不可服务的 `format` 才拒绝。

「检查更新」按钮不联网：它重新读一次 `package.json`（`installedVersion()`）再刷新一次页面数据，然后显示「已是最新版本」；`about` 是按请求求值的 thunk，不是挂载时的快照，`pluginVersion` 取的是**磁盘上**的版本，所以原地升级后不重启也能读到新号。刷新失败时**不显示**这句话，改为把错误写在面板顶部——一次没送达的请求不能报「已是最新」。**没有更新源可查，就不假装查了**。同理，仓库 / 反馈 / 许可证三个链接只在 `package.json` 真的声明了 `repository`、`bugs`、`licenseUrl` 时才是链接，否则渲染成纯文本——`"license": "MIT"` 只是 SPDX id，不含 URL，编一个出来比不显示更糟。版本号与构建信息（`DSH 0.2.2-rc.1`）都是运行时读出来的：前者来自本插件的 `package.json`，后者来自实际解析到的 `@deepseek-ai/dsh-session/package.json`。

**与设计稿的两处差异，都是「拿不到就不编」**：① 设计稿的 `构建信息` 写 `DSH 0.2.2-rc.1 · fcc0ad4`，其中的提交号在运行期取不到（安装产物里没有 git 元数据），这里只显示实际解析到的版本号；② 三个链接在 `package.json` 尚未声明 `repository` / `bugs` / `licenseUrl`，因此现在渲染为纯文本（文案不变），补上字段即变链接。


---

### 7.12 诊断与卸载前检查

面板的「诊断」tab 有两个部分，都是为「卸载之前别丢东西」服务的：

- **问题记录**：进程内的环形日志（最多 200 条，`scope` 是 `list` / `open` / `search` / `catalog` / `console`），只收 `warn` 与 `error`，500 级的路由失败会自动记一条。它是内存态，重启清零——要长期留证据就用 `dsq verify` 与 `dsq uninstall-check`。
- **卸载前检查**：比 SQLite 与 JSONL 两边的会话 id，列出「只存在于 SQLite」的对话。有它们时不要卸载：插件一移除，这些对话在 DSH 里就再也看不见了。这一步只读 header，不读事件，坏库会被单独列进 `unreadable` 而不是让整次检查失败。

DSH 没有「卸载前钩子」这个扩展点（`dsh-app-boot` 里那个 `uninstaller` 是移除事件处理器的，与本插件无关），所以检查只能显式触发：面板按钮、`GET /api/session-optimizer/uninstall-check`，或 `dsq uninstall-check --root <sqliteRoot> --jsonl <jsonlRoot>`。

## 8. 与本仓库设计稿 v0.3 的有意偏离

| # | 设计稿 | 实现 | 原因 |
|---|---|---|---|
| 1 | 单主库 `sessions.sqlite` + `session_events(session_id, seq)` | **一会话一 `session.db`**，`session_event(seq)` 单行会话表 | 用户硬约束（一会话一库）。副作用：`list()` 需遍历目录，跨会话检索变成「每个库各查一次」再由 Host 合并（§7.9） |
| 2 | `DatabaseSync` 在主线程 | 默认 Worker 线程，`inline` 仅测试用 | 历史实现整段 append 事务阻塞事件循环 |
| 3 | 复用官方 `session-query-sqlite` FTS | **照做**：插件不自建索引，官方索引由 profile 覆盖层开启（`openAt: first-search` + 落盘 `path`） | 一开始自建了一份 CJK 分段的派生索引，后来认定是重复造轮子（用户裁决 2026-11-08）；中文子串命中因此退化为整词，见 §7.9 |
| 4 | 主库内 `transfer_jobs` / `transfer_items` | CLI 用 staging 目录 + 回读比对 + 原子 rename | 一库一会话后跨会话迁移没有天然的事务边界，文件级原子性更直接 |
| 5 | 切换后端要停服务、整体迁移 | **混合模式**：两个后端同时在线，逐会话切换 | 全量迁移在真实数据上是一次性大动作，失败面太大；逐会话可回退、可增量 |
| 6 | 迁移复制用 DSH 的 fork | 自己复制事件、只换 `session_id` | fork 会写 inherited-seed 标记与合成 fork 事件，transcript 语义被改；这里的「新对话」必须与原对话逐事件相同 |
| 7 | 事件表一行一事件、不压缩 | v2 增加 `event_chunk`：512KiB 未压缩预算的 zstd 块，尾巴留在 `session_event` | 用户要求在不牺牲延迟的前提下压缩体积。实测 155MB → 24.9MB（6.57×），窗口读同时从 10.6ms 降到 2–6.7ms（§5.8） |
| 8 | 不加进程内缓存 | 帧缓存（8MiB 字节预算 LRU）+ mount 后预热 5 个最近会话 | 虚拟化只约束渲染，翻页仍要反复解同一块。实测 95 页回溯 951ms → 637ms，首屏尾部窗口读 6.1ms → 1.0ms（§5.9） |

---

## 9. 验证证据（`local_vm_linux`，2026-11-06 ~ 11-09）

```bash
npx tsc -p tsconfig.json --noEmit        # 无输出
npx tsc -p tsconfig.client.json --noEmit # 无输出
npx vitest run
#  Test Files  22 passed (22)
#       Tests  252 passed (252)
```

- `tests/sqlite.spec.ts` 67 例 = `inline` 与 `worker` 各跑官方契约（20 + 12）+ 3 例布局编码
- `tests/migration.spec.ts` 10 例 = import 落库 / 幂等与 `--force` / `importing` 拒绝 / 往返一致 / 无 force 跳过 / verify 检出分歧 / uninstall-check（含「库坏但 JSONL 侧已有该会话」记 skip 而非 fail）/ 坏库不炸整条命令 / **带洞的批量写入被拒且库不变** / 用法与退出码
- `tests/hybrid.spec.ts` 15 例 = 新会话落 SQLite 并写路由 / JSONL 历史可读且不被改动 / `list()` 合并去重 / 路由表删掉可重建 / 两边都有时选 preferred 并 warn / 陈旧路由自愈 / `flush` 覆盖两边 / 缺 `jsonlRoot` 报错 / 单后端时 `name` 不变 / 溯源往返 / 坏文档被拒 / 重建报冲突 / **只要配了 `jsonlRoot` 就是混合挂载**（`hybrid` 为 false 也一样，新会话真的落到 JSONL）/ 目录被外部删掉后路由从 catalog 里消失
- `tests/migrate.spec.ts` 13 例 = 覆盖转换保留 id 且源进 `.replaced` / 指定不存在的会话 / 同后端报错 / 新对话换 id 并记溯源 / `pruneSource` 三态 / Windows 写出的 `cwd` 在本机被译成可打开的形式 / 相对路径被拒且不留空库 / 目标已有的被标注 / 克隆的源也算已转换 / 一个固定名字不能用于多个副本
- `tests/console.spec.ts` 30 例 = 只读探查（最大优先的占用表、缺根不建文件、外来库标 `problem`、目录名不编码 id、pragma 与目录权限聚合）+ 7 条路由的注册形状、`no-store` + 延迟「真实采样或明说没有」（含窗口外的样本不再计入摘要）+ 单后端 profile 的 `409` / `text/plain` 的 `415` + 列表标注跨后端已存在（含克隆溯源）+ 设置路由 6 例（无偏好文件时的 `available:false` / 挂载即 apply / 部分更新落盘后再 apply / 不可服务的 `format` 与错类型与空 patch 全 400 且不写盘 / `text/plain` 415 与无 store 的 409 / 写盘失败是 500 而不是 400）+ 检索路由 4 例（无自建检索时 `available:false` / 参数透传 / 空查询不打后端 / `limit` 非正数 400）+ 诊断路由 2 例（列出记录、清空后为空）+ 卸载前检查 2 例（两侧交错时列出孤儿、无 JSONL 根时明说不可用）
- `tests/preferences.spec.ts` 26 例 = 默认值 / 逐字段回退 / 非 JSON / 非对象 / 写盘 `0700`+`0600`+只留一个文件+尾换行 / 覆盖写 / `patchOf` 只取所给字段 / 拒绝非法值 / 拒绝空 patch / 挂载即 apply / `['sqlite']` 下把存过的 `jsonl` 读成 `sqlite` 但不改文件 / update 持久化后再 apply / 拒绝不可服务的 format 且不写盘 / 部分更新保留其它字段 / `chmod 0400` 后仍能改名覆盖
- `tests/chunk.spec.ts` 6 例 = 长导入封帧且读回逐事件相等 / 跨帧边界窗口 / `truncateTail` 切在帧中间 / 帧边界后续写 / 删掉 seal 后同答 / 短日志不封帧且 v1 库读后不被改写
- `tests/legacy.spec.ts` 3 例 = v1 库全量读 / v1 库的窗口读 / 纯读之后不建表、不改版本、不改字节数
- `tests/warmup.spec.ts` 10 例 = 读全部 header 与最新几个的尾部 / 未变的库不重开 / 坏文件只计数 / abort 停止 / 分批让出事件循环 / 应用繁忙时停泊且一条不读 / 安静后继续 / abort 后不再读 / **给缺索引的库补建检索索引** / `indexSearch:false` 时不建
- `tests/lru.spec.ts` 8 例 = 按字节淘汰最冷 / 读到即最新 / 单条超预算也不淘汰 / 替换不双计 / `clear` / `delete` / 按前缀只丢一个库 / 一份预算跨库共享
- `tests/cache.spec.ts` 6 例 = 发布替换后同一进程读到新库 / 替换后追加落在新库 / 文件消失后不再回答旧内容 / 两个会话共享帧而不是各自持一份预算 / 一个会话的写不驱逐另一个会话的帧 / 整段读不进预算
- `tests/flush.spec.ts` 2 例 = 批量窗口（60 秒，让定时器不可能掺和）内追加的事件在 `flush()` 之前读不到、之后读到 / 窗口再长，`flush()` 仍是那条屏障；把 `flush()` 里的 `drainLive()` 删掉这两例就都读到空数组
- `tests/reseal.spec.ts` 4 例 = 一个够长的批次把 seal 刷新到当前（`RESEAL_ROWS` 按**行**算而不是按批）/ 低于预算的批次故意不刷新（否则就是在为每批付全表聚合）/ 封帧开启时每批都刷新（折叠改写了 seal 描述的那个布局）/ 同 inode 同尺寸且复原 `mtime` 的原地重写会让 `fileStamp` 移动
- `tests/compaction.spec.ts` 6 例 = compaction 前后整段读与原始日志全等 / 窗口边界压在 compaction 中间时与整段切片全等 / 分页拼回无空洞无重复无乱序 / compaction 本身被封进压缩帧后仍如此（先断言确实有帧）/ `seal:false` 时导入不封帧且事件数完整、按默认重开后写入立刻封帧 / 同一个活连接 `retune({seal:false})` 之后继续写，帧数不再增长
- `tests/fork.spec.ts` 4 例 = cut 跨追加/读取/重开都在（标记事件落在 cut 上、`seq` 0..6 连续）/ 列表报的是整条日志的条数（含继承前缀）/ `isSeeded` 无 cut 与无 `isSeeded` 有 cut 都被拒 / 迁移引擎读出的副本带着 `isSeeded` 与 cut
- `tests/search.spec.ts` 12 例 = `semanticTextOf` 只取可读文本（忽略 reasoning 与 `completed` 收尾）/ `searchableText('排位赛')` 生成二字组 / `matchQueryFor` 把 `AND` `OR` `NEAR(` 当普通词加引号 / 中文词拆成 `("排位" AND "位赛")` / 单字与空白不成查询 / 中文二字命中 / 英文命中且 type 正确 / 无此词返回空 / 重开后索引还在 / `truncateTail` 后命中消失 / 删掉 FTS 行能自动重建
- `tests/query-engine.spec.ts` 4 例 = 会话级检索命中并给 snippet / 会话内事件检索 / 无此词空页 / `limit: 0` 抛 `positive integer`（宿主没装 `@deepseek-ai/dsh-session-query` 时整组 skip，不失败）
- `tests/metrics-journal.spec.ts` 4 例 = 窗口写盘再读回（0600、`version: 1`）/ 超出五分钟的样本不复活 / 不认识的版本与未知 op 被忽略 / 恢复不动 `lastObservedAt`
- `tests/journal.spec.ts` 4 例 = 迁移历史重启后仍在 / 中断的 `running` 读成 `failed` 并说明原因 / 非 JSON 文件被忽略 / 结束后 250ms 落盘且带版本号
- `tests/closers.spec.ts` 2 例 = 崩溃形状的日志在宿主补 `tool/result`/`step/end`/`turn/end` 之后原样存回（重开 7 条、最后一条 `interrupted`）/ 完整日志不需要收尾
- `tests/upgrade.spec.ts` 3 例 = 显式升级把 v1 搬到 v2 并同时改两处版本戳（行一条不少）/ 已经是当前版本时什么都不做 / 只读打开不改版本
- `tests/repair.spec.ts` 10 例 = 日志被剪短时列表与 `stat` 报实际持有数 / 读句柄给出幸存前缀而非拒绝 / 写句柄先改小再追加 / 截断到超长被拒且库不变 / 同一 id 两个 project 桶只列一次且打开时报歧义 / 可信长度能被快速路径接受、计数不符时退回 / 发布半途中崩掉时旧库被放回原名 / 从日志中间的追加被拒 / 替换后的库不被旧连接误读 / 逐字节相同的副本也不会被认成同一文件
- 端到端（真实 DSH + mock LLM）：
  - 新会话首轮 20 事件，`seq` 0–19 连续，`state='ready'`，`application_id=0x44534853`，`journal_mode=wal`
  - `--session-id` 续写同一会话 → 31 事件 0–30 连续
  - 再开新任务 → 生成**独立** `session.db`（一会话一库）
  - `export` → `verify`（0）→ `import` 到新 root → `verify`（0）→ `uninstall-check`（0）
  - 导入产物用真实 DSH 续写成功：20 → 42 事件，0–41 连续
  - 权限：目录 700，`session.db` / `-wal` / `-shm` / `session.lock` 均 600
- 红蓝复检（2026-11-07，两个独立子代理对打）复现并修掉的问题，都附了可重跑的脚本结论：
  - 窗口读与整段读对同一撕裂库给出不同 `eventCount` / `tornTruncateTo`（192 组「库 × 窗口」里 92 组不一致）→ 现在窗口读先验证窗口内、再验证窗口前后两段，任一处不符即回落整段走查，两条路径必须同答
  - 单条 `COUNT/MIN/MAX` 聚合在 `WITHOUT ROWID` 表上退化成 `SCAN`（10 万行 5596µs）→ 拆成三条独立查询，`MIN(seq)` 单次 14µs（`EXPLAIN QUERY PLAN` 实测：`count=SCAN`、`min/max=SEARCH USING PRIMARY KEY`、窗口读=`SEARCH (seq>? AND seq<?)`）
  - `open(id,'read')` 会解码整条日志（2 万事件 74.41ms）→ 改为只读 header（0.88ms）
  - `sizeBytes()` 会顺手 `open()` 甚至建出空库 → 只 `stat`
  - 只拷 `session.db` 发布时丢 WAL（源 21/6 事件，副本 20/5）→ 发布前 `wal_checkpoint(TRUNCATE)`，再连同边车一起搬
  - header 缓存按 `(mtime, size)` 会陈旧（`cp -p` / `rsync -t` 保留 mtime）→ 改用 store 内容签名 `store_uuid@updated_at_ms/event_count`
  - worker 崩溃后的重试会对确定性错误（库损坏）也重试 3 次 → 只在「线程已换掉」时重试
  - Windows 租约用 `wx` 独占创建，unlink 与 create 之间的竞态让两个进程都以为自己是持有者 → 改为唯一临时名 + `rename` 原子发布，再比对 inode/大小确认归属
  - `appendBatch` 不校验序号连续性，写进一个洞之后 `event_count` 会永久大于可服务前缀（实测 `event_count=4` 而前缀只有 2）→ 现在批量写入前先校验首条接得上、批内连续，并改用 `INSERT OR REPLACE`（重放同一批是幂等的）
  - `DatabaseCache` 容量为 0 时刚打开的连接会被自己淘汰再返回（`database is not open`）→ 容量下限钳到 1，且淘汰时跳过正要交出去的那一项
  - worker 重建后没有回写 `this.worker`：4 次调用起 4 条线程、`close()` 收不回来 → 回写实例，`close()` 终止当前线程；复测 `terminate → 4 次调用 → generation 2、线程数 8 → close 后 7`
  - `moveDatabase()` 逐边车 `catch{}` 吞掉所有错误，可能留下「新主文件 + 旧 WAL」→ 边车先搬、只容忍 `ENOENT`、其他错误上抛；实测 `EISDIR` 时主文件保持原位（`main file still OLD-MAIN? true`）

稳定态延迟（复检机器实测，非 GUI 首交互）：`read` p50 843µs、`list` p50 1.55ms、`stat` p50 0.55ms、`open` p50 3.38ms；worker 线程首次启动约 70–80ms（一次性）。

冷加载（2026-11-09，`lat-probe10.mjs`，47,377 事件 / 163MB 的真实库）：`stat` 42.1ms → `open('write')` 14.2ms → `read(0)` **931.9ms**，合计 **≈0.99s**；改造前同一路径 2.1–3.2s。分解见 §5.11。GUI 延迟页里 `open` 出现的几十秒不是 I/O：宿主在 resume 后要渲染 4.7 万条消息，事件循环被它按住，`performance.now()` 的差值把渲染时间也算了进去。

大历史窗口读（47374 事件 / 155MB 库，`probe-read-cost.mjs`）：窗口读 2.4–6.4ms、写者 `reseal` 2.8–3.1ms、整段解码 ~1000ms（本来就要解，无回归）。对照改动前：窗口读 442–460ms（其中 602ms 花在解码窗口外的 47324 行）。详见 §9.4。

### 9.3 真实会话回放（2026-11-07）

三个真实 DSH 会话从本机拷到 VM（只读，源文件 md5 全程未变），走完整往返：

| 会话 | 规模 | import | verify | export | verify | 逐事件比对 |
| --- | --- | --- | --- | --- | --- | --- |
| `session-de9d2349-…`（巨型/多因素） | 47374 事件，36MB zstd / 130MB 明文，`isSeeded`，30 种事件类型 | 7.6s | 0 | 0 | 0 | 47374/47374 零差异 |
| `session-eadeec0e-…`（多子代理） | 2466 事件，含 `compaction/prune`、`subagent/catalog` | 同批 | 0 | 0 | 0 | 2466/2466 零差异 |
| `session-d571d54e-…`（带部分报错） | 1434 事件，含 `deliverables/presented` | 同批 | 0 | 0 | 0 | 1434/1434 零差异 |

逐事件比对是独立脚本做的：直接读 `session_event.event_json` 与 `zstd -dc` 解出的原始 JSONL 逐条比 `type`/`seq`/`time`/`data`，三库 `mismatch=0`，`state='ready'`、`revision=2`。

这一轮回放暴露并修掉了五类真实缺陷（都是单元测试造不出来的）：

1. **`mountJsonl` 硬编码 `compression:'none'`** —— DSH 自己的 `dshHomePath('sessions')` 是 `.jsonl.zstd`，于是对真实目录跑 CLI/GUI 迁移**永远列不出一个会话**，且退出码 1 不带任何原因。现在按 root 探测编码（`detectCompression`），同一路径的两种编码是两个不同的 mount。
2. **provider 的 `list()`/`stat()` 会静默丢弃 header 解不出的会话**（内部 `readGenerationHeader` 抛错即 `continue`）——空列表与空目录无法区分。现在改为「provider 列表 + 目录遍历」，并给拒收的会话回落流式读（`salvageJsonlArtifact`），把拒绝原因写在
该会话的 `error` 上而不是丢掉整条。
3. **平铺布局**：纯 `.jsonl` root 里 provider 把日志写成 `<project>/<id>`（**id 是文件名，不是目录**）。首轮实现在这里判成「不是产物」直接跳过。现在裸文件名靠首行 header 认身份，`<id>` 与 `<id>/session.v4.jsonl.zstd` 两种形状都支持。
4. **header 的两个字段**：库里存下的 `header_json` 带着 JSONL 首行的物理标签 `type:"session"`，且 `cwd` 是 Windows 绝对路径。provider 的 header schema 两条都不收（`format v4 header has unexpected field type`、`cwd must be absolute`）。现在导出前 `headerOf()` 去掉标签、把 cwd 折成目标宿主的等价形式（`C:\x` ↔ `/mnt/c/x`，UNC ↔ `//server/share`），比较时用宿主中立键，因此**在 Windows 导入、在 Linux 导出不会被判成分歧**。
5. **`artifactPathOf` 对文件路径也去 `readdir`**，失败后返回一个不存在的 `<path>/session.jsonl`，把「列出的会话」又变回 0 条。现在先 `stat` 判文件、目录里找不到产物就返回 `undefined`。

GUI 侧同名面板对这 3 个会话同样可用：总览的空间占用表显示 47374 / 2466 / 1434 事件与 154MB / 10MB / 6.7MB，四个库都 `ready`、异常 0。

### 9.4 SQLite vs JSONL：加载与读取延迟（2026-11-07）

同一台机器、同一个会话（`session-de9d2349-…`，47374 事件，`session.db` 155.8MB / `session.v4.jsonl.zstd` 40.9MB），两侧都走各自后端的真实入口（`persistence.open` + 句柄 `read`），每个测量**重建挂载**（等价于进程第一次碰这段历史），取中位数。脚本 `bench-ops.mjs` / `probe-window.mjs`（VM 上，未入仓）。

**交互路径 —— 会话打开、翻页、恢复**

| 操作 | SQLite | JSONL | 倍数 |
| --- | --- | --- | --- |
| 打开会话读 header（恢复一次对话） | 42.6ms | 791.2ms | **18.6×** |
| 读首屏 100 条 | 10.6ms | 904.3ms | **85×** |
| 读尾页 100 条 | 6.7ms | 811.4ms | **121×** |
| 读中段 100 条（随机偏移） | 5.3ms | 740.4ms | **140×** |
| 随机位置读 200 条 | 47.7ms | 844.4ms | **17.7×** |
| `stat`（列表要的元数据） | 0.7ms | 4.9ms | 7× |
| `create` 新会话 | 30.7ms | 0.5ms | 0.02×（见下） |
| `append` 一条事件 | 2.45ms | 2.71ms | 1.1× |

打开会话只有 18.6× 而不是几个数量级，是因为 42.6ms 里包含了 worker 线程第一次启动；`inline` 模式下同一操作在 1ms 内。

**整段读取 —— 两边都必须把 130MB JSON 解成 47374 个对象**

| 实现 | 耗时 |
| --- | --- |
| SQLite `read(0)` 全量（seal 可信，`decodeTrusted`） | **669ms** |
| SQLite 同上，人为删掉 `session_seal`（退回逐行比对） | 743ms |
| SQLite `read(0)` 全量，**v2 分块压缩后**（257 帧 + 15 行尾巴） | **490ms**（`event_chunk` 一次解压 283ms + parse 287ms，探针口径；`decodeTrusted` 端到端 727ms 含对象构造） |
| JSONL `read(0)` 全量（冷挂载） | 743–905ms（中位 808ms） |
| 纯 `zstd -dc` 解压成 47375 行（不含 parse） | 653ms |
| 上述 47375 行再 `JSON.parse`（纯 JS，不碰 SQLite） | 368ms |

**分块压缩后的窗口读（同一会话，压缩前 155.8MB → 压缩后 24.9MB）**

| 操作 | 压缩前 | 压缩后 |
| --- | --- | --- |
| 读 100 条（`@0`） | 4.85ms | **2.05ms** |
| 读 500 条（`@20000`） | 10.64ms | **8.52ms** |
| 95 页全量回溯（每页 500） | 921–951ms | **814ms** |
| 单页 500 条（稳定态） | 10.6ms | **6.74ms** |
| 写一条事件（已压缩库） | 2.45ms | **1.25ms**（p50，60 轮 3×40KB） |

**结论（这是对 S8「整段读取超 JSONL 两倍」目标的实测答复）**：

- **交互路径已经远超两倍**：翻页 85–140×，恢复会话 18.6×，列表元数据 7×。这些才是对话读历史时真正发生的操作。压缩后单页再快 1.5–2×。
- **整段读取做不到两倍**：实测 669ms vs 808ms = **1.11×**；分块压缩后 490ms（1.65×）也未达两倍。下界由物理决定——两边都要产出 47374 个 JS 对象，`JSON.parse` 一项就占 ~600ms，SQL 取行只占 ~230ms。试过并被实测否掉的路：`json_group_array` 单次 parse（1018ms）、把整份日志存一行再 parse（968ms）、`v8.serialize` blob 逐行（548ms）/ 整段（484ms）、BLOB 列（与 TEXT 等价）、把 `data` 拆成独立列（537ms vs 553ms，收益在噪声内）、`.all()` 代替游标（更慢）、逐行 zstd（2.36×、全量 1229ms）。
- `decodeTrusted` 是唯一有效的杠杆：seal 可信时只取 `seq + event_json` 两列、不做逐行列比对，743ms → 669ms。代价写在 §5.3：seal 之后若不改计数地被外部改写，快路径发现不了。
- **header 与 stat 是结构性优势**：0.2ms / 0.7ms 对 0.5–4.9ms，因为它只读一行，而 JSONL 必须解压首个 frame 并校验。
- **体积**：未压缩时 SQLite 155.8MB vs JSONL 40.9MB（3.8×）；分块压缩后 **24.9MB（6.57×）**，比 JSONL 还小 39%。
- **内存**：这份会话 `read(0)` 之后 `heapUsed` 增加 255MB、RSS 452MB（47374 个对象本身就是这么大）。**没有加整段内存缓存**；只加了一个 8MiB 的**帧缓存**（解压后的块），因为它服务的是翻页而不是整段读（§5.9）。
- `create` 比 JSONL 慢 60×（30.7ms vs 0.5ms），因为新库要建 schema、写 `storage_meta`、盖 pragma、`reseal`；这是一次性成本，且发生在「用户按下发送」之前。

### 9.5 红蓝对抗复检（2026-11-08）

两个独立子代理对打：红队只找致命缺陷（不许改源码，只许写 `probe-red-*.mjs` 复现脚本），蓝队只做多方实测（只许写 `bench-blue-*.mjs`）。机器与样本同 §9.4。

**红队确认并修掉的致命缺陷**

| 缺陷 | 触发方式 | 后果 |
| --- | --- | --- |
| 日志被剪短后 `event_count` 不缩 | 崩溃/手工 `DELETE FROM session_event` | 列表承诺 40 条实际只有 25；读打开按 claim 给 `cursor`，追加把新事件写进已丢失内容的 seq，`stat` 继续撒谎 |
| `truncateTail(n)` 不校验上界 | 一次越界调用 | 同一形状：`event_count=250` 而日志只有 200 条，此后每次读都拒绝 |
| `DatabaseCache` 不校验文件身份 | 同进程内 `publishDatabase` 替换库 | 缓存连接继续服务已 unlink 的旧 inode：迁移后 `list()` 报 4 条、`read()` 只给 2 条，再追加则写进无人可达的文件 |
| 同一 id 落两个 project 桶 | Windows `C:\x` 与 WSL `/mnt/c/x` 视图同一 root | `list()` 列出两次，`open`/`stat` 全部抛「stored more than once」，谁也打不开 |
| `search-index.db` 与 `-wal` 是 `0644`（**该模块后来整体删除**） | 索引里是截断到 4096 字符的对话正文 | `stateDirectory` 配到共享目录时正文可读。修好后又按用户裁决删掉了整套自建索引，此缺陷随之消失 |

修法：`loadSession` 以「物理条数 < claim」判定撕裂（前缀变短是连续的，唯一证据就是这个数）、读打开用 `storedEventCount()` 取实际长度、`list()`/`stat()` 用 `HEADER_SNAPSHOT_SQL` 里的 `held_event_count` 一列一次算完、`truncateTail` 前置校验 `n ≤ claim`、`DatabaseCache` 按 `dev/ino` 判身份、`list()` 对重复 id 只列一条并 warn。回归测试见 `tests/repair.spec.ts`（10 例）与 `tests/cache.spec.ts`（6 例）。

红队同时确认**不是缺陷**的项（摘）：`assertContiguous` 拒绝重叠写；16 个截断点（块内、块边界、尾边界）三方一致且 `types_json` 直方图正确收缩；窗口读 128 组逐条相符；`streamEvents` 47374 条与 `inspectEvents` 350 组零差异（两个函数后来随事件视图删除，§7.10）；1295 个真实 `session.db` 中 1291 自洽；`encodeSegment` 无路径穿越。

**蓝队实测（47377 事件库：压缩 24.9MB / 未压缩 155.6MB，p50）**

| 操作 | 冷（新进程+新挂载） | 热（同句柄） |
| --- | --- | --- |
| `list()` 50 / 200 / 1000 会话 | 22.7 / 44.9 / 163.7ms | 200 → 2.04ms，1000 → 8.02ms |
| `stat()` | 2.47ms | 0.12ms |
| `open('read')` | 2.07ms | 0.16ms |
| `open('write')` | **4.72ms**（`trustedLength` 快路径） | — |
| 窗口读 20 / 100 / 500 | 5.48–6.11 / 6.10–6.50 / 14.0–19.6ms | 0.14–1.85ms |
| `read(0)` 全量 | 949ms，heap +256MB | — |
| 95 页回溯（每页 500） | 739.8ms 合计，p50 5.77ms | — |

界面（真实 Chrome，click→轮询文案，不含 rAF 与进程首启）：面板首渲 104.4ms、tab 挂载 32.6ms、各 tab 切换 7.8–37.0ms、对话转换视图首渲 14.8ms、克隆 1434 事件端到端 1.1s。当时还有会话/事件/诊断三个视图（各自 3368 节点的会话表、1235 节点的事件表、载入更早 35.6ms 与 `scrollTop` 锚定 +1400），它们在 2026-11-08 按设计稿删除，数字保留作为那一版的历史记录。

蓝队三条建议的处理：①「10 次连点只生效 4 次」——真缺陷，改为**计数排队**（`QUEUE_CAP = 8`，一次一页，落定后发下一张），真实浏览器复测 `50 → 550`（10 页）、节点恒 1403；②「已压缩库 `compact()` 永远早退」——**实测否证**，压缩库 257 帧最大帧仅 161KB（compressed）/ 512KB（raw），24.1MB 是 257 帧之和，被误读成单帧；③「`/search` 每请求都全量 `syncRoot`」——真缺陷，1000 会话约 +350ms/请求，当时加了 2 秒 TTL 与分段推进；该模块随后整体删除（§7.9）。

蓝队自评不可靠项（已标注，未用于结论）：`list 200` 冷态 ±20%、`read(0)` 热冷对比、UI 全部单样本。未覆盖：进程级真冷（OS 页缓存无法排除）、并发与写租约争用、>1000 会话、`WorkerExecutor` vs `inline` 对照、CPU profile / heap diff。

**与 JSONL 的成本位置不同，而不是谁更快**：`open('read')` SQLite 压缩 1.08ms vs JSONL 1117.09ms（**SQLite 在 open 上快约 1000×**）；`read(0)` SQLite 1194.89ms vs JSONL 8.19ms（**已打开后全量读 JSONL 快 146×**，因为它在 open 时就把整份日志解码进内存）。SQLite 把成本推迟到真正读取的那一刻，换来冷启动、翻页与 header 的结构性优势。

### 9.6 冷读、导航切换与稳定性（2026-11-08）

这一轮先量「用户点下去到看得见」花了多久，再决定动哪里。任务表与逐条结论见 `阶段四任务表.md`。

**端到端时间线（真实浏览器，同一会话切走→点回 5 轮）**

| 指标 | 值 |
| --- | --- |
| 点击 → 第一个新的业务行 | **p50 300ms / p95 361ms** |
| 该次提交的 LongTask | 1–2 条，最长 158–215ms |
| 业务行 / DOM 节点 | 272 / 7147 |
| 堆 | 94–133MB |

这 272 行只对应 **2 个 turn**；4.7 万事件几乎全被折叠进 `turn-process`。**所以首屏成本由 Turn/Node 数量决定，不由事件数决定**——同一时刻后端读一页只要 3–4ms。

**「加载更早」没有行上限**：连点 6 次，业务行 272→1331，DOM 节点 8542→**28450**，堆 97→176MB，`scrollHeight` 6995→12446。行与节点只增不减。

**结论与边界**：这两处都在官方 `ui-chat` 的 `ChatFlow`（`entries.map` 全量挂载），第三方插件**无法合法接管**——`conversation.chat.flow` 虽是 `single` 槽，但子槽 `conversation.chat.node` 的声明权唯一，替换者拿不到节点渲染能力；剩下只有 DOM 注入 / patch asar，明确不做。证据与建议改动已整理成 `资料/参考资料/上游问题_长会话首帧.md`，可直接贴进 Discussion。

这段测量用的是本插件当时自带的事件表（已按设计稿删除，§7.10）。它对官方对话视图的结论不受影响：那里的行数是官方的 `ChatFlow` 决定的。

**这一轮落地或否证的五件事**

| 任务 | 结论 |
| --- | --- |
| 搜索索引首建进度 | 当时做了 `syncRootSteps()` 生成器 + 每请求推进 8ms + 前端进度；**后来整套自建索引被删**（§7.9），这项一并作废——官方的首建没有进度可看，是它的已知短板 |
| Chunk 稀疏偏移表 | **测量否证**：窗内解压只占 7.9%，成本逐帧而非逐连接。改为「只解析窗口内的行」——冷窗 5.349→**3.675ms**（−31%）、温窗 1.107→**0.728ms**（−34%），没有新增 schema 列 |
| 全局帧缓存预算 | 8MiB 从「每个 `SessionDatabase` 一份」改为 executor 级共享（键带库路径），一次写只 `deletePrefix` 自己那些帧。曾经的 `/diagnostics` 读数随诊断视图一起删除（§7.10） |
| 会话路径目录 | **测量否证**：200 个 project 桶下定位单个会话 0.496ms，而一份 5000 条目的 catalog 读一次 2.434ms。不做 |
| 预热让路 | 以 `metrics.lastObservedAt` 作「有人在我身上等」的信号（预热自己的读不走 `time()`，不会自饿），交互即停泊，30 秒预算后放弃 |
| 整段读取 | 不分块、不拒绝：分块会改 `read()` 返回类型（违反契约），拒绝会让深跳失败。只让整段读**不进帧缓存**——47k 事件库实测多留 8MiB、零命中 |

**正确性回归**：`tests/compaction.spec.ts` 覆盖 compaction 与分页边界的四种组合（含「compaction 本身被封进压缩帧」），拼页与整段读逐条相等。构造 fixture 时踩到的两条官方规则（`system/message` 的 `source.kind` 必须是 `system-prompt`；`compaction/*` 与 checkpoint 必须重复同一 `sourceCommandId`）已记进任务表，因为 `appendImported()` 不做这些校验——写错时 seed 阶段不报错，只有读回才失败。

### 9.7 第二轮红蓝对抗：性能与资源（2026-11-09）

红队只做静态阅读（不改源码、不跑测试），专找**性能与资源**问题：写入放大、缓存不省事、缓冲无界、轮询放大、定时器与租约泄漏。蓝队逐条复核修复是否成立。

**红队 10 条与处置**

| # | 发现 | 处置 |
| --- | --- | --- |
| 1 | `appendBatch` 每次提交后无条件 `reseal()` → `logChecksum()`，那是对整张 `session_event` 的聚合；关掉封帧时尾部永不折叠，写入变 O(N²) | 改为**每 4096 行**一次（`RESEAL_ROWS`，正好是 `trustedLength()` 不再信任词表扫描的阈值），`truncateTail`/`markReady` 仍精确 reseal；另修掉一处死代码：`trustedLength()` 的闸门原来问「有没有 `event_chunk` 表」，而可写打开必建该表，所以全尾 `SELECT DISTINCT` 从未被挡——改成问 `sealedRows().count` |
| 2 | `rowCached` 先完整 `readOne()`（open + pragma + select + 逐 chunk `JSON.parse`）再查缓存 —— 缓存从不省 open | 先取 `fileStamp`（`dev:ino:size@mtime@ctime`，含 `-wal`），命中即返回；缓存值改为随 stamp 存。加 `ctime` 是因为它才是写者改不动的时间戳：同 inode、同尺寸、把 `mtime` 复原的原地重写，只有它能识破 |
| 3 | 写失败置 `drainPaused` 后不再装定时器，而 `flush()` 不排空活缓冲 ⇒ 事件一路堆到 `close()` | `flush()` 先 `drainLive()` 再物化 header（排在 `chain` 之外，否则等自己）；暂停标志保留，`drainBuffered()` 与 `close()` 是恢复路径 |
| 4 | `compact()` 声称峰值 3–4× 文本 | **不成立**：`frames` 持有的是压缩后 payload，峰值约压缩尾部的六分之一。改成一帧一事务会带来约 200 次提交和中间布局暴露，不做 |
| 5 | 迁移进行中每 700ms 重拉 `/roots`（每候选 1+P 次 readdir，跑在宿主唯一线程上） | 拆成两个 effect：roots 只在根目录或任务落定时拉，轮询只拉 `/migrations` |
| 6 | `snapshot()` 每 op 60 桶 × 4096 样本过滤；环满逐条 `splice`；窗口内单 op 超 13.65 样本/秒就丢样本 | `MAX_SAMPLES` 4096 → 8192，环满一次砍掉 3/4；`snapshot()` 改单遍分组后逐桶排序 |
| 7 | 帧缓存按未压缩字节计费，驻留的却是 `string[]`（非 Latin-1 双字节）⇒ 8MiB 预算可驻留两倍 | 新增 `residentBytes()`，按字符实际占用量计费 |
| 8 | `acquireWin32` 用 `rename` 并假设 `EEXIST`，但 Windows 的 rename 是替换、永不 EEXIST ⇒ 两个进程都能"抢到"写租约 | 改为 `open(path, 'wx')` 独占创建（`CreateFile(CREATE_NEW)`），只有一个赢家 |
| 9 | `close()` 在 await 往返之后才置 `closed`，那 2 秒窗口内 `call()` 仍照收 | 先置位再等；close 自己的 RPC 用一个只有它传的开关穿过这道门 |
| 10 | `HeaderCache.read` 每次 3 次 stat | 新增 `fileStampWithSize()`，一次调用同时给出 stamp 与尺寸 |

**红队判定干净的面**：`retune` 每次缓存命中只写一个字段；RPC 重试不会重放写；worker 崩溃不会让 pending 永久拒绝；帧缓存不超预算；`reseal`/`compact`/`truncate` 都正确清理前缀缓存；语言切换只重渲染一个视图；没有定时器、监听器或租约泄漏；写热路径上没有按行 stat/open。

红队顺手纠正了一个前提：面板**没有** overview/settings/metrics 的周期轮询，唯一轮询是对话转换视图在任务运行时的那一个 —— 所以第 5 条的放大是真的，其余视图没有同类问题。

**两条修正在对抗中被推翻重做**：第 1 条最初按"每 32 批"摊销，蓝队指出 31/32 的读会看到过期 seal（`marker` 是 `event_count@revision`，一写就变），于是恢复会话退回全量 walk——省了写，赔了读。改成按行后两条成本在同一阈值上相交。第 2 条的 stamp 最初只有 `dev:ino:size@mtime`，蓝队的结论是"缓存会在同尺寸复原 `mtime` 的改写后继续回答旧内容"；加 `ctime` 才真正封住。

**这两个修复都做了变异验证**（`tests/reseal.spec.ts`，4 例）：把 `resealAfterWrite` 改成"每批必刷"→ 第 2 例失败；改成"永不刷新"→ 第 1 例失败；把 stamp 里的 `ctime` 拿掉 → 第 4 例失败。三个变异各自只打中一条断言，恢复后全绿，说明这些用例真的在守那三件事，而不是陪跑。

**一条契约优先于红队结论**：#3 里"新事件到达就重新武装定时器"看起来是自然的恢复手段，但官方 `tests/vendor/live-write-contract.ts` 明确要求失败后定时器保持安静、事件按序保留，而 `flush()` 才是重试与观测的屏障。所以只修了 `flush()` 不排空那一半。这条改动先按"改了"提交，随后补了 `tests/flush.spec.ts`（2 例，把批量窗口设成 60 秒，让定时器不可能掺和）：**把 `flush()` 里那行 `drainLive()` 删掉，两例都读到空数组**；恢复后通过。没有这条证据，这次修改只是"看起来改了"。

---

## 10. 已知限制

1. **Windows 未验证**。POSIX 走 `flock`；Windows 用「唯一临时名 + `rename` 原子发布 + 归属比对」的标记文件（`src/lease.ts`），算法已不再依赖 `wx` 跨 unlink 的原子性，但仍未在 Windows 主机上跑过。不宣称支持。
2. **删除与分支都由 DSH 自己做，插件只负责存得住**。归档（`archiveSession`）只写宿主的 registry，不碰 persistence；fork 靠运行期的语义原样存储（§5.10）；插件不提供自己的删除入口，也不做「同一个库里分多条 branch」与 tombstone 标记。
3. **会话数上万时 `open(id)` 会变慢**：没有 id → 路径的索引，只能扫 `root/*/<encoded id>/`，成本与官方 JSONL `findLog` 相同。
4. **不做隐式 schema 迁移**：`user_version` 高于本版本时拒绝打开，升级必须走显式工具。
5. **大历史的 `list()` 会读每个库的 header**：一会话一库的固有成本。已优化为一条合并 SQL + 一次 `stat`，并用文件戳缓存跳过未变的库：200 会话冷态 43ms、热态 1.5–4.7ms（原 79ms）。
6. **`session.lock` 在 POSIX 上不会消失**：释放只关 fd、不删文件（删了会让两个进程各锁一个 inode）。所以只要有人把会话目录整个删掉，锁文件也一起没了；否则残骸只会出现在「进程崩在会话目录里」这种情形。
7. **控制台的 header 缓存只在进程内**：按「store 内容签名 + 文件大小」失效、**按字节预算（8MiB）淘汰**，进程重启即丢。已打开的数据库连接同样按 `dev/ino` 校验：`publishDatabase` 用 rename 覆盖一个库之后，旧连接不会被当成同一个文件继续服务。
8. **延迟统计只有一个滑动窗口**：最近五分钟，跨重启保留窗口内的样本（`<state>/latency.json`），但没有跨进程聚合、没有按天/按周的历史趋势，也没有 p99 之外的分布数据。
9. **转换任务只在内存**：任务对象不持久化，进程重启后 `/migrations` 为空；未完成的 run 只剩磁盘上的 staging 目录，需要人工确认后重跑。
10. **控制台没有任何破坏性操作**：清空、修复撕裂尾只发生在会话写路径里。能否删除一个对话由 DSH 的归档流程与文件系统决定，插件不提供第二个入口；会话目录被外部删掉之后，`list()` 不再列出它，混合模式的路由表则在下一次 `list()` 时自愈（§5.7）。
11. **旧库第一次被可写打开时会补辅助对象**：`session_seal`、`session_event_fold`、`event_chunk` 由可写打开补齐（`CREATE ... IF NOT EXISTS`，幂等；只有真正落块才升 `user_version` 到 2）。**纯读连接（控制台、索引器、预热）绝不建表**——v1 库读完之后仍然没有 `event_chunk`、版本仍是 1、字节数不变（`tests/legacy.spec.ts` 断言了这三点）。
12. **`cwd` 会被迁到打开方宿主的形式**：Windows 上写的 `C:\APP\x` 在 Linux 上存成 `/mnt/c/APP/x`。迁移写入前就归一（做不到就拒绝，不留打不开的库），比较用宿主中立键，所以不会被判成分歧，但库里的字面值会变。
13. **整段读取只有 1.11×（压缩后 1.65×）**：见 §9.4。交互路径（翻页、恢复、列表）是 7–140×，但要一次拿回 47374 个事件时，两边都得解 130MB JSON。
14. **`decodeTrusted` 用 seal 换取 ~10%**：seal 之后若被外部工具改写而计数未变，快路径不会察觉；删掉 `session_seal` 可强制退回逐行校验。
15. **`create` 比 JSONL 慢约 60×**（30.7ms vs 0.5ms）：新库要建 schema、写 `storage_meta`、设 pragma、`reseal`。发生在用户按下发送之前，不在对话流里。
16. **压缩只在提交后发生**：`compact()` 由写路径触发，一次性导入也在 `appendImported` 之后立刻压。已经很大的旧库需要一次 `compact()`（或等下一次写入跨过半个块的预算）；`VACUUM` 只在旧库首次封口时自动做一次。
17. **帧缓存跨库共享，预热按会话局部**：帧缓存是 8MiB 的**一个**预算，由 executor 持有、按库路径前缀分区，因此多开几个会话不会把内存乘几倍，但读一个新库时也会挤掉旧库的帧；整段读不进这个预算。预热只覆盖最近改动的 5 个会话，其余仍是首次点击时解压。
18. **自建检索要显式开启，且与官方索引互斥**：`ownSearch: true` 时由本插件回答 `ctx.sessionQuery`，必须同时移除 `@deepseek-ai/dsh-session-query-sqlite`（§7.9）。不开时索引表仍然在写，只是没人查。
19. **控制台不带会话阅读器**：会话列表、事件表与诊断视图在 2026-11-08 按设计稿删除（§7.10）。要看历史、翻事件、查单个库的细粒度诊断，用 DSH 自己的对话视图或 CLI（§6）。
20. **设置面板只有一个字节的写权限范围**：它只写 `<stateDirectory>/console-settings.json`（§7.11），不碰会话库、不改 profile、不动路由表。改 `format` 只影响**之后**新建的对话，已存在对话的归属在 `catalog.json` 里，且只能靠对话转换改变。
21. **自建检索索引的是「可读文本」，不是全部字段**：消息正文、工具调用（名称 + 参数）、工具输出与错误名，reasoning 块与 `completed` 的 turn 收尾不入索引——它们不是人在找的东西。
22. **两个格式都要挂载才能切**：`formatsOf()` 只报本安装真能创建的后端。现在只要配置了 `jsonlRoot`（哪怕 `hybrid` 为 false）就按混合模式挂载，两张格式卡都可用；完全不配 `jsonlRoot` 时 JSONL 卡是禁用的——给一个点了没反应的开关比不给更糟（§7.11）。
23. **整段读的峰值堆无法从插件侧压下来**：`read(0)` 在 47361 事件上是 1123ms / +244MB（分页读同量级时间，但峰值 1MB/页）。契约要求 `read()` 一次返回全部事件，分块交付会改变返回类型——想避免只有调用方少调它。
24. **自建检索的 CJK 匹配是二字组，不是任意子串**：单字查询（「位」）不进索引，三字词靠两个二字组的 AND 命中——这是「不引第三方分词器」和「能搜到中文」之间的取舍；代价是命中率高于官方整词、但仍不是子串搜索。
25. **列表里的条数是实际可读的条数**：`held_event_count` 让 `list()`/`stat()` 报告物理持有的前缀而不是行里的 claim，因此被外部剪短的库在列表上就少报。代价是每次列表多一个 `sum + count` 子查询（1000 会话冷态 163.7ms 里的一部分）。

---

## 11. 开发

```bash
npm install
npm run typecheck      # tsc --noEmit（Host 半边）
npm test               # 契约 + 迁移 CLI + 混合路由 + 对话转换 + 控制台 + 偏好文件 + 分支 + 分块压缩 + 预热 + 损坏修复 + compaction 回归（需 Node 24.9+）
npm run build          # → lib/*.js + *.d.ts + lib/client.js
```

客户端类型检查需要单独一步（`client/` 不在 `tsconfig.json` 的 include 里）：

```bash
npx tsc -p tsconfig.client.json --noEmit
```

源码结构：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：`name` / `Config` / `apply`（单后端与混合两种挂载）/ `SqliteSessionPersistence`（create/open/stat/list/flush + 存储缝）、mount 后的预热调度 |
| `src/storage.ts` | handle 生命周期、promise chain、200ms 实时窗口、tracker 路由、root 扫描 |
| `src/database.ts` | 同步引擎：PRAGMA、schema 初始化、事务写入、预编译语句缓存、分块压缩（`compact`/`reclaim`）、窗口化读、`sliceTrusted`、`decodeTrusted` 全量快路径、seal 校验、撕裂尾识别、`storedEventCount` / `trustedLength` |
| `src/chunk.ts` | 块编码：`encodeChunk` / `decodeChunk` / `decodeChunkLines` / `decodeChunkRange`（512KiB 未压缩预算，zstd L3，换行分隔；窗口读只 parse 窗口内那几行） |
| `src/lru.ts` | `ByteLru`：按字节预算淘汰的 LRU，单条超预算仍保留；`deletePrefix` 让共享缓存只失效一个库 |
| `src/warmup.ts` | mount 后预热最近会话的尾部窗口，分批让出事件循环；交互即停泊（`quiet()`），30 秒预算后放弃 |
| `src/schema.ts` | DDL、`SCHEMA_VERSION = 2`、`READABLE_VERSIONS`、`APPLICATION_ID`、辅助对象（seal / fold 索引 / `event_chunk`） |
| `src/format.ts` | 目录编码（与官方 JSONL 逐字节一致） |
| `src/lease.ts` | 跨进程写租约 |
| `src/executor.ts` | `StorageExecutor` 接口 + 有界 LRU（按 `dev/ino` 判断文件是否被替换）+ `HeaderCache`（文件戳缓存）+ 批量 `listHeaders` + `InlineExecutor`（持有全局帧缓存） |
| `src/worker-client.ts` / `src/worker-entry.ts` / `src/rpc.ts` | Worker 模式：RPC、错误重建、崩溃时 reject 在飞请求 |
| `src/router.ts` | `HybridSessionPersistence`：一个 `SessionPersistence` 席位，按路由表把每个会话分派给 SQLite 或 JSONL |
| `src/catalog.ts` | 路由表（`session-backends.json`）：原子写、可重建、记录 clone 的 `originSessionId` |
| `src/migrate.ts` | 对话转换引擎：列举/分页/标题、staging + 回读 + 租约发布、覆盖与克隆、`archiveSource`、任务对象与进度 |
| `src/discover.ts` | 自动识别候选根目录（profile 配置、`~/.dsh`、同级目录），让页面不必让人手填路径 |
| `src/inspect.ts` | 只读探查：扫库、读 header、按大小排出的占用表、目录权限与逐库 `problem`（`readOnly: true`，不写盘） |
| `src/preferences.ts` | 面板偏好（`console-settings.json`）：逐字段回退的读、`0600` + rename 的原子写、部分更新的严格校验、读到就 apply |
| `src/about.ts` | 版本与链接：`installedVersion()`（重读 `package.json`）、`resolvedDshVersion()`（解析 `@deepseek-ai/dsh-session`）、只在真实声明时才给的三个链接 |
| `src/search.ts` | CJK 二字组分段、`matchQueryFor`、`semanticTextOf`、`snippetOf` |
| `src/query-engine.ts` | 自建的 `ctx.sessionQuery` 引擎（`ownSearch`），动态解析官方基类 |
| `src/diagnostics.ts` | 进程内问题记录 + 卸载前检查 |
| `src/console.ts` | 控制台 Host 半边：11 条 exact Fetch 路由（`/settings` 一条 path 按 method 分派）、参数校验、状态码 |
| `src/transfer.ts` | 读写原语：`mountJsonl`、`stageCopy`、`publishDatabase`、`storableHeader`、header/cwd 归一、比对 |
| `src/metrics.ts` | 七项操作的真实延迟采样（环形缓冲 + 5 秒分桶 + 分位；窗口可导出/恢复） |
| `src/metrics-journal.ts` | 延迟窗口落盘（`<state>/latency.json`，15 秒一次、0600、读回只留窗口内） |
| `src/cli.ts` | `import` / `export` / `verify` / `uninstall-check`（坏库只报差异不抛） |
| `client/` | 浏览器半边：`ConsolePage.tsx`（四视图与总览）、`TransferTab.tsx`（对话转换）、`MetricsTab.tsx`（延迟折线）、`SettingsTab.tsx`（设置）、`i18n.ts`（中英两份完整文案）、`api.ts`、`library.ts`、`styles.ts`、`index.ts`（slot 注册）、本地 `ambient.d.ts` |
| `scripts/build-client.mjs` | rolldown 打包 `client/index.ts` → `lib/client.js`（`__ModuleLoader__` 形态；`@tanstack/react-virtual` 外置） |
| `tests/vendor/*.ts` | 官方两套契约（从 `@deepseek-ai/dsh-session-persistence` 的测试源 vendor 而来） |
| `资料/参考资料/上游建议-afterSeq对称分页.md` | 给上游的分页建议：从 `file:line` 现状到契约设计、成本与验收断言 |

## 许可

MIT
