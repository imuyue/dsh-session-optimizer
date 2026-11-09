/**
 * Wire format between the agent thread and the storage worker.
 *
 * Errors cannot cross a `postMessage` boundary as instances, so they travel as
 * plain data and are rebuilt on the receiving side. The persistence errors all
 * derive their message from a session id (plus an operation name for refusals),
 * so those two fields travel explicitly: rebuilding them keeps both the class
 * — callers assert `instanceof` — and the exact message format.
 */
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  type SessionLocation,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One serialized error. */
export interface WireError {
  name: string
  message: string
  stack?: string
  sessionId?: string
  operation?: string
  location?: SessionLocation | undefined
}

/** One request/response envelope. */
export interface WireRequest {
  rid: number
  op: string
  args: unknown[]
}

export interface WireResponse {
  rid: number
  ok: boolean
  value?: unknown
  error?: WireError
}

function detail(value: unknown, key: 'sessionId' | 'operation'): string | undefined {
  const field = (value as Record<string, unknown> | undefined)?.[key]
  return typeof field === 'string' ? field : undefined
}

/** Serialize any thrown value into something `postMessage` accepts. */
export function toWireError(value: unknown): WireError {
  const wire: WireError = {
    name: value instanceof Error ? value.name : 'Error',
    message: value instanceof Error ? value.message : String(value),
  }
  if (value instanceof Error && value.stack !== undefined) wire.stack = value.stack
  const sessionId = detail(value, 'sessionId')
  if (sessionId !== undefined) wire.sessionId = sessionId
  const operation = detail(value, 'operation')
  if (operation !== undefined) wire.operation = operation
  if (value instanceof SessionFormatUnsupportedError) wire.location = value.location
  return wire
}

/** Rebuild a rejection value, preserving the persistence error classes. */
export function fromWireError(wire: WireError): Error {
  const id = wire.sessionId as SessionId | undefined
  let error: Error
  switch (wire.name) {
    case 'SessionFormatUnsupportedError':
      error = new SessionFormatUnsupportedError(wire.message, wire.location)
      break
    case 'SessionPersistenceCorruptionError':
      error = new SessionPersistenceCorruptionError(wire.message, {})
      break
    case 'SessionPersistenceNotFoundError':
      error = id === undefined ? new Error(wire.message) : new SessionPersistenceNotFoundError(id)
      break
    case 'SessionAlreadyExistsError':
      error = id === undefined ? new Error(wire.message) : new SessionAlreadyExistsError(id)
      break
    case 'SessionAlreadyOwnedError':
      error = id === undefined ? new Error(wire.message) : new SessionAlreadyOwnedError(id)
      break
    case 'SessionReadOnlyError':
      error = id === undefined
        ? new Error(wire.message)
        : new SessionReadOnlyError(id, wire.operation ?? 'append')
      break
    case 'SessionHandleClosedError':
      error = id === undefined
        ? new Error(wire.message)
        : new SessionHandleClosedError(id, wire.operation ?? 'read')
      break
    default:
      error = new Error(wire.message)
      break
  }
  // Keep the original text even if a constructor would format it differently.
  if (error.message !== wire.message) error.message = wire.message
  error.name = wire.name
  if (wire.stack !== undefined) error.stack = wire.stack
  return error
}
