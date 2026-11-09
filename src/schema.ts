/**
 * Physical schema for one session database: one file per session, one row in
 * `session`, append-only rows in `session_event`.
 *
 * Layout version lives in `PRAGMA user_version`; `PRAGMA application_id` marks
 * the file as owned by this backend so a foreign or half-written database is
 * refused instead of being mistaken for one of ours.
 *
 * @module dsh-session-optimizer/schema
 */

/**
 * On-disk layout version, stored in `PRAGMA user_version`.
 *
 * Version 2 adds the chunk tables: a log older than the sealed watermark lives
 * compressed in `event_chunk`, and `session_event` holds only the unsealed tail.
 * Version 1 is still readable — it simply has no chunks, so every row is a tail
 * row — and a store is promoted to 2 the first time a chunk is written.
 */
export const SCHEMA_VERSION = 2

/**
 * Layout versions this build can read.
 *
 * Reading an older layout is cheap and lossless: without chunks the tail is the
 * whole log, which is exactly how version 1 defined it. Writing always moves a
 * store to `SCHEMA_VERSION`.
 */
export const READABLE_VERSIONS: readonly number[] = [1, 2]

/** 'DSHS' — marks a database created by this backend. */
export const APPLICATION_ID = 0x44534853

/**
 * Idempotent DDL applied in one transaction when a session database is
 * created. Every table is STRICT so a wrong column type fails at the boundary
 * rather than being silently coerced.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE storage_meta (
     singleton            INTEGER PRIMARY KEY CHECK (singleton = 1),
     store_uuid           TEXT    NOT NULL,
     schema_version       INTEGER NOT NULL,
     dsh_contract_version INTEGER NOT NULL,
     created_at_ms        INTEGER NOT NULL,
     updated_at_ms        INTEGER NOT NULL
   ) STRICT`,

  `CREATE TABLE session (
     singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
     session_id            TEXT    NOT NULL,
     header_json           TEXT    NOT NULL CHECK (json_valid(header_json)),
     inherited_event_count INTEGER NOT NULL CHECK (inherited_event_count >= 0),
     event_count           INTEGER NOT NULL CHECK (event_count >= 0),
     revision              INTEGER NOT NULL CHECK (revision >= 0),
     state                 TEXT    NOT NULL CHECK (state IN ('importing', 'ready')),
     created_at_ms         INTEGER NOT NULL,
     updated_at_ms         INTEGER NOT NULL
   ) STRICT`,

  `CREATE TABLE session_event (
     seq           INTEGER PRIMARY KEY CHECK (seq >= 0),
     event_type    TEXT    NOT NULL,
     event_time_ms INTEGER NOT NULL,
     event_json    TEXT    NOT NULL CHECK (json_valid(event_json))
   ) STRICT, WITHOUT ROWID`,

  /**
   * A digest of the whole event log, written by the writer after it commits.
   *
   * It exists to make a windowed read as cheap as it is on the JSONL backend: a
   * reader that is only returning 50 of 47000 events has to know the other 46950
   * are still intact, and the two ways to find out are "decode all of them" or
   * "compare one summary". This table is the summary. Without a row here (a store
   * written by another build, or never written through this one) the reader
   * falls back to decoding — correct, just slower.
   *
   * `marker` is the `event_count@revision` the digest was taken at, so a seal is
   * only consulted while the log it describes is unchanged.
   */
  `CREATE TABLE session_seal (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     marker    TEXT    NOT NULL,
     checksum  TEXT    NOT NULL
   ) STRICT`,

  /**
   * The fold index carries only the small columns: the fold runs on every append,
   * so it has to be a key read (measured on 47k events: 1.4ms here, 8ms scanning
   * the table). The JSON text is deliberately excluded — including it costs 74ms
   * per fold, which every append would pay.
   */
  `CREATE INDEX session_event_fold ON session_event (seq, event_time_ms, event_type)`,

  /**
   * Sealed runs of the log, compressed as one frame each.
   *
   * A hundred-megabyte conversation is almost entirely repetition — the same
   * keys, the same tool names, long assistant paragraphs — so compressing it in
   * megabyte-sized runs reaches about 5.6x, while one frame per event reaches
   * only 2.4x and is slower to read back. The chunk is therefore the unit:
   * contiguous events, sealed once, never rewritten.
   *
   * `session_event` keeps the unsealed tail, so a live conversation appends at
   * full speed and a closed one costs a fraction of the bytes. Rows are only ever
   * moved here by `compact()`, which is never on the append path.
   *
   * `types_bytes` and `times_total` are the chunk's contribution to the log
   * checksum: stored as integers, summed by the engine in int64 (8.5e16 fits),
   * and read back as text — which is what lets the seal keep covering the whole
   * logical log without touching a single compressed byte.
   *
   * `types_json` is the chunk's event-type histogram (`{"tool/result": 812}`).
   * The console groups events by type for its filter chips, and after sealing
   * those events are not rows any more; keeping the counts beside the frame lets
   * the histogram stay exact without decompressing a hundred megabytes to count
   * them.
   */
  `CREATE TABLE event_chunk (
     first_seq        INTEGER PRIMARY KEY CHECK (first_seq >= 0),
     last_seq         INTEGER NOT NULL CHECK (last_seq >= first_seq),
     event_count      INTEGER NOT NULL CHECK (event_count > 0),
     raw_bytes        INTEGER NOT NULL CHECK (raw_bytes > 0),
     compressed_bytes INTEGER NOT NULL CHECK (compressed_bytes > 0),
     codec            TEXT    NOT NULL,
     types_bytes      INTEGER NOT NULL,
     times_total      INTEGER NOT NULL,
     types_json       TEXT    NOT NULL CHECK (json_valid(types_json)),
     payload          BLOB    NOT NULL,
     CHECK (last_seq = first_seq + event_count - 1)
   ) STRICT, WITHOUT ROWID`,
  /**
   * The derived full-text index, one row per searchable event.
   *
   * `content=''` keeps only the index and not a second copy of the text: the
   * snippet a hit needs is read back from the event itself, which the caller is
   * already fetching. `contentless_delete=1` is what lets a truncated tail drop
   * its rows by rowid (SQLite 3.43 and newer; older builds refuse the option and
   * the store simply has no index until the runtime is upgraded).
   *
   * `rowid` is `seq + 1`, because FTS5 rowids start at 1 and event seq starts at
   * 0, and that mapping is the only thing tying a hit back to an event.
   *
   * Indexing is derived state: losing it costs a rebuild, never an event.
   */

]

