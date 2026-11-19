# 命令行

> English: [docs/en/cli.md](en/cli.md)

<!-- docs-nav -->
[文档](../README.md#文档) · [架构](architecture.md) · [配置](configuration.md) · **命令行** · [控制台](console.md) · [基准测试](benchmarks.md) · [限制](limitations.md) · [开发](development.md)

包内提供一个可执行文件 `dsh-session-optimizer`（由 `src/cli.ts` 构建，经 `package.json` 的 `bin` 暴露）。它只操作目录、不挂载插件，因此可以在 DSH 关闭时处理存储，也能在不碰 profile 的情况下做迁移、校验与导出。

```
Usage: dsh-session-optimizer <command> [options]

  import           把 JSONL 根中的会话复制成一会话一库
  export           把 SQLite 中的会话写回 JSONL 根
  verify           对比 SQLite 副本与 JSONL 原件
  uninstall-check  列出只存在于 SQLite 的会话（此时卸载不安全）
  upgrade          把存储升级到本构建的布局版本
  compact          封口尾部并交还空闲页

  --from <dir>     源根（import/verify 为 JSONL 根，export 为 SQLite 根）
  --to <dir>       目标根（import 为 SQLite 根，export 为 JSONL 根）
  --root <dir>     SQLite 根（uninstall-check、upgrade、compact）
  --jsonl <dir>    JSONL 根（uninstall-check）
  --session <id>   只处理这个会话（默认：源根内全部会话）
  --force          覆盖已存在的目标会话
  --json           在 stdout 输出机器可读报告
```

退出码：`0` 成功，`1` 校验或安全失败，`2` 用法错误。

## 复制进 SQLite

```bash
dsh-session-optimizer import --from ~/.dsh/sessions --to ~/.dsh/sessions-sqlite
dsh-session-optimizer import --from ~/.dsh/sessions --to ~/.dsh/sessions-sqlite \
  --session <sessionId> --json
```

* JSONL 一侧始终通过官方 provider 读取，因此两种编码（`.jsonl` 与 `.jsonl.zstd`）与两种布局（扁平与一会话一目录）都支持。
* 会话先暂存到 `<session.db>.importing`，逐事件回读比对后再 rename 就位。崩溃会留下暂存文件，控制台总览会把它列出来而不是隐藏。
* 发布前先取目标目录的写租约。
* 不带 `--force` 时，已存在的目标会话被跳过并计入报告。

## 复制回 JSONL

```bash
dsh-session-optimizer export --from ~/.dsh/sessions-sqlite --to ~/.dsh/sessions
dsh-session-optimizer verify --from ~/.dsh/sessions --to ~/.dsh/sessions-sqlite
```

`export` 是镜像流程：暂存到 `<session dir>.exporting`、回读比对、再对内层会话目录做原子 rename。`verify` 双侧逐条比对 header 与全部事件，是删除存储前该跑的检查。

header 会按接收方主机归一：去掉物理的 `type: "session"` 标记，并把 `cwd` 折叠成打开方可接受的绝对路径（`C:\APP\x` ↔ `/mnt/c/APP/x`，UNC ↔ `//server/share`）。目标主机无法表达该 `cwd` 时拒绝转换，而不是写一个宿主会拒的 header。

## 安全卸载

```bash
dsh-session-optimizer uninstall-check --root ~/.dsh/sessions-sqlite --jsonl ~/.dsh/sessions
dsh-session-optimizer export --from ~/.dsh/sessions-sqlite --to ~/.dsh/sessions
# 然后删除插件，并从 cordis.patch.yml 去掉两条补丁
```

`uninstall-check` 列出只存在于 SQLite（`sqlite`）、只存在于 JSONL（`jsonl`）、孤立目录与无法读取的库。不先导出 `sqlite` 那一列就卸载，那些会话就丢了。

## 升级存储

```bash
dsh-session-optimizer upgrade --root ~/.dsh/sessions-sqlite
```

`upgrade` 把存储迁移到本构建写入的布局版本，每个会话一个 `BEGIN IMMEDIATE` 事务；它是除 `compact()` 之外唯一会提升 `user_version` 的操作。

## 回收空页

```bash
dsh-session-optimizer compact --root ~/.dsh/sessions-sqlite
dsh-session-optimizer compact --root ~/.dsh/sessions-sqlite --session <sessionId>
```

`compact` 先封口还值得成帧的尾部，再把空闲页交还。写入路径上的 `compact()` 只回收它自己刚腾出的页，尾部已经小于半帧的库会直接返回，截断留下的空洞就一直占着文件。这条命令不在追加路径上，按每 1000 页一批做 `incremental_vacuum`，避免一次语句把工作集溢出到 WAL。
