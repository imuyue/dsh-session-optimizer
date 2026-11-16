# Limitations

> 简体中文：[docs/limitations.md](../limitations.md)

<!-- docs-nav -->
[Docs](../../README.en.md#documentation) · [Architecture](architecture.md) · [Configuration](configuration.md) · [CLI](cli.md) · [Console](console.md) · [Benchmarks](benchmarks.md) · **Limitations** · [Development](development.md)

Known edges, stated plainly. None of them is a surprise on the right workload, but all of them matter when choosing this backend.

## Cost model

* **A full read is not faster.** Reading every event touches the same payload the JSONL file holds, so the only saving is the redundant columns and the WAL replay (~10% in the reference measurement). The backend wins on *narrow* reads: header, page, tail, random window.
* **Creating a session is slower.** A database is materialised on first write (~31 ms in the reference measurement) versus opening a file (<1 ms). Creating hundreds of short-lived conversations is cheaper on the JSONL side.

## Memory

* The frame cache holds up to 8 MiB of decompressed chunks per process.
* A whole-conversation read materialises every decoded event in memory, exactly like the official backend; a 47k-event conversation needs a few hundred MB of transient objects.
* `preparedSessionCacheSize` (default 5) keep-alive handles each hold their prepared statements and header.

## Correctness boundaries

* **Torn tails are truncated, never repaired.** If the tail rows fail validation (sequence gap, JSON parse error, redundant column mismatch), the read path serves the valid prefix and the write path deletes the rest. The bytes are gone from the store — by design, and a warning is logged.
* **The seal is a trust marker, not a repair tool.** A stale or invalid seal forces a full row-by-row decode; nothing is silently skipped.
* **One writer per session.** The lease is `flock`-based; a second host process opening the same session for writing gets `SessionAlreadyOwnedError`. There is no multi-writer mode.
* **The last write window is at risk.** `append` may sit in the 200 ms coalescing window; only `flush()` (or process shutdown through DSH) makes it durable.
* **Format version 4 only.** Sessions written by an older contract version are refused with an explicit error rather than upgraded in place.

## Chunking

* The chunk size is fixed at 512 KiB of uncompressed payload. Larger chunks save little space and cost window-read latency (1 MiB: 6.44 ms → 10.68 ms, 2 MB saved).
* Reading a window that is not in the frame cache costs a decompress: 1.26–1.55 ms per page in the Python reproduction, versus 0.78–0.91 ms for a plain row read.
* `auto_vacuum` must be set when the database is created; old files cannot gain it retroactively.

## Search

* Own search needs `ownSearch: true` **and** removal of `@deepseek-ai/dsh-session-query-sqlite`; two providers cannot share the slot.
* Only message text, tool calls and tool output are indexed. Reasoning and turn trailers are not.
* CJK is indexed as adjacent character pairs (FTS5 `unicode61` gives no word breaks), so a single-character query matches nothing.
* Cursors are per-index snapshots: an index rebuild invalidates them (`SESSION_QUERY_STALE_CURSOR`).

## Hybrid mode and conversion

* Hybrid mode shares one `sessionPersistence` slot, so the official JSONL entry must stay mounted but `disabled: true`. Two *active* backends cannot coexist.
* Conversion between backends requires a `cwd` the target host can express as an absolute path (`C:\APP\x` ↔ `/mnt/c/APP/x`, UNC ↔ `//server/share`). A path that cannot be expressed is a refusal, not a silent rewrite.
* Override mode moves the original log into `<sourceRoot>.replaced/<migrationId>/`; that directory is the only copy of the pre-conversion bytes and must be kept until the export has been verified.

## Platform

* Windows has no `flock`, so the lease is a lock file plus a liveness check; a lock left by a killed process is reclaimed once that process is gone.
* Directory and file modes (`0700`/`0600`) are enforced with POSIX semantics. On Windows they are best-effort and depend on the filesystem ACLs.
* The plugin targets DSH `>=0.2.2-rc.1 <0.3.0` and Node `>=24.9.0`. The database records `dsh_contract_version = 4`; a different contract is refused on open.

## Privacy and access

* Session content is stored as plain JSON inside the database. There is no encryption; the store is protected by file permissions only.
* The console registers only when the `connection` service exists and only answers `principal.kind === 'owner'`. It is a local surface, not an authenticated remote API.
