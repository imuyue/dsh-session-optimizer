/**
 * The hybrid router: one `sessionPersistence` service in front of two backends.
 *
 * Installing this plugin must not force anyone to migrate first, and it must not
 * move an existing session behind the runtime's back. So the plugin mounts two
 * backends at once — the official JSONL provider for history that has not been
 * migrated, this plugin's SQLite store for history that has — and puts a router
 * on the real `sessionPersistence` key that forwards each call to the backend
 * that owns that session. {@link SessionBackendCatalog} is the map.
 *
 * Why a router at all: cordis gives a service key to exactly one registration per
 * context chain, so a profile cannot mount two `SessionPersistence` services side
 * by side. The two backends therefore live in isolated scopes (see `index.ts`)
 * where the key is free, and only the router occupies the real key.
 *
 * Live writes need no routing here. Each backend's own tracker registers
 * `session/event`, `session/flush` and `session/disposed` and looks writers up by
 * session id; listeners on an isolated scope still receive the parent's events,
 * so a backend that holds a writer for session X receives exactly X's events and
 * ignores the rest.
 *
 * Routing is by session id and nothing else. A call for a session the catalog
 * does not know is resolved by asking the backends what they actually store, and
 * the answer is written down: the alternative — guessing per call — would let
 * two processes disagree about where a session lives, which is the one failure
 * this design must not have.
 *
 * @module dsh-session-optimizer/router
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence,
  SessionPersistenceNotFoundError,
  type SessionAccess,
  type SessionHandle,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import {
  SessionBackendCatalog,
  type CatalogConflict,
  type SessionBackendId,
  SESSION_BACKENDS,
} from './catalog.ts'

/** One mounted backend, as the router sees it. */
export interface RoutedBackend {
  readonly id: SessionBackendId
  readonly persistence: SessionPersistence
  /** Human-readable name, used in log lines and errors. */
  readonly label: string
}

/**
 * How the router picks a backend.
 *
 * `preference` only matters when two backends claim the same id — an interrupted
 * migration. It is fixed at mount time so a restart resolves the same way twice.
 */
export interface RouterConfig {
  /** Backend for a session nobody routed yet. */
  readonly newSessionBackend: SessionBackendId
  /** Order to probe when the catalog has no answer. */
  readonly preference: readonly SessionBackendId[]
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  newSessionBackend: 'sqlite',
  // SQLite first: it is the backend this plugin exists for, and it answers
  // `stat` without decoding a log.
  preference: ['sqlite', 'jsonl'],
}

/**
 * Ask one backend about one session without letting a refusal escape.
 *
 * A backend that does not hold the session answers `undefined` (this plugin) or
 * throws `SessionPersistenceNotFoundError` (the official provider); both mean
 * "not here". Anything else is a real failure and is passed on, because treating
 * a corrupt store as absent would let the router route around damage.
 */
async function lookUp(
  backend: RoutedBackend,
  id: SessionId,
  options?: SessionPersistenceStatOptions,
): Promise<SessionPersistenceSnapshot | undefined> {
  try {
    return await backend.persistence.stat(id, options)
  } catch (error) {
    if (error instanceof SessionPersistenceNotFoundError) return undefined
    throw error
  }
}

/** Route each call to the backend that owns the session. */
export class HybridSessionPersistence extends SessionPersistence {
  override readonly name = 'session-persistence-hybrid'
  private readonly backends: Map<SessionBackendId, RoutedBackend>
  private readonly catalog: SessionBackendCatalog
  private readonly config: RouterConfig

  constructor(
    ctx: Context,
    catalog: SessionBackendCatalog,
    backends: readonly RoutedBackend[],
    config: RouterConfig = DEFAULT_ROUTER_CONFIG,
  ) {
    super(ctx)
    this.catalog = catalog
    this.config = config
    this.backends = new Map(backends.map((backend) => [backend.id, backend]))
    for (const id of config.preference) {
      if (!this.backends.has(id)) {
        throw new Error(`router preference names backend "${id}" but only ${[...this.backends.keys()].join(', ')} are mounted`)
      }
    }
  }

  /** Where the routing decisions are stored. */
  get catalogLocation(): string {
    return this.catalog.location
  }

  /** The backend holding `id` right now, without touching either store. */
  routedTo(id: SessionId): SessionBackendId | undefined {
    return this.catalog.backendOf(id)
  }

  /** Create a session on its backend, then write the route down. */
  async create(
    header: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    const id = header.id
    const requested = this.catalog.backendOf(id) ?? this.config.newSessionBackend
    const backend = this.backend(requested)
    // The route is recorded only after the backend accepted the create: a route
    // pointing at a session that does not exist would send later reads nowhere.
    const handle = await backend.persistence.create(header, options)
    this.catalog.route(id, requested)
    await this.persistCatalog()
    return handle
  }

  /**
   * Open a session on whichever backend holds it.
   *
   * A stale route — a migration that published the copy and died before writing
   * the catalog, or the reverse — must not make a session unopenable. So a
   * routed backend that turns out not to hold the session falls through to a
   * probe, and the probe result replaces the route.
   */
  async open(
    id: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    const routed = this.catalog.backendOf(id)
    if (routed !== undefined) {
      try {
        return await this.backend(routed).persistence.open(id, access, options)
      } catch (error) {
        if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      }
    }
    const found = await this.locate(id)
    if (found === undefined) throw new SessionPersistenceNotFoundError(id)
    return this.backend(found).persistence.open(id, access, options)
  }

