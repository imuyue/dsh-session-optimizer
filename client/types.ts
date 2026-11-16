/**
 * Shapes the console routes answer with.
 *
 * Mirrored by hand from `src/inspect.ts` and `src/migrate.ts` on purpose: the
 * browser bundle must not import the Host modules (they pull in `node:sqlite`).
 * Keep the two in step; the field list is the contract between `console.ts` and
 * this page.
 *
 * @module dsh-session-optimizer/client/types
 */

/** One conversation as the space-usage table shows it. */
export interface UsageRow {
  origin?: 'subagent'
  parentSession?: string
  childCount?: number
  removed?: boolean
  id: string
  /** Newest `session/title` in the log, when it has one. */
  title?: string
  eventCount: number
  sizeBytes: number
  walBytes: number
  state: 'importing' | 'ready' | 'unknown'
  /** First structural disagreement found while reading the file; still listed. */
  problem?: string
  detailsPending?: boolean
  titlePending?: boolean
}

/** Root-wide totals plus the pragmas the backend applied. */
export interface Overview {
  root: string
  storageThread: 'worker' | 'inline'
  applicationId: number
  schemaVersion: number
  journalMode: string
  synchronous: string
  busyTimeoutMs: number
  sessions: number
  ready: number
  importing: number
  damaged: number
  events: number
  databaseBytes: number
  walBytes: number
  checkedAt: number
  /** Permission bits of the root, already in octal (`0700`). */
  rootMode: string
  /** Whether only the owner can reach the root; absent where the question does not apply. */
  rootPrivate?: boolean
  /** Largest first, which is the order the table ranks them in. */
  usage: UsageRow[]
  usageTotal?: number
  childSessions?: number
  usageOffset?: number
  usageLimit?: number
  backends?: { sqliteSessions: number; jsonlSessions: number; sqliteBytes: number; jsonlBytes: number }
  eventsPending?: boolean
}

/** One metric bucket: five seconds of real samples. */
export interface MetricBucket {
  t: number
  count: number
  errors: number
  p50: number
  p95: number
  p99: number
  max: number
}

/** One operation's series over the reporting window. */
export interface MetricSeries {
  op: 'read' | 'append' | 'flush' | 'open' | 'list' | 'stat'
  label: string
  count: number
  errors: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
  buckets: MetricBucket[]
}

/** What `/metrics` answers. `available` is false when nothing was sampled yet. */
export interface MetricsAnswer {
  available: boolean
  reason?: string
  snapshot?: {
    since: number
    now: number
    windowMs: number
    bucketMs: number
    retention: number
    /** Samples and failures inside the window, summed over the ops. */
    count: number
    errors: number
    ops: MetricSeries[]
  }
}

/** One conversation inside a migration run. */
export interface MigrationItem {
  sourceSession: string
  targetSession: string
  status: 'pending' | 'migrating' | 'verifying' | 'migrated' | 'failed' | 'skipped'
  expected: number
  transferred: number
  /** Title of the conversation this item produced, when the source had one. */
  title?: string
  /** Project directory the conversation is grouped under in the session list. */
  cwd?: string
  error?: string
}

/** One backend-to-backend migration of one conversation set. */
export interface MigrationReport {
  migrationId: string
  mode: 'overwrite' | 'clone'
  sourceBackend: 'sqlite' | 'jsonl'
  targetBackend: 'sqlite' | 'jsonl'
  sourceRoot: string
  targetRoot: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'completed' | 'partial' | 'failed'
  items: MigrationItem[]
  error?: string
}

/** One migration run, as `/migrations` reports it. */
export interface MigrationJob {
  id: string
  direction: 'jsonl_to_sqlite' | 'sqlite_to_jsonl'
  mode: 'overwrite' | 'clone'
  sourceRoot: string
  targetRoot: string
  status: 'running' | 'completed' | 'partial' | 'failed'
  startedAt: number
  finishedAt?: number
  report?: MigrationReport
  error?: string
  notice?: string
}

/** The migration list response. `available` is false on a single-backend profile. */
export interface MigrationsAnswer {
  available: boolean
  jobs: MigrationJob[]
  jsonlRoot?: string
  sqliteRoot: string
}

/** One conversation as a root listing shows it. */
export interface SourceSession {
  id: string
  origin?: 'subagent'
  parentSession?: string
  childCount?: number
  title?: string
  eventCount: number
  sizeBytes: number
  createdAt?: number
  path: string
  /** The working directory the log records; a conversation without one has no row. */
  cwd?: string
  /** Set when reading this log would have to salvage, or cannot read at all. */
  problem?: string
  /** True when the other backend already holds this conversation. */
  inTarget?: boolean
  detailsPending?: boolean
  titlePending?: boolean
  removed?: boolean
}

/** A page of one root, as `/source` answers it. */
export interface SourceListing {
  backend: 'sqlite' | 'jsonl'
  root: string
  encoding: 'zstd' | 'none'
  total: number
  offset: number
  limit: number
  sessions: SourceSession[]
}

/** A root this machine has, as `/roots` answers it. */
export interface RootCandidate {
  path: string
  backend: 'sqlite' | 'jsonl'
  encoding?: 'zstd' | 'none'
  sessions: number
  source: 'configured' | 'dsh-home' | 'sibling-of-root' | 'sessions-subdirectory'
}

/** The switches the settings view reads and writes. */
export interface Preferences {
  /** Backend new conversations are created on. */
  format: 'sqlite' | 'jsonl'
  /** The plugin's log-shape fixes: with them off nothing reseals a store. */
  stabilityFixes: boolean
  language: 'zh' | 'en'
}

/** The version block, as `/settings` answers it. */
export interface PluginAbout {
  /** Version recorded in the installed manifest. */
  pluginVersion: string
  /** Version of `@deepseek-ai/dsh-session` this install resolved against. */
  dshVersion?: string
  /** Only the links the manifest actually declares; the rest are absent. */
  links: {
    repository?: string
    feedback?: string
    license?: string
  }
}

/**
 * The settings response. `formats` is what this install can serve, so a card for
 * anything outside it is drawn disabled rather than offering a no-op choice.
 */
export interface SettingsAnswer {
  available: boolean
  reason?: string
  preferences?: Preferences
  formats: Array<'sqlite' | 'jsonl'>
  about?: PluginAbout
}

/** One complaint the plugin recorded since it started. */
export interface DiagnosticEntry {
  at: number
  level: 'warn' | 'error'
  /** Which step complained, e.g. `list` or `catalog`. */
  scope: string
  message: string
}

/** The diagnostics ring, newest last. */
export interface DiagnosticsAnswer {
  /** False when the mount exposes no ring at all. */
  available: boolean
  reason?: string
  entries?: DiagnosticEntry[]
}

/** What an uninstall would hide, as `/uninstall-check` answers it. */
export interface UninstallReport {
  available: boolean
  reason?: string
  checkedAt?: number
  sqliteRoot?: string
  jsonlRoot?: string
  sqlite?: number
  jsonl?: number
  /** Ids that exist only in SQLite: removing the plugin hides them. */
  orphaned?: string[]
  unreadable?: Array<{ id: string; error: string }>
  ok?: boolean
}
