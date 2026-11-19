#!/usr/bin/env node
/**
 * Migration and diagnostics CLI for `dsh-session-optimizer`.
 *
 * The JSONL backend stays the source of truth for reading and writing JSONL:
 * the transfers read through the official `session-persistence-jsonl` provider
 * and write through it, so neither direction re-implements the JSONL format, its
 * generation naming, or its header layout. The engine behind both is
 * `transfer.ts`, which the Web GUI console drives too.
 *
 * Commands:
 * - `import --from <jsonlRoot> --to <sqliteRoot> [--session id] [--force]`
 * - `export --from <sqliteRoot> --to <jsonlRoot> [--session id] [--force]`
 * - `verify --from <jsonlRoot> --to <sqliteRoot> [--session id]`
 * - `uninstall-check --root <sqliteRoot> --jsonl <jsonlRoot>`
 * - `upgrade --root <sqliteRoot> [--session id]`
 * - `compact --root <sqliteRoot> [--session id]`
 *
 * `verify`, `export` and `uninstall-check` are diagnostics: a damaged store is
 * reported per item and never aborts the whole run, because the store that
 * cannot be read is exactly the one the operator needs to hear about.
 *
 * Exit codes: 0 success, 1 verification or safety failure, 2 usage error.
 *
 * @module dsh-session-optimizer/cli
 */

import {
  DEFAULT_TRANSFER_OPTIONS,
  compareLogs,
  disposeJsonlMounts,
  listJsonlSessions,
  readJsonlLog,
  readSqliteCopy,
  readSqliteHeader,
  runTransfer,
  scanSqliteSessions,
  type Difference,
  type TransferJob,
  type TransferOptions,
} from './transfer.ts'
import { type SqliteSettings, SessionDatabase, layoutVersionOf } from './database.ts'
import { findDatabasePath, scanSessions } from './storage.ts'

const USAGE = `Usage: dsh-session-optimizer <command> [options]

Commands:
  import           Copy sessions from a JSONL root into per-session SQLite files
  export           Write sessions from SQLite back to a JSONL root
  verify           Compare the SQLite copy against the JSONL original
  uninstall-check  List sessions that exist only in SQLite (unsafe to uninstall)
  upgrade          Move stores to this build's layout version
  compact          Seal the tail and give back free pages

Options:
  --from <dir>     Source root (JSONL root for import/verify, SQLite root for export)
  --to <dir>       Target root (SQLite root for import, JSONL root for export)
  --root <dir>     SQLite root (uninstall-check, upgrade, compact)
  --jsonl <dir>    JSONL root (uninstall-check)
  --session <id>   Only this session (default: every session in the source)
  --force          Replace an existing target session
  --json           Machine-readable report on stdout
`

interface Options {
  command: string
  from?: string
  to?: string
  root?: string
  jsonl?: string
  session?: string
  force: boolean
  json: boolean
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Options {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    throw new UsageError('')
  }
  const options: Options = { command, force: false, json: false }
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    const next = (): string => {
      const value = rest[index + 1]
      if (value === undefined) throw new UsageError(`${String(token)} requires a value`)
      index += 1
      return value
    }
    switch (token) {
      case '--from': options.from = next(); break
      case '--to': options.to = next(); break
      case '--root': options.root = next(); break
      case '--jsonl': options.jsonl = next(); break
      case '--session': options.session = next(); break
      case '--force': options.force = true; break
      case '--json': options.json = true; break
      default: throw new UsageError(`unknown option "${String(token)}"`)
    }
  }
  return options
}

function requireRoot(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw new UsageError(`${flag} is required`)
  return value
}

/* ------------------------------------------------------------------ commands */

interface Report {
  readonly command: string
  readonly imported?: readonly string[]
  readonly exported?: readonly string[]
  readonly skipped?: readonly string[]
  readonly failed?: readonly string[]
  readonly differences?: readonly Difference[]
  readonly orphaned?: readonly string[]
  readonly upgraded?: readonly string[]
  readonly current?: readonly string[]
  readonly compacted?: readonly string[]
  readonly ok: boolean
}

