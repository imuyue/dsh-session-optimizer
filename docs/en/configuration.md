# Configuration

> 简体中文：[docs/configuration.md](../configuration.md)

<!-- docs-nav -->
[Docs](../../README.en.md#documentation) · [Architecture](architecture.md) · **Configuration** · [CLI](cli.md) · [Console](console.md) · [Benchmarks](benchmarks.md) · [Limitations](limitations.md) · [Development](development.md)

The plugin is configured through its Cordis entry in `profile/cordis.patch.yml`. Every key is optional except `root`.

| key | default | meaning |
| --- | --- | --- |
| `root` | — (required) | directory that holds the SQLite sessions |
| `journalMode` | `wal` | SQLite journal mode |
| `synchronous` | `full` | SQLite durability level |
| `busyTimeoutMs` | `5000` | how long a statement waits for a lock |
| `writeBatchMaxDelayMs` | `200` | live-hook coalescing window |
| `preparedSessionCacheSize` | `5` | open handles kept in the executor LRU |
| `warmupSessions` | `5` | sessions preloaded after mount; `0` disables warmup |
| `storageThread` | `worker` | `worker` moves SQLite calls off the host thread; `inline` is for tests |
| `hybrid` | `false` | run SQLite and JSONL behind one routing table |
| `jsonlRoot` | `''` | JSONL root used by hybrid mode and the converter |
| `stateDirectory` | `''` | where the routing table, preferences and latency journal live; default `dirname(root)/session-backends` |
| `newSessionBackend` | `sqlite` | which backend receives new sessions in hybrid mode |
| `ownSearch` | `false` | serve search from the database's own FTS5 index instead of the official query package |

## Patch file

`cordis.patch.yml` disables the official JSONL persistence and mounts this one:

```yaml
- id: session-persistence
  disabled: true
- id: session-persistence-sqlite
  module: dsh-session-optimizer
  config:
    root: ~/.dsh/sessions-sqlite
```

While `hybrid: false` the plugin owns the whole backend. With `hybrid: true` the official entry must stay mounted but disabled, because `HybridSessionPersistence` occupies the same single service slot and reads the JSONL side through the official provider.

## Console preferences

The console writes `<stateDirectory>/console-settings.json`:

```json
{ "format": "sqlite", "stabilityFixes": true, "language": "zh" }
```

| key | effect |
| --- | --- |
| `format` | backend that receives new sessions; takes effect immediately, the other card is disabled when only one backend is mounted |
| `stabilityFixes` | maps to `seal`; turning it off stops new seals (`SessionDatabase.retune` applies it to a cached handle) |
| `language` | console language only (`client/i18n.ts`); never changes stored data |

Writes are atomic: a `0600` temporary file renamed over the target, inside a `0700` directory. A write failure returns HTTP 500 with a `cannot write the preferences file:` prefix. The file is a partial-update surface — keys you omit keep their current value. The seed values are never written on their own, otherwise they would overwrite the profile's `newSessionBackend`.

## Latency journal

`src/metrics.ts` wraps real calls with `performance.now()`, keeps 8192 samples per operation in a 5-minute window, bucketed every 5 seconds, and reports p50/p95/p99/max per bucket. `src/metrics-journal.ts` writes the window to `<stateDirectory>/latency.json` (`0600`, `version: 1`) every 15 seconds and drops anything outside the window when reading it back. `lastObservedAt` is not restored, and a failed write is silent by design.

## Search

The optional own-search index is a contentless FTS5 table (`event_fts`, `content=''`, `rowid = seq + 1`, `contentless_delete=1`) inside every `session.db`. It indexes message text, tool calls and tool output, not reasoning or turn trailers.

* Enable it with `ownSearch: true` and remove `@deepseek-ai/dsh-session-query-sqlite`, so two search providers do not compete.
* CJK text is indexed as adjacent character pairs, and queries are ANDed pairs, because FTS5's `unicode61` tokenizer treats a run of Han characters as a single token.
* Cursors are opaque base64url JSON; a mismatched cursor fails with `SESSION_QUERY_STALE_CURSOR`.
* The table is maintained on every write even when own-search is off, so enabling it later costs nothing but a warmup `indexStore()` run.
* How many rows the index covers is recorded in the store's own `event_fts_state.built_rows`: every append advances it inside the transaction that wrote the events, so a conversation this plugin wrote is searched out of the index on the first query. Stores written by an earlier build have no such row and pay one full rebuild — which is also what records the count, so they are trusted from then on. The count only matches while the index is contiguous with the log: after a truncation, a length change or an outside rewrite it stops matching, and the reader rebuilds instead of answering "no match" out of a partial index.