/**
 * Tables added after the first stores were written.
 *
 * Applied with `IF NOT EXISTS` on every writable open, so an older file gains
 * them in place instead of being refused or version-bumped: nothing here changes
 * a row, and a store that never gets them just reads the slow way.
 */
export const AUXILIARY_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_seal (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     marker    TEXT    NOT NULL,
     checksum  TEXT    NOT NULL
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS session_event_fold
     ON session_event (seq, event_time_ms, event_type)`,
  // The chunk table is additive for the same reason: a store written before
  // chunks existed simply has no sealed runs, which is exactly a version 1
  // file. Creating the empty table costs nothing and saves a schema branch on
  // the write path; the store is only stamped version 2 once a chunk lands.
  `CREATE TABLE IF NOT EXISTS event_chunk (
     first_seq        INTEGER PRIMARY KEY CHECK (first_seq >= 0),
     last_seq         INTEGER NOT NULL CHECK (last_seq >= first_seq),
     event_count      INTEGER NOT NULL CHECK (event_count > 0),
     raw_bytes        INTEGER NOT NULL CHECK (raw_bytes > 0),
     compressed_bytes INTEGER NOT NULL CHECK (compressed_bytes > 0),
     codec            TEXT    NOT NULL,
     types_bytes      INTEGER NOT NULL,
     times_total      INTEGER NOT NULL,
     types_json       TEXT    NOT NULL CHECK (json_valid(types_json)),
     payload          BLOB    NOT NULL,
     CHECK (last_seq = first_seq + event_count - 1)
   ) STRICT, WITHOUT ROWID`,
  // The search index is additive like the chunk table: a store written before
  // it existed simply has no index, and the reader falls back to a rebuild.
  // Creating it on every writable open is what lets an old file gain one
  // without being refused or version-bumped.
  `CREATE VIRTUAL TABLE IF NOT EXISTS event_fts
     USING fts5 (text, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE TABLE IF NOT EXISTS event_fts_state (
     singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
     built_rows INTEGER NOT NULL CHECK (built_rows >= 0)
   ) STRICT`,
]