/** The whole job, item by item, as the console would show it. */
function outcomes(job: TransferJob): { done: string[]; skipped: string[]; failed: string[] } {
  const done: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (const item of job.items) {
    if (item.status === 'verified') done.push(item.session)
    else if (item.status === 'skipped') skipped.push(`${item.session}: ${item.error ?? 'skipped'}`)
    else if (item.status === 'failed') failed.push(`${item.session}: ${item.error ?? 'failed'}`)
  }
  return { done, skipped, failed }
}

function transferOptions(options: Options): TransferOptions {
  return {
    force: options.force,
    verify: true,
    digest: false,
    session: options.session,
  }
}

async function commandImport(options: Options): Promise<Report> {
  const from = requireRoot(options.from, '--from')
  const to = requireRoot(options.to, '--to')
  const job = await runTransfer('jsonl_to_sqlite', from, to, { ...transferOptions(options), readOnlySources: true })
  const { done, skipped, failed } = outcomes(job)
  return { command: 'import', imported: done, skipped, failed, ok: failed.length === 0 && job.error === undefined }
}

async function commandExport(options: Options): Promise<Report> {
  const from = requireRoot(options.from, '--from')
  const to = requireRoot(options.to, '--to')
  const job = await runTransfer('sqlite_to_jsonl', from, to, { ...transferOptions(options), readOnlySources: true })
  const { done, skipped, failed } = outcomes(job)
  return { command: 'export', exported: done, skipped, failed, ok: failed.length === 0 && job.error === undefined }
}

/**
 * What SQLite itself objects to in one store, as text lines.
 *
 * A store that cannot be opened at all is reported the same way rather than
 * thrown: `verify` exists to enumerate problems, and one unreadable file must not
 * hide the state of the other hundred.
 */
async function damageOf(path: string): Promise<string[]> {
  let store: SessionDatabase | undefined
  try {
    store = SessionDatabase.open(path, { ...INTEGRITY_SETTINGS })
    return store.integrityProblems()
  } catch (error) {
    return [`quick_check could not run: ${error instanceof Error ? error.message : String(error)}`]
  } finally {
    store?.close()
  }
}

/**
 * Compare every store under the SQLite root against its JSONL original.
 *
 * A store that cannot be read becomes one difference rather than an exception:
 * the point of the command is to enumerate problems, and its exit code says
 * whether there are any.
 */
