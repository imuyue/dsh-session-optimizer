/**
 * Which backend owns which session.
 *
 * A hybrid install has two persistence backends live at once: the official JSONL
 * provider for history that has not been migrated, and this plugin's SQLite
 * store for history that has. Something has to remember the answer per session,
 * and it cannot be the session files themselves — a session must be routable
 * before either backend is opened, and the answer has to survive a restart and
 * an interrupted migration.
 *
 * The catalog is that record. It is small, derived from durable state, and
 * rebuildable: every entry names a backend that either holds the session or does
 * not, and {@link SessionBackendCatalog.rebuild} can recover the map by asking
 * both backends what they store. Losing the file therefore costs a scan, not
 * data.
 *
 * Migration entries carry provenance (`originSessionId`, `migrationId`,
 * `sourceBackend`, `targetBackend`, `clonedAt`) so a clone can be traced back to
 * the session it was copied from without touching the cloned log itself.
 *
 * @module dsh-session-optimizer/catalog
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** One persistence backend this plugin can route to. */
export type SessionBackendId = 'sqlite' | 'jsonl'

/** The backends a hybrid install mounts, in preference order for new sessions. */
export const SESSION_BACKENDS: readonly SessionBackendId[] = ['sqlite', 'jsonl']

/** What the catalog knows about one session. */
export interface CatalogEntry {
  /** The backend that stores this session right now. */
  readonly backend: SessionBackendId
  /** Set on a clone: the session it was copied from. */
  readonly originSessionId?: string | undefined
  /** Set on either migration mode: the run that produced this entry. */
  readonly migrationId?: string | undefined
  /** Set on either migration mode: where the events came from. */
  readonly sourceBackend?: SessionBackendId | undefined
  /** Set on either migration mode: where the events went. */
  readonly targetBackend?: SessionBackendId | undefined
  /** Set on a clone: when the copy was made, in epoch milliseconds. */
  readonly clonedAt?: number | undefined
  /** When this entry last changed, in epoch milliseconds. */
  readonly updatedAt: number
}

/** Provenance supplied by a migration without changing its backend or timestamp. */
export type CatalogProvenance = Omit<CatalogEntry, 'backend' | 'updatedAt'>

function makeEntry(backend: SessionBackendId, provenance: CatalogProvenance, now: number): CatalogEntry {
  return {
    backend,
    ...provenance.originSessionId === undefined ? {} : { originSessionId: provenance.originSessionId },
    ...provenance.migrationId === undefined ? {} : { migrationId: provenance.migrationId },
    ...provenance.sourceBackend === undefined ? {} : { sourceBackend: provenance.sourceBackend },
    ...provenance.targetBackend === undefined ? {} : { targetBackend: provenance.targetBackend },
    ...provenance.clonedAt === undefined ? {} : { clonedAt: provenance.clonedAt },
    updatedAt: now,
  }
}

/** The on-disk shape; `version` lets a future build refuse instead of guess. */
export interface CatalogDocument {
  readonly version: 1
  readonly sessions: Record<string, CatalogEntry>
}

/** Why a catalog write could not land where it was asked to. */
export class CatalogError extends Error {
  override readonly name = 'CatalogError'
  /** Where the write was refused. */
  readonly path: string
  constructor(message: string, path: string) {
    super(message)
    this.path = path
  }
}

/** A session that both backends claim, which means a migration was interrupted. */
export interface CatalogConflict {
  readonly id: string
  readonly listed: SessionBackendId
  readonly also: readonly SessionBackendId[]
}

const CATALOG_FILENAME = 'session-backends.json'
const CATALOG_VERSION = 1

/**
 * The directory that holds the backend catalog for a hybrid install.
 *
 * It sits beside the SQLite root rather than inside it: the SQLite root is
 * per-session directories and the catalog covers both backends, so a reader that
 * only understands session stores never trips over it.
 */
