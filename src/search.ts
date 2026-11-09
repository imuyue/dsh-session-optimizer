/**
 * What a stored conversation is searchable by, and how a query becomes one.
 *
 * Two jobs, both kept away from the database module so they can be tested
 * without a file:
 *
 * - Turning one event into the text a person would recognize as "what was
 *   said". The JSON envelope, ids, timestamps and structural events carry no
 *   conversational content, and indexing them makes every query match every
 *   session.
 * - Turning what someone typed into an FTS5 `MATCH` expression that treats the
 *   input as data. Quoting each term is what keeps `AND`, `NEAR`, `*` and
 *   unbalanced quotes from being syntax.
 *
 * Chinese and Japanese are why this file exists in this shape. The `unicode61`
 * tokenizer treats a run of Han characters as one token, so `排位赛` is findable
 * but `排位` is not — and a two-character word is the common case in Chinese. The
 * index therefore also stores every adjacent character pair of a CJK run, and a
 * CJK term becomes an AND of its pairs. `排位` then matches its own pair, and
 * `排位赛` matches both of its pairs in order without matching a document that
 * merely contains the two pairs apart.
 *
 * @module dsh-session-optimizer/search
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Scripts written without spaces between words: Han, kana, Hangul, compatibility ideographs. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]+/gu

/** Longest query accepted, in characters, so one keystroke cannot become a scan. */
export const MAX_QUERY_CHARS = 200

/** Most terms a single query may carry. */
const MAX_TERMS = 16

function joinText(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join('\n')
}

function blockText(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const record = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown }
  switch (record.type) {
    case 'text':
      return typeof record.text === 'string' ? record.text : undefined
    // Reasoning is deliberately not indexed: it is not what the conversation
    // says, it is how the model got there, and it is the bulk of the bytes.
    case 'reasoning':
      return undefined
    case 'tool-call':
      return joinText([
        typeof record.name === 'string' ? record.name : undefined,
        typeof record.arguments === 'string' ? record.arguments : undefined,
      ])
    default:
      return undefined
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return joinText(content.map(blockText))
}

function reasonText(reason: unknown): string {
  if (typeof reason !== 'object' || reason === null) return ''
  const record = reason as { kind?: unknown; error?: { message?: unknown } }
  switch (record.kind) {
    case 'error':
      return joinText(['error', typeof record.error?.message === 'string' ? record.error.message : undefined])
    case 'aborted':
    case 'max-tokens':
    case 'interrupted':
      return String(record.kind)
    case 'completed':
      return ''
    default:
      return ''
  }
}

/**
 * The words one event contributes to search.
 *
 * Unknown event types contribute nothing rather than their JSON: a declaration
 * merged by another plugin is not this backend's text to guess at, and indexing
 * the raw envelope would make `seq` and ids searchable.
 */
export function semanticTextOf(event: SessionEvent): string {
  // The event union is discriminated by `type`; the payloads below are the
  // first-party shapes the contract defines, read defensively because a store
  // can also hold events written by another build.
  const data = (event as { data?: unknown }).data
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  switch (event.type) {
    case 'user/message':
      return contentText(record['content'])
    case 'assistant/message': {
      const message = record['message']
      const content =
        typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined
      return contentText(content)
    }
    case 'tool/call':
      return joinText([
        typeof record['name'] === 'string' ? record['name'] : undefined,
        typeof record['arguments'] === 'string' ? record['arguments'] : undefined,
      ])
    case 'tool/result': {
      const message = record['message']
      const content =
        typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined
      const error = record['error'] as { name?: unknown; code?: unknown } | undefined
      return joinText([
        contentText(content),
        typeof error?.name === 'string' ? error.name : undefined,
        typeof error?.code === 'string' ? error.code : undefined,
      ])
    }
    case 'turn/end':
      return reasonText(record['reason'])
    default:
      return ''
  }
}

/**
 * The text stored in the index for one event: the semantic text, then the
 * adjacent character pairs of every CJK run.
 *
 * Pairs are appended rather than replacing the run, so `排位赛` still matches as
 * one token as well as through its pairs.
 */
export function searchableText(text: string): string {
  const pairs: string[] = []
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) pairs.push(run.slice(index, index + 2))
  }
  return pairs.length === 0 ? text : `${text} ${pairs.join(' ')}`
}

/** Quote one term so every FTS5 operator inside it is data. */
function quoted(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

/**
 * Turn a user's query into one FTS5 expression, or `undefined` when nothing in
 * it can be searched for.
 *
 * Every term is required (AND): a search for two words means both, which is
 * what makes the result set narrow as the query grows. A CJK term of two or more
 * characters becomes an AND of its adjacent pairs, matching how the text was
 * indexed.
 */
export function matchQueryFor(query: string): string | undefined {
  const bounded = [...query].slice(0, MAX_QUERY_CHARS).join('')
  const terms = bounded.split(/\s+/u).filter((term) => term !== '').slice(0, MAX_TERMS)
  const parts: string[] = []
  for (const term of terms) {
    if (!CJK.test(term)) {
      parts.push(quoted(term))
      continue
    }
    const characters = [...term]
    if (characters.length < 2) {
      // A single CJK character is not indexed as a pair, and the run token it
      // belongs to is longer than the query: there is nothing honest to match.
      continue
    }
    const pairs: string[] = []
    for (let index = 0; index + 1 < characters.length; index += 1) {
      pairs.push(quoted(`${characters[index] ?? ''}${characters[index + 1] ?? ''}`))
    }
    parts.push(`(${pairs.join(' AND ')})`)
  }
  return parts.length === 0 ? undefined : parts.join(' AND ')
}

/** One hit as the console receives it: enough to render, not the whole event. */
export interface SearchHit {
  readonly sessionId: string
  readonly seq: number
  readonly type: string
  readonly time: number
  /** bm25 rank; lower is better, and it is only meaningful within one store. */
  readonly score: number
  /** The event's searchable text, for filters that must match on the whole body. */
  readonly text: string
  readonly snippet: string
}

/**
 * The part of an event worth showing next to a hit.
 *
 * Cut around the first place the query appears instead of taking the head of the
 * event: a 4,000-character tool result would otherwise always preview as the
 * same first line, whatever the user searched for.
 */
export function snippetOf(text: string, query: string, width = 240): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= width) return collapsed
  const needle = query.trim().toLowerCase()
  const at = needle === '' ? -1 : collapsed.toLowerCase().indexOf(needle)
  const start = at <= width / 3 ? 0 : Math.min(at - Math.floor(width / 3), collapsed.length - width)
  const piece = collapsed.slice(start, start + width)
  return start === 0 ? `${piece}…` : `…${piece}…`
}