async function commandVerify(options: Options): Promise<Report> {
  const from = requireRoot(options.from, '--from')
  const to = requireRoot(options.to, '--to')
  const entries = await scanSqliteSessions(to)
  const differences: Difference[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    // Asked before the comparison, because the comparison cannot see this: a
    // damaged page makes the queries covering it come back short, which is
    // exactly what a store torn at the tail looks like. Both logs then agree on
    // the shorter prefix and the store passes a check it should fail.
    const damage = await damageOf(entry.path)
    if (damage.length > 0) {
      differences.push({
        session: entry.directory,
        detail: `SQLite reports damage: ${damage.slice(0, 3).join('; ')}`,
      })
    }
    let copy
    try {
      copy = await readSqliteCopy(entry.path, 'strict', { ...DEFAULT_TRANSFER_OPTIONS, readOnlySources: true })
    } catch (error) {
      differences.push({
        session: entry.directory,
        detail: `cannot read "${entry.path}": ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    // `--session` filters by the id the store actually holds. Comparing the
    // directory name instead would find nothing as soon as a directory was
    // renamed — the case where a verification is most needed.
    if (options.session !== undefined && copy.header.id !== options.session) continue
    seen.add(copy.header.id)
    let original
    try {
      original = await readJsonlLog(from, copy.header.id)
    } catch (error) {
      differences.push({
        session: copy.header.id,
        detail: `cannot read the JSONL original: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    if (original === undefined) {
      differences.push({ session: copy.header.id, detail: 'missing from the JSONL root' })
      continue
    }
    const difference = compareLogs(original, copy, { ignoreInherited: copy.header.isSeeded })
    if (difference !== undefined) differences.push(difference)
  }
  if (options.session !== undefined && !seen.has(options.session)) {
    skipped.push(`${options.session}: not present in the SQLite root`)
  }
  return { command: 'verify', skipped, differences, ok: differences.length === 0 }
}

async function commandUninstallCheck(options: Options): Promise<Report> {
  const root = requireRoot(options.root, '--root')
  const jsonl = requireRoot(options.jsonl, '--jsonl')
  const entries = await scanSqliteSessions(root)
  const present = new Set((await listJsonlSessions(jsonl)).map((header) => header.id))
  const orphaned: string[] = []
  const failed: string[] = []
  const skipped: string[] = []
  for (const entry of entries) {
    let copy
    try {
      copy = await readSqliteCopy(entry.path, 'strict', { ...DEFAULT_TRANSFER_OPTIONS, readOnlySources: true })
    } catch (error) {
      // An unreadable store may hold sessions the JSONL root does not have, so
      // it must be reported as a blocker rather than silently skipped. The
      // header is tried on its own first: it is usually readable even when the
      // events are not, and then the id is known and the JSONL root can answer
      // whether this session already exists elsewhere.
      const header = await readSqliteHeader(entry.path).catch(() => undefined)
      if (header !== undefined && present.has(header.header.id)) {
        skipped.push(`${header.header.id}: unreadable store, but its session exists in the JSONL root`)
        continue
      }
      const label = header?.header.id ?? entry.directory
      failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!present.has(copy.header.id)) orphaned.push(copy.header.id)
  }
  return {
    command: 'uninstall-check',
    orphaned,
    failed,
    skipped,
    ok: orphaned.length === 0 && failed.length === 0,
  }
}

/**
 * The settings an upgrade open runs under.
 *
 * It is a write open, so it cannot borrow the read-only settings the transfer
 * commands use; and it is not a mount, so there are no live preferences to
 * honour. These are the same defaults the plugin mounts with.
 */
const UPGRADE_SETTINGS: SqliteSettings = {
  journalMode: 'wal',
  synchronous: 'full',
  busyTimeoutMs: 5000,
}

/**
 * Settings for asking SQLite about a store without touching it.
 *
 * `readOnly` is what keeps a diagnostic from being a repair: the open path
 * upgrades a store it finds on an older layout, and a check that silently
 * rewrites what it was asked to inspect is not a check.
 */
const INTEGRITY_SETTINGS: SqliteSettings = {
  readOnly: true,
  journalMode: 'wal',
  synchronous: 'full',
  busyTimeoutMs: 5000,
}

/**
 * Move stores to this build's layout, and say which ones moved.
 *
 * Opening a store for writing already upgrades it, so this command is a way to
 * do that deliberately — before a backup, or on a root that no process has open.
 * A store that is already current is listed as `current` rather than left out:
 * "I looked at it and it was fine" is a different answer from "I did not look".
 */
async function commandUpgrade(options: Options): Promise<Report> {
  const root = requireRoot(options.root, '--root')
  const targets: { path: string; label: string }[] = []
  if (options.session === undefined) {
    for (const entry of await scanSessions(root)) {
      targets.push({ path: entry.path, label: entry.directory })
    }
  } else {
    const path = await findDatabasePath(root, options.session as never)
    if (path === undefined) {
      return {
        command: 'upgrade',
        upgraded: [],
        current: [],
        failed: [`${options.session}: not present in this root`],
        ok: false,
      }
    }
    targets.push({ path, label: options.session })
  }

  const upgraded: string[] = []
  const current: string[] = []
  const failed: string[] = []
  for (const target of targets) {
    const before = layoutVersionOf(target.path)
    if (before === undefined) {
      failed.push(`${target.label}: the store could not be read`)
      continue
    }
    let store: SessionDatabase
    try {
      store = SessionDatabase.open(target.path, UPGRADE_SETTINGS)
    } catch (error) {
      failed.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      const from = store.upgradeLayout()
      if (from === undefined) current.push(target.label)
      else upgraded.push(`${target.label}: ${String(from)} -> ${String(layoutVersionOf(target.path))}`)
    } finally {
      store.close()
    }
  }
  return {
    command: 'upgrade',
    upgraded,
    current,
    failed,
    ok: failed.length === 0,
  }
}

/**
 * Seal whatever tail is worth a frame, then give back every free page.
 *
 * Sealing and reclaiming are separate on purpose. A store whose tail is already
 * under half a frame has nothing to seal, and that is exactly the store whose
 * free pages `compact()` used to leave behind. The report names both results so
 * an operator can tell "already tight" from "I got the pages back".
 */
async function commandCompact(options: Options): Promise<Report> {
  const root = requireRoot(options.root, '--root')
  const targets: { path: string; label: string }[] = []
  if (options.session === undefined) {
    for (const entry of await scanSessions(root)) {
      targets.push({ path: entry.path, label: entry.directory })
    }
  } else {
    const path = await findDatabasePath(root, options.session as never)
    if (path === undefined) {
      return {
        command: 'compact',
        compacted: [],
        failed: [`${options.session}: not present in this root`],
        ok: false,
      }
    }
    targets.push({ path, label: options.session })
  }
  const compacted: string[] = []
  const failed: string[] = []
  for (const target of targets) {
    let store: SessionDatabase
    try {
      store = SessionDatabase.open(target.path, UPGRADE_SETTINGS)
    } catch (error) {
      failed.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      store.compact()
      const reclaimed = store.reclaimFreePages()
      compacted.push(
        `${target.label}: freed ${String(reclaimed.before - reclaimed.after)} pages, ${String(reclaimed.after)} still free`,
      )
    } catch (error) {
      failed.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      store.close()
    }
  }
  return { command: 'compact', compacted, failed, ok: failed.length === 0 }
}

/* ------------------------------------------------------------------ entry */

/** Run one command; exported so tests drive the CLI without a process. */
export async function run(argv: readonly string[]): Promise<number> {
  let options: Options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message === '') {
        process.stdout.write(USAGE)
        return 0
      }
      process.stderr.write(`${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }
  try {
    switch (options.command) {
      case 'import':
      case 'export':
      case 'verify':
      case 'uninstall-check': {
        const report = options.command === 'import' || options.command === 'export'
          ? await (options.command === 'import' ? commandImport(options) : commandExport(options))
          : options.command === 'verify'
            ? await commandVerify(options)
            : await commandUninstallCheck(options)
        emit(report, options.json)
        return report.ok ? 0 : 1
      }
      case 'upgrade': {
        const report = await commandUpgrade(options)
        emit(report, options.json)
        return report.ok ? 0 : 1
      }
      case 'compact': {
        const report = await commandCompact(options)
        emit(report, options.json)
        return report.ok ? 0 : 1
      }
      default:
        process.stderr.write(`unknown command "${options.command}"\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    // A missing flag is a usage error wherever it is noticed, not only while
    // parsing: `import --from X` without `--to` must exit 2, not crash.
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  } finally {
    await disposeJsonlMounts()
  }
}

function emit(report: Report, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  const lines: string[] = []
  for (const id of report.imported ?? []) lines.push(`imported ${id}`)
  for (const id of report.exported ?? []) lines.push(`exported ${id}`)
  for (const note of report.skipped ?? []) lines.push(`skipped ${note}`)
  for (const note of report.failed ?? []) lines.push(`FAILED ${note}`)
  for (const difference of report.differences ?? []) {
    lines.push(`DIFF ${difference.session}: ${difference.detail}`)
  }
  for (const id of report.upgraded ?? []) lines.push(`upgraded ${id}`)
  for (const id of report.current ?? []) lines.push(`current ${id}`)
  for (const note of report.compacted ?? []) lines.push(`compacted ${note}`)
  for (const id of report.orphaned ?? []) {
    lines.push(`ORPHAN ${id}: exists only in SQLite; export it before uninstalling`)
  }
  if (lines.length === 0) lines.push(report.ok ? 'nothing to do' : 'failed')
  process.stdout.write(`${lines.join('\n')}\n`)
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href

if (invokedDirectly) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}

export { USAGE }
