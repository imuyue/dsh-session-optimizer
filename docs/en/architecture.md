# Architecture

> 简体中文：[docs/architecture.md](../architecture.md)

<!-- docs-nav -->
[Docs](../../README.en.md#documentation) · **Architecture** · [Configuration](configuration.md) · [CLI](cli.md) · [Console](console.md) · [Benchmarks](benchmarks.md) · [Limitations](limitations.md) · [Development](development.md)

The plugin replaces the official JSONL session backend with one SQLite database per conversation. It keeps the `sessionPersistence` contract of DSH (`@deepseek-ai/dsh-session`), so the host, the console, compaction, fork and resume all keep working without changes to the host.

```
DSH host process
├── sessionPersistence service      src/index.ts, src/storage.ts
├── worker thread (storageThread)   src/worker-entry.ts  →  src/database.ts
├── HTTP console (owner only)       src/console.ts       →  src/inspect.ts
└── client plugin (web)             client/              ←  lib/client.js
```

## On-disk layout

```
<root>/
├── --<projectKey(cwd)>--/                encoded exactly like the official backend
│   └── <encodeSegment(sessionId)>/
│       ├── session.db                    the session
│       ├── session.db-wal                write-ahead log
│       ├── session.db-shm                shared-memory index
│       └── session.lock                  write lease (flock)
├── .migrating/                           staging area for a whole-root migration
└── <stateDirectory>/                     default: <dirname(root)>/session-backends
    ├── session-backends.json             routing table (which id lives where)
    ├── console-settings.json             console preferences
    └── latency.json                      latency journal
```

Directories are created `0700`; the database and its sidecars are `0600`. A session whose header carries no `cwd` lands in `_no-cwd/`. The encoding of directory names is byte-identical to the official backend, so the same conversation maps to the same path in both backends.

## Schema

```
PRAGMA application_id = 0x44534853 ('DSHS')
PRAGMA user_version   = 2
PRAGMA auto_vacuum    = INCREMENTAL
PRAGMA journal_mode   = WAL
PRAGMA synchronous    = FULL
PRAGMA busy_timeout   = 5000
```

| table | shape | purpose |
| --- | --- | --- |
| `storage_meta` | singleton row | `store_uuid`, `schema_version`, `dsh_contract_version` (4), timestamps |
| `session` | singleton row | `session_id`, `header_json`, `inherited_event_count`, `event_count`, `revision`, `state` (`importing` \| `ready`) |
| `session_event` | `seq` primary key, `STRICT`, `WITHOUT ROWID` | `event_type`, `event_time_ms`, `event_json` — the tail that is not yet chunked |
| `session_event_fold` | index on `(seq, event_time_ms, event_type)` | key-only folding for window reads |
| `session_seal` | singleton row | `marker` = `<event_count>@<revision>`, `checksum` = `n:Σlength(type):Σtime:min(seq):max(seq)` |
| `event_chunk` | `first_seq` primary key | `last_seq`, `event_count`, `raw_bytes`, `compressed_bytes`, `codec='zstd'`, `types_bytes`, `times_total`, `types_json`, `payload BLOB` |

`READABLE_VERSIONS = [1, 2]`. A read-only connection never creates a table: an empty file is opened as empty, and a database with a foreign `application_id` is reported as corruption instead of being repaired silently.

## Write path

1. `append()` takes a deep snapshot of the batch and validates that every event survives a JSON round trip.
2. Batches go through a single promise chain, so commits are serialised per session.
3. `persistContiguous()` acquires the write lease, asserts that the first sequence number is exactly `event_count`, truncates a torn tail, and writes one transaction: `INSERT` rows, bump `event_count` and `revision`.
4. After the commit, the seal is refreshed and chunking may run.

One `append` is one `BEGIN IMMEDIATE … COMMIT`. `flush()` is a barrier: it resolves only after everything queued has been committed. The live hook uses a fixed 200 ms window with a single in-flight drain; a failed drain puts the batch back at the head of the queue and parks the timer until the next `flush()`. If both the drain and the lease release fail, the error surfaces as an `AggregateError`.

## Read path

`open(id, 'read')` reads the header only. `open(id, 'write')` scans `root/*/<encodeSegment(id)>/session.db`; a session id found under two project directories is reported as corruption. The header inside the database is the only authority on the id.

A torn tail is defined as: `seq` differs from the row index, a JSON parse fails, or a redundant column disagrees with the JSON. Everything from the first invalid row counts as damaged: reads return the valid prefix and record `tornTruncateTo`, writes delete the tail and log a warning. The backend never guesses content.

Window reads:

| condition | what happens | typical cost |
| --- | --- | --- |
| `session_seal` matches and the range is covered | key-only fold over `session_event_fold`, no JSON decode of skipped rows | 2–7 ms |
| no seal, or seal invalid | row-by-row decode of the whole log | 700 ms+ |
| whole-log read | `decodeTrusted()` selects `seq, event_json` only | 669 ms for 47,374 events |

The seal is recomputed by the write path after every commit (`appendBatch`, `appendImported`, `truncateTail`, `markReady`, `materializeHeader`).

## Worker thread

`storageThread: 'worker'` (the default) moves every synchronous SQLite call off the host thread. The protocol is `{rid, op, args}` → `{rid, ok, result}`; errors are rebuilt by name. When the worker crashes, every in-flight request is rejected immediately instead of hanging. `inline` exists for tests only.

## Write lease

One writer per session, taken with `flock` on `session.lock`. Failing to take it raises `SessionAlreadyOwnedError`. The lease compares `fd` inode and device to survive a file replacement, and releasing it only closes the descriptor — the lock file is never deleted.

## Chunking (`compact()`)

`compact()` runs after a commit and its reseal, and returns early when the un-chunked rows are smaller than half a chunk. It groups rows into 512 KiB (uncompressed) groups, zstd level 3 each, writes `event_chunk` and deletes the rows in one transaction; `reclaim()` gives pages back to the filesystem.

* 512 KiB is the measured sweet spot: 1 MiB chunks bought only 2 MB more space while doubling window-read latency (6.44 ms → 10.68 ms).
* The seal is **not** recomputed after chunking; `types_bytes`, `times_total`, `first_seq` and `event_count` fold into exactly the same values, so the result is byte-identical to the pre-chunk seal.
* `auto_vacuum` must be enabled at creation: a database created without it grew from 163 MB to 186 MB on its first compaction.
* `truncateTail` is chunk-aware: cutting into a chunk re-materialises the prefix rows.

## Frame cache and warmup

Decompressed chunks live in an 8 MiB byte-LRU (`src/lru.ts`). Any write clears the cache (reseal, compact, truncateTail). With 8 chunks resident, a 95-page backfill needed 269 decodes instead of 445 (951 ms → 637 ms). A whole-log read takes its pages as `'lines'` — the page is handed over as strings, which skips the join/encode/transfer/decode/split round trip — while `readPage` still answers in the negotiated format.

`warmupSessions` (default 5) preloads the tail of the most recent sessions after mount and builds their search index: the first tail window drops from 6.1 ms to 1.0 ms, and the first search on an old database drops from 5.7 s to about 50 ms. Warmup has a 30 s budget and stays quiet on failure.

## Forked sessions

A fork stores three things and validates them on open: `header.isSeeded = true`, `inherited_event_count`, and a `session/end-seed` event at the cut point with `data.inherited = true`. The error messages are `seeded session header requires an inherited event count` and `unseeded session header inherited event count must be 0`. Inherited prefix events are re-appended with contiguous sequence numbers starting at 0.

Since 0.2.3 the host also passes `parentSource: { sessionId, endSeq, events }` to `create()`: the whole seed log plus the session it was cut from, and the backend has to have written it before `create()` resolves. This plugin stores one database per session, so it cannot reference the parent's prefix the way the official segment backend does; it is a copying backend. `copyForkLog()` drains any parent writer still live in memory, checks that the parent store exists and that `endSeq` does not run past what it holds, runs `assertContiguous`, and then writes the whole seed — the child's own events included — in a single transaction. The handle starts its cursor at the end of that seed, so the caller never re-appends it.

A missing parent throws `SessionPersistenceNotFoundError`; an `endSeq` past the parent's last event throws `SessionPersistenceCorruptionError` with `SESSION_FORK_PREFIX_NOT_PERSISTED` in the message, matching the official code. Both are decided after `registerCreated` but before anything is written, and a failure calls `abandonCreated` to drop the claim, so the same id can be retried immediately instead of being answered "already exists".

## Versioning

`user_version = 2` only means "chunks are allowed". Missing tables are added with `CREATE TABLE IF NOT EXISTS` without changing the version. A real upgrade is either `compact()` or the explicit `dsq upgrade --root <sqliteRoot> [--session <id>]`, which changes `user_version` and `storage_meta.schema_version` inside one `BEGIN IMMEDIATE`.

## Hybrid routing

`HybridSessionPersistence` occupies the single `sessionPersistence` slot; the official JSONL entry in `cordis.patch.yml` must be `disabled: true`. `open` consults the routing table first and falls back to the other backend, healing the table when it finds a session the table does not know. `create` uses `newSessionBackend` (`sqlite` by default). `list` merges both sides and de-duplicates by id. A corrupt routing table only produces a warning and can be rebuilt.

## Source map

| file | responsibility |
| --- | --- |
| `src/index.ts` | plugin entry, config schema, `apply`, warmup scheduling |
| `src/storage.ts` | handle lifecycle, 200 ms window, batch tracker, root scan |
| `src/database.ts` | synchronous engine: pragmas, schema, transactional writes, statement cache, `compact`/`reclaim`, window reads, `sliceTrusted`/`decodeTrusted`, seal, torn tail, `storedEventCount`/`trustedLength` |
| `src/chunk.ts` | `encodeChunk`, `decodeChunk`, `decodeChunkLines`, `decodeChunkRange` |
| `src/lru.ts` | `ByteLru` and `deletePrefix` |
| `src/warmup.ts` | quiet background warmup with a 30 s budget |
| `src/schema.ts` | DDL, `SCHEMA_VERSION`, `APPLICATION_ID` |
| `src/format.ts` | directory encoding shared with the official backend |
| `src/lease.ts` | write lease |
| `src/executor.ts` | `StorageExecutor`, LRU keyed by device/inode, `HeaderCache`, `listHeaders`, `InlineExecutor` |
| `src/worker-client.ts`, `src/worker-entry.ts`, `src/rpc.ts` | worker transport |
| `src/router.ts`, `src/catalog.ts` | hybrid routing, atomic routing-table writes |
| `src/migrate.ts`, `src/transfer.ts`, `src/discover.ts` | conversion engine, staging/publish, root discovery |
| `src/inspect.ts`, `src/console.ts` | read-only inspection and the HTTP console |
| `src/search.ts`, `src/query-engine.ts` | optional FTS5 index and query engine |
| `src/metrics.ts`, `src/metrics-journal.ts` | latency sampling and its journal |
| `src/preferences.ts`, `src/about.ts`, `src/diagnostics.ts` | console preferences, build info, diagnostics ring |
| `src/cli.ts` | `import` / `export` / `verify` / `uninstall-check` |
| `client/` | console UI: `ConsolePage.tsx`, `TransferTab.tsx`, `MetricsTab.tsx`, `SettingsTab.tsx`, `i18n.ts`, `api.ts` |
| `tests/vendor/` | official contract sources used as the oracle in tests |
