# Console

> 简体中文：[docs/console.md](../console.md)

<!-- docs-nav -->
[Docs](../../README.en.md#documentation) · [Architecture](architecture.md) · [Configuration](configuration.md) · [CLI](cli.md) · **Console** · [Benchmarks](benchmarks.md) · [Limitations](limitations.md) · [Development](development.md)

The console is a client plugin (`dsh.client.platform = web`, built to `lib/client.js`) that registers itself into the `main` and `sidebar.panellist` slots through `ctx.slots`. It never reads SQLite itself: every number comes from a Host route implemented in `src/console.ts`.

## Routes

| route | method | returns |
| --- | --- | --- |
| `/overview` | GET | session count, event count, bytes, WAL bytes, damaged stores, effective pragmas, directory mode, usage breakdown |
| `/metrics` | GET | real latency for `read`, `append`, `flush`, `open`, `list`, `stat`, `search`; `available: false` when no registry is mounted |
| `/roots` | GET | `configured`, `dsh-home`, `sibling-of-root` candidate roots |
| `/source` | GET | conversations in one backend/root (`backend` and `root` required, `offset`/`limit`/`q` optional), each flagged when the target backend already has it |
| `/migrations` | GET | conversion history, one entry or `404` |
| `/migrate` | POST | `202` and a job id; body `{direction, mode, sessions?, newSessionId?, verify, jsonlRoot?, sqliteRoot?}` |
| `/search` | GET | `{available, query, hits: [{sessionId, seq, type, time, score, snippet}]}`; `q` required, `limit` default 20, max 100 |
| `/diagnostics` | GET | up to 200 `{at, level, scope, message}` records |
| `/diagnostics/clear` | POST | clears the ring |
| `/uninstall-check` | GET | `{sqlite, jsonl, orphaned, unreadable, ok}` |
| `/settings` | GET/POST | partial update of `format`, `stabilityFixes`, `language` |

Constraints the route layer enforces:

* registered only when the `connection` service exists, and never awaited inside `apply`;
* only for `principal.kind === 'owner'`;
* every response carries `cache-control: no-store`;
* `POST` checks `content-type` first (`415` for plain text) and dispatches one path by method (`409` when the plugin is not in hybrid mode).

## Read-only inspection

Every route except `/migrate` opens databases with `new DatabaseSync(path, { readOnly: true })` (`src/inspect.ts`). It creates no directory, writes no byte, and produces no `-wal`/`-shm` files. A damaged database never throws: the problem is reported on the entry, in this order — read error, `application_id`, `user_version`, missing `session` row, unreadable header, header id ≠ `session_id`, directory name ≠ `encodeSegment(id)`, non-contiguous sequence numbers.

## Views

| view | content |
| --- | --- |
| Overview | status line, four counters, per-store space table, effective pragmas behind a details block |
| Conversion | direction switch, rescan, filter, table, selection, override/new-session modes, read-back verification toggle, recent conversions |
| Latency | window summary, p50/p95/max line chart, six-row statistics table; an empty registry renders "not sampled" |
| Settings | storage cards (SQLite marked as default), long-conversation stability fixes, language, version and build info, repository link, support and licence |
| Diagnostics | the ring buffer above |

## Conversion semantics

* **Override** keeps `session_id`, moves the original log into `<sourceRoot>.replaced/<migrationId>/` and publishes the new database under the same directory name.
* **New conversation** creates a new id, leaves the original in place, and adds one extra conversation to the list.
* "Already converted" is decided from `originSessionId` in the routing table, not from file names.

Invariants: staging is written before publishing (`<session.db>.importing`, `<session dir>.exporting`), the read-back comparison runs before the rename, the write lease is taken before publishing, and the JSONL side only ever goes through the official provider.

## Latency sampling

`src/metrics.ts` wraps the real calls with `performance.now()`. Each operation keeps 8192 samples inside a 5-minute window, bucketed every 5 seconds; each bucket keeps p50, p95, p99 and max. The summary card and the table filter by the same window. The journal in `src/metrics-journal.ts` persists that window every 15 seconds (see [configuration](configuration.md)).
