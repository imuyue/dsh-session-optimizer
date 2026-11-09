/**
 * Whole-chunk compression of the event log.
 *
 * The log is the one thing in a store that costs real bytes: a long
 * conversation is a hundred megabytes of JSON, and almost all of that JSON is
 * repeated keys, repeated tool names and long assistant paragraphs — text that
 * compresses several times over as soon as it is seen together.
 *
 * Compressing row by row does not get that: measured on the 47k-event sample,
 * one zstd frame per event reaches 2.4x while paying 1.2s to read it back,
 * because each frame carries its own header and each row is too short to find
 * much repetition inside itself. Compressing half a megabyte at a time reaches
 * 5.1x and reads *faster* than the uncompressed table, because a window of a few
 * hundred events then touches one or two frames instead of every row.
 *
 * The unit is a chunk: a contiguous run of events, written as their JSON lines
 * (a literal newline can never appear inside `JSON.stringify` output, so the
 * split is unambiguous), compressed as one frame. Chunks are immutable once
 * sealed — an append only ever writes past the seal, which is why a reader may
 * decode one without consulting anything else.
 *
 * @module dsh-session-optimizer/chunk
 */

import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Uncompressed bytes per chunk.
 *
 * Measured on the 47k-event sample by sweeping the budget and reading a
 * 500-event window out of the middle each time:
 *
 * | budget | file  | window 500 p50 | full read |
 * | 128 KiB| 26.3MB| 8.8ms          | 650ms     |
 * | 256 KiB| 24.6MB| 6.0ms          | 614ms     |
 * | 512 KiB| 23.1MB| 6.4ms          | 490ms     |
 * |   1 MiB| 21.2MB| 10.7ms         | 583ms     |
 * |   2 MiB| 19.7MB| 10.4ms         | 408ms     |
 * |   4 MiB| 18.9MB| 14.3ms         | 492ms     |
 *
 * Half a megabyte is where a 500-event page still fits in a couple of frames —
 * the unit the history reader actually asks for — while the file is within 10%
 * of what a megabyte-per-frame reaches. Bigger frames buy 2 MB of disk and lose
 * the read the feature exists to speed up.
 */
export const CHUNK_BYTES = 512 << 10

/** zstd level: 3 was within 3% of level 9's size at a quarter of the CPU. */
export const CHUNK_LEVEL = 3

/** Codec tag stored with a chunk, so a future build can tell frames apart. */
export const CHUNK_CODEC = 'zstd'

/** A sealed chunk as it is carried between the encoder and the database. */
export interface EncodedChunk {
  readonly firstSeq: number
  readonly lastSeq: number
  readonly eventCount: number
  /** Bytes of JSON before compression, the budget `CHUNK_BYTES` bounds. */
  readonly rawBytes: number
  /** Sum of `event.type.length` over the chunk — half of the log fold. */
  readonly typesBytes: number
  /** Sum of `event.time` over the chunk — the other half of the fold. */
  readonly timesTotal: number
  /** Event-type histogram, so the console can still group sealed events. */
  readonly types: Readonly<Record<string, number>>
  readonly payload: Buffer
}

function linesOf(events: readonly SessionEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n')
}

/**
 * Encode one chunk, or `undefined` for an empty batch.
 *
 * The events must be contiguous and in `seq` order: the decoder rebuilds the
 * rows by position, so a gap would be served as a dense log. Callers get that
 * guarantee from the append path, which refuses gaps before it writes.
 */
export function encodeChunk(events: readonly SessionEvent[]): EncodedChunk | undefined {
  if (events.length === 0) return undefined
  const first = events[0] as SessionEvent
  const last = events[events.length - 1] as SessionEvent
  if (last.seq - first.seq !== events.length - 1) {
    throw new Error(
      `a chunk must hold contiguous events: got ${String(events.length)} events spanning seq ${String(first.seq)}..${String(last.seq)}`,
    )
  }
  const text = linesOf(events)
  const types: Record<string, number> = {}
  let typesBytes = 0
  let timesTotal = 0
  for (const event of events) {
    types[event.type] = (types[event.type] ?? 0) + 1
    typesBytes += event.type.length
    timesTotal += event.time
  }
  return {
    firstSeq: first.seq,
    lastSeq: last.seq,
    eventCount: events.length,
    rawBytes: Buffer.byteLength(text, 'utf8'),
    typesBytes,
    timesTotal,
    types,
    payload: zstdCompressSync(Buffer.from(text, 'utf8'), {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: CHUNK_LEVEL },
    }),
  }
}

/**
 * Unpack one chunk into its JSON lines, without parsing them.
 *
 * Decompression cannot be narrowed — zstd has to run over the whole frame — but
 * parsing can. A 500-event frame feeding a 50-event page otherwise parses ten
 * times more rows than the caller reads, and on the 47k-event sample that parse
 * was 1.1ms of a 5ms cold page read.
 *
 * The event count is still checked here: it comes from the redundant columns and
 * a frame that disagrees with them is damaged, not short.
 */
export function decodeChunkLines(
  payload: Buffer,
  expected: { readonly firstSeq: number; readonly eventCount: number },
): string[] {
  const lines = zstdDecompressSync(payload).toString('utf8').split('\n')
  if (lines.length !== expected.eventCount) {
    throw new Error(
      `chunk starting at seq ${String(expected.firstSeq)} holds ${String(lines.length)} events, expected ${String(expected.eventCount)}`,
    )
  }
  return lines
}

/**
 * Decode one chunk back into events.
 *
 * Every row is re-parsed, and the caller compares the result with the redundant
 * columns it asked for — the same contract a row read has. A frame that is not
 * what it claims is reported as a length mismatch rather than served short.
 */
export function decodeChunk(
  payload: Buffer,
  expected: { readonly firstSeq: number; readonly eventCount: number },
): SessionEvent[] {
  const lines = decodeChunkLines(payload, expected)
  const events: SessionEvent[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const event = JSON.parse(lines[index] as string) as SessionEvent
    if (event.seq !== expected.firstSeq + index) {
      throw new Error(
        `chunk starting at seq ${String(expected.firstSeq)} holds seq ${String(event.seq)} at position ${String(index)}`,
      )
    }
    events.push(event)
  }
  return events
}

/**
 * Parse only the part of a chunk that a page actually reads.
 *
 * Rows outside `[from, to)` are skipped without parsing. Their presence is still
 * carried by the event count `decodeChunkLines` checked, and the whole frame is
 * covered by the seal's SQL fold — so a window read does not need every row's
 * `seq` re-verified to know the frame is the one the writer sealed.
 */
export function decodeChunkRange(
  lines: readonly string[],
  expected: { readonly firstSeq: number },
  from: number,
  to: number,
): SessionEvent[] {
  const first = Math.max(0, from - expected.firstSeq)
  const last = Math.min(lines.length, to - expected.firstSeq)
  const events: SessionEvent[] = []
  for (let index = first; index < last; index += 1) {
    const event = JSON.parse(lines[index] as string) as SessionEvent
    if (event.seq !== expected.firstSeq + index) {
      throw new Error(
        `chunk starting at seq ${String(expected.firstSeq)} holds seq ${String(event.seq)} at position ${String(index)}`,
      )
    }
    events.push(event)
  }
  return events
}
