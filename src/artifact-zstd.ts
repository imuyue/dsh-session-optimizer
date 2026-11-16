import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'

/** Stream independent JSONL zstd frames through separate public-API decoders.
 * Node 24.21's decoder may stop after the first concatenated frame. Structural
 * framing also detects a torn final frame before treating EOF as success.
 * Header/block lengths follow the official JSONL provider's frame scanner;
 * native zstd still validates compressed blocks and checksums. No frame-sized
 * plaintext or compressed buffer is accumulated here.
 */
export async function* readArtifactZstd(path: string): AsyncGenerator<Buffer> {
  const raw = createReadStream(path)
  const iterator = raw[Symbol.asyncIterator]()
  let pending: Buffer = Buffer.alloc(0)
  let at = 0
  let ended = false
  async function ensure(): Promise<boolean> {
    if (at < pending.length) return true
    if (ended) return false
    const next = await iterator.next()
    if (next.done) { ended = true; return false }
    pending = next.value as Buffer; at = 0
    return pending.length !== 0 || ensure()
  }
  async function exact(size: number, optional = false): Promise<Buffer | undefined> {
    if (size === 0) return Buffer.alloc(0)
    if (!(await ensure())) { if (optional) return undefined; throw new Error('incomplete Zstandard artifact frame') }
    const output = Buffer.allocUnsafe(size)
    let filled = 0
    while (filled < size) {
      if (!(await ensure())) throw new Error('incomplete Zstandard artifact frame')
      const length = Math.min(size - filled, pending.length - at)
      pending.copy(output, filled, at, at + length)
      at += length; filled += length
    }
    return output
  }
  async function* payload(size: number): AsyncGenerator<Buffer> {
    while (size > 0) {
      if (!(await ensure())) throw new Error('incomplete Zstandard artifact frame')
      const length = Math.min(size, pending.length - at)
      const chunk = pending.subarray(at, at + length)
      at += length; size -= length
      yield chunk
    }
  }
  async function* frame(magic: Buffer): AsyncGenerator<Buffer> {
    if (magic.readUInt32LE(0) !== 0xfd2fb528) throw new Error('invalid Zstandard artifact frame magic')
    yield magic
    const descriptorBytes = (await exact(1))!
    const descriptor = descriptorBytes[0]!
    if ((descriptor & 24) !== 0) throw new Error('reserved Zstandard frame header bit')
    yield descriptorBytes
    const sizeFlag = descriptor >>> 6
    const single = (descriptor & 32) !== 0
    const dictFlag = descriptor & 3
    const headerSize = (single ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag)
    if (headerSize !== 0) yield (await exact(headerSize))!
    for (;;) {
      const bytes = (await exact(3))!
      const block = bytes.readUIntLE(0, 3)
      const type = (block >>> 1) & 3
      if (type === 3) throw new Error('reserved Zstandard block type')
      yield bytes
      yield* payload(type === 1 ? 1 : block >>> 3)
      if ((block & 1) !== 0) break
    }
    if ((descriptor & 4) !== 0) yield (await exact(4))!
  }
  try {
    for (;;) {
      const magic = await exact(4, true)
      if (magic === undefined) return
      const source = Readable.from(frame(magic), { objectMode: false })
      const decoder = createZstdDecompress()
      let failure: unknown
      // Attach before any asynchronous source/decode error can be emitted.
      const pumping = pipeline(source, decoder).catch((error: unknown) => { failure = error })
      try {
        for await (const chunk of decoder) yield chunk as Buffer
        await pumping
        if (failure !== undefined) throw failure
      } finally {
        source.destroy(); decoder.destroy()
        await pumping
      }
    }
  } finally {
    raw.destroy()
    await iterator.return?.()
  }
}