export function catalogPath(stateDirectory: string): string {
  return `${stateDirectory}/${CATALOG_FILENAME}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function backendOf(value: unknown): SessionBackendId | undefined {
  return value === 'sqlite' || value === 'jsonl' ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function optionalTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Decode one entry, refusing anything a later build might have meant differently.
 *
 * The catalog decides where a session lives, so an entry that cannot be read
 * exactly is a reason to stop rather than to guess: routing a write at the wrong
 * backend is the one failure this design must not have.
 */
function decodeEntry(id: string, raw: unknown, path: string): CatalogEntry {
  if (!isRecord(raw)) throw new CatalogError(`"${path}" entry "${id}" is not an object`, path)
  const backend = backendOf(raw.backend)
  if (backend === undefined) {
    throw new CatalogError(
      `"${path}" entry "${id}" names backend "${String(raw.backend)}"; this build routes only ${SESSION_BACKENDS.join(' or ')}`,
      path,
    )
  }
  const updatedAt = optionalTime(raw.updatedAt)
  if (updatedAt === undefined) throw new CatalogError(`"${path}" entry "${id}" has no updatedAt`, path)
  const originSessionId = optionalString(raw.originSessionId)
  const migrationId = optionalString(raw.migrationId)
  const sourceBackend = backendOf(raw.sourceBackend)
  const targetBackend = backendOf(raw.targetBackend)
  const clonedAt = optionalTime(raw.clonedAt)
  return {
    backend,
    ...originSessionId === undefined ? {} : { originSessionId },
    ...migrationId === undefined ? {} : { migrationId },
    ...sourceBackend === undefined ? {} : { sourceBackend },
    ...targetBackend === undefined ? {} : { targetBackend },
    ...clonedAt === undefined ? {} : { clonedAt },
    updatedAt,
  }
}

/**
 * The per-session backend directory for a hybrid install.
 *
 * Reads are synchronous over an in-memory map so the routing decision costs no
 * I/O; writes go through a temporary file and a rename, so a crash leaves either
 * the previous catalog or the next one and never a half-written document.
 */
export class SessionBackendCatalog {
  private readonly entries: Map<string, CatalogEntry>
  private readonly path: string
  private dirty = false
  private mutation = 0
  private saving: Promise<void> | undefined

  private constructor(path: string, entries: Map<string, CatalogEntry>) {
    this.path = path
    this.entries = entries
  }

  /** Where this catalog is stored. */
  get location(): string {
    return this.path
  }

  /** How many sessions are routed. */
  get size(): number {
    return this.entries.size
  }

  /** Every routed session, ordered by id so a listing is stable. */
  list(): readonly (readonly [string, CatalogEntry])[] {
    return [...this.entries.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  }

  /** The backend that owns `id`, or undefined when nothing routed it yet. */
  backendOf(id: string): SessionBackendId | undefined {
    return this.entries.get(id)?.backend
  }

  /** The full entry for `id`, or undefined. */
  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id)
  }

  /** Every route for one backend. */
  idsOf(backend: SessionBackendId): readonly string[] {
    const found: string[] = []
    for (const [id, entry] of this.entries) if (entry.backend === backend) found.push(id)
    return found.sort()
  }

  /**
   * Read the catalog, or start an empty one.
   *
   * A missing file is a first run, not an error. A file this build cannot decode
   * is refused outright — see {@link decodeEntry}.
   */
  static async open(stateDirectory: string): Promise<SessionBackendCatalog> {
    const path = catalogPath(stateDirectory)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new SessionBackendCatalog(path, new Map())
      }
      throw error
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(text) as unknown
    } catch {
      throw new CatalogError(`"${path}" is not JSON; restore it or delete it to rebuild from both backends`, path)
    }
    if (!isRecord(decoded)) throw new CatalogError(`"${path}" is not a catalog document`, path)
    if (decoded.version !== CATALOG_VERSION) {
      throw new CatalogError(
        `"${path}" uses catalog version ${String(decoded.version)}; this build reads only ${CATALOG_VERSION}`,
        path,
      )
    }
    if (!isRecord(decoded.sessions)) throw new CatalogError(`"${path}" has no sessions map`, path)
    const entries = new Map<string, CatalogEntry>()
    for (const [id, raw] of Object.entries(decoded.sessions)) {
      entries.set(id, decodeEntry(id, raw, path))
    }
    return new SessionBackendCatalog(path, entries)
  }

  /**
   * Point one session at a backend.
   *
   * The previous provenance is dropped unless this call carries its own: a route
   * records why the session is where it is, and a plain re-route has no reason.
   */
  route(
    id: string,
    backend: SessionBackendId,
    provenance: CatalogProvenance = {},
    now = Date.now(),
  ): CatalogEntry {
    const entry = makeEntry(backend, provenance, now)
    this.entries.set(id, entry)
    this.mutation += 1
    this.dirty = true
    return entry
  }

  /**
   * Publish a migration route only after its proposed document reached disk.
   * Normal route/save callers keep their existing explicit dirty-map semantics.
   * A competing update of this same id wins; never overwrite it during an await.
   */
  async commitRoute(
    id: string,
    backend: SessionBackendId,
    provenance: CatalogProvenance = {},
    now = Date.now(),
  ): Promise<CatalogEntry> {
    const expected = this.entries.get(id)
    while (this.saving !== undefined) await this.saving
    if (this.entries.get(id) !== expected) throw new CatalogError(`route for "${id}" changed before migration commit`, this.path)
    const entry = makeEntry(backend, provenance, now)
    const saving = this.persistRoute(id, entry, expected)
    this.saving = saving
    try {
      await saving
    } finally {
      this.saving = undefined
    }
    if (this.entries.get(id) !== entry) throw new CatalogError(`route for "${id}" changed during migration commit`, this.path)
    return entry
  }

  private async persistRoute(id: string, entry: CatalogEntry, expected: CatalogEntry | undefined): Promise<void> {
    const mutation = this.mutation
    const entries = new Map(this.entries)
    entries.set(id, entry)
    await this.writeDocument({
      version: CATALOG_VERSION,
      sessions: Object.fromEntries([...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    })
    if (this.entries.get(id) !== expected) {
      // A route/forget/replaceAll overtook the proposed snapshot. Keep that map
      // authoritative and serialize it before reporting the superseded commit.
      this.dirty = true
      await this.savePending()
      throw new CatalogError(`route for "${id}" changed during migration commit`, this.path)
    }
    this.entries.set(id, entry)
    this.mutation += 1
    // The document includes every mutation observed before the await, but a
    // different id may have changed while it was being written.
    this.dirty = this.mutation !== mutation + 1
  }

  /** Record a route only when the session has none, so a restart keeps history. */
  routeIfAbsent(id: string, backend: SessionBackendId, now = Date.now()): CatalogEntry {
    const existing = this.entries.get(id)
    if (existing !== undefined) return existing
    return this.route(id, backend, {}, now)
  }

  /** Forget one session; used when a migration is rolled back. */
  forget(id: string): boolean {
    const removed = this.entries.delete(id)
    if (removed) { this.mutation += 1; this.dirty = true }
    return removed
  }

  /** Replace the whole map, as `rebuild` does after scanning both backends. */
  replaceAll(next: Iterable<readonly [string, CatalogEntry]>): void {
    this.entries.clear()
    for (const [id, entry] of next) this.entries.set(id, entry)
    this.mutation += 1
    this.dirty = true
  }

  /**
   * Save the catalog, atomically.
   *
   * The temporary name is unique per write so two processes racing the same
   * catalog cannot publish each other's bytes; the rename is the only step that
   * makes a document visible.
   */
  async save(): Promise<void> {
    if (this.saving !== undefined) {
      await this.saving
      if (this.dirty) await this.save()
      return
    }
    if (!this.dirty) return
    const saving = this.savePending()
    this.saving = saving
    try {
      await saving
    } finally {
      this.saving = undefined
    }
    if (this.dirty) await this.save()
  }

  private async savePending(): Promise<void> {
    while (this.dirty) {
      const mutation = this.mutation
      const document: CatalogDocument = {
        version: CATALOG_VERSION,
        sessions: Object.fromEntries(this.list()),
      }
      await this.writeDocument(document)
      this.dirty = this.mutation !== mutation
    }
  }

  private async writeDocument(document: CatalogDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const staging = `${this.path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(staging, this.path)
    } catch (error) {
      await unlink(staging).catch(() => undefined)
      throw error
    }
  }

  /**
   * Work out the routes from what the two backends actually store.
   *
   * Used on a first run and after a lost catalog. `preferred` wins when both
   * backends hold the same id, because that is the backend the operator asked
   * for; every such duplicate is reported so an interrupted migration is visible
   * instead of silently resolved.
   */
  static async rebuild(
    stateDirectory: string,
    stored: readonly {
      readonly backend: SessionBackendId
      readonly ids: readonly string[]
    }[],
    preferred: SessionBackendId,
    now = Date.now(),
  ): Promise<{ readonly catalog: SessionBackendCatalog; readonly conflicts: readonly CatalogConflict[] }> {
    const path = catalogPath(stateDirectory)
    const holders = new Map<string, SessionBackendId[]>()
    for (const backend of stored) {
      for (const id of backend.ids) {
        const list = holders.get(id)
        if (list === undefined) holders.set(id, [backend.backend])
        else list.push(backend.backend)
      }
    }
    const entries = new Map<string, CatalogEntry>()
    const conflicts: CatalogConflict[] = []
    for (const [id, backends] of holders) {
      const chosen = backends.includes(preferred) ? preferred : backends[0]
      if (chosen === undefined) continue
      entries.set(id, { backend: chosen, updatedAt: now })
      if (backends.length > 1) {
        conflicts.push({ id, listed: chosen, also: backends.filter((backend) => backend !== chosen) })
      }
    }
    const catalog = new SessionBackendCatalog(path, entries)
    catalog.dirty = entries.size > 0
    return { catalog, conflicts }
  }
}