  /** Durability barrier: every mounted backend, in preference order. */
  async flush(): Promise<void> {
    const failures: unknown[] = []
    for (const id of this.config.preference) {
      const backend = this.backends.get(id)
      if (backend === undefined) continue
      try {
        await backend.persistence.flush()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'flushing every session backend failed')
    }
  }

  /** Metadata for one session, from the backend that holds it. */
  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    const routed = this.catalog.backendOf(id)
    if (routed !== undefined) {
      const snapshot = await lookUp(this.backend(routed), id, options)
      if (snapshot !== undefined) return snapshot
    }
    const found = await this.locate(id, options)
    if (found === undefined) return undefined
    return lookUp(this.backend(found), id, options)
  }

  /**
   * Every session on every backend, one entry each.
   *
   * A session held by both backends (an interrupted migration) appears once, on
   * the backend the catalog names, so a picker never shows the same conversation
   * twice.
   */
  async list(options?: SessionPersistenceListOptions): Promise<SessionPersistenceSnapshot[]> {
    const initial = new Map(this.catalog.list())
    const holders = new Map<string, Map<SessionBackendId, SessionPersistenceSnapshot>>()
    for (const backendId of this.config.preference) {
      const backend = this.backends.get(backendId)
      if (backend === undefined) continue
      for (const snapshot of await backend.persistence.list(options)) {
        const key = String(snapshot.header.id)
        let copies = holders.get(key)
        if (copies === undefined) holders.set(key, copies = new Map())
        copies.set(backendId, snapshot)
      }
    }
    // Enumerations can overlap create/restore. Confirm absence before pruning,
    // and do not reconcile entries created or replaced after this scan began.
    for (const [id, entry] of initial) {
      if (holders.has(id) || this.catalog.get(id) !== entry) continue
      const copies = new Map<SessionBackendId, SessionPersistenceSnapshot>()
      for (const backendId of this.config.preference) {
        const found = await lookUp(this.backend(backendId), id as SessionId, options)
        if (found !== undefined) copies.set(backendId, found)
      }
      if (copies.size > 0) holders.set(id, copies)
    }
    options?.signal?.throwIfAborted()
    const kept: SessionPersistenceSnapshot[] = []
    for (const [id, copies] of holders) {
      const routed = this.catalog.backendOf(id)
      const chosen = routed !== undefined && copies.has(routed) ? routed : copies.keys().next().value!
      kept.push(copies.get(chosen)!)
      if (this.catalog.get(id) === initial.get(id) && routed !== chosen) this.catalog.route(id, chosen)
    }
    for (const [id, entry] of initial) {
      if (!holders.has(id) && this.catalog.get(id) === entry) this.catalog.forget(id)
    }
    await this.persistCatalog()
    return kept
  }

  // ------------------------------------------------------------------ internals

  private backend(id: SessionBackendId): RoutedBackend {
    const backend = this.backends.get(id)
    if (backend === undefined) throw new Error(`no "${id}" backend is mounted`)
    return backend
  }

  /**
   * Find the backend that holds `id`, and remember it.
   *
   * Probes in preference order. The first backend that answers owns the session;
   * ties are impossible in one pass, and the order is fixed so two processes
   * started the same way resolve the same way.
   */
  private async locate(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionBackendId | undefined> {
    for (const backendId of this.config.preference) {
      const backend = this.backends.get(backendId)
      if (backend === undefined) continue
      const snapshot = await lookUp(backend, id, options)
      if (snapshot === undefined) continue
      if (this.catalog.backendOf(id) !== backendId) {
        this.catalog.route(id, backendId)
        await this.persistCatalog()
      }
      return backendId
    }
    return undefined
  }

  /**
   * Save the catalog, reporting rather than throwing.
   *
   * A failed write costs a probe on the next start, because the map is
   * rebuildable from what the backends store; failing the append that was
   * already committed would trade a durable event for a bookkeeping file.
   */
  private async persistCatalog(): Promise<void> {
    try {
      await this.catalog.save()
    } catch (error) {
      this.ctx.logger.warn(
        `session-persistence-hybrid: cannot save "${this.catalog.location}": ${String(error)}; routes stay in memory for this process`,
      )
    }
  }
}

/**
 * Probe every mounted backend and hand back a catalog built from the answers.
 *
 * Used on a first run, after a deleted catalog, and by the migration console to
 * show what each backend actually holds.
 */
export async function rebuildCatalog(
  stateDirectory: string,
  backends: readonly RoutedBackend[],
  config: RouterConfig = DEFAULT_ROUTER_CONFIG,
): Promise<{ readonly catalog: SessionBackendCatalog; readonly conflicts: readonly CatalogConflict[] }> {
  const stored: { backend: SessionBackendId; ids: string[] }[] = []
  for (const backend of backends) {
    const snapshots = await backend.persistence.list()
    stored.push({ backend: backend.id, ids: snapshots.map((snapshot) => String(snapshot.header.id)) })
  }
  const preferred = config.preference[0] ?? SESSION_BACKENDS[0]!
  return SessionBackendCatalog.rebuild(stateDirectory, stored, preferred)
}
