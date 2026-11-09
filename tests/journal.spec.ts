/**
 * The migration history file: what a restart must not erase.
 *
 * Two properties are worth a test each, because both are invisible until they
 * fail in front of an operator: a run that finished is still listed after a
 * restart, and a run that was in flight when its process died is reported as
 * failed with a reason instead of disappearing.
 *
 * @module dsh-session-optimizer/tests/journal.spec
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachMigrationJournal,
  detachMigrationJournal,
  listMigrations,
  startMigration,
} from '../src/migrate.ts'

const directories: string[] = []

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-journal-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await detachMigrationJournal()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function storedJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'mig-1',
    direction: 'jsonl_to_sqlite',
    mode: 'overwrite',
    sourceRoot: '/source',
    targetRoot: '/target',
    status: 'completed',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    ...overrides,
  }
}

describe('the migration journal', () => {
  it('still lists a finished run after a restart', async () => {
    const directory = await makeDirectory()
    await writeFile(
      join(directory, 'migrations.json'),
      JSON.stringify({ version: 1, jobs: [storedJob({})] }),
    )

    await attachMigrationJournal(directory)
    const jobs = listMigrations()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ id: 'mig-1', status: 'completed', targetRoot: '/target' })
  })

  it('reports a run that was cut off as failed, with a reason', async () => {
    const directory = await makeDirectory()
    await writeFile(
      join(directory, 'migrations.json'),
      JSON.stringify({ version: 1, jobs: [storedJob({ id: 'mig-cut', status: 'running', finishedAt: undefined })] }),
    )

    await attachMigrationJournal(directory)
    const job = listMigrations()[0]
    expect(job.status).toBe('failed')
    // The reason has to say what to do next: the copy may be half written.
    expect(job.error).toContain('start it again')
    expect(job.finishedAt).toBe(job.startedAt)
  })

  it('ignores a file it cannot use instead of failing the mount', async () => {
    const directory = await makeDirectory()
    await writeFile(join(directory, 'migrations.json'), '{ this is not json')

    await attachMigrationJournal(directory)
    expect(listMigrations()).toEqual([])
  })

  it('writes a started run down so the next process can report it', async () => {
    const directory = await makeDirectory()
    await attachMigrationJournal(directory)

    // Both roots are empty directories, so the run finishes immediately — the
    // point is that starting one is enough to leave a record behind.
    const job = startMigration(
      {
        catalog: {} as never,
        jsonl: { id: 'jsonl', root: join(directory, 'jsonl') },
        sqlite: { id: 'sqlite', root: join(directory, 'sqlite') },
      },
      'jsonl_to_sqlite',
      { mode: 'overwrite', verify: false, readOnlySources: true } as never,
    )
    expect(listMigrations().map((entry) => entry.id)).toContain(job.id)

    // The save is coalesced on a short timer, so wait for the file to appear.
    const path = join(directory, 'migrations.json')
    const deadline = Date.now() + 5000
    let text = ''
    while (Date.now() < deadline) {
      text = await readFile(path, 'utf8').catch(() => '')
      if (text !== '') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(text).toContain(job.id)
    const document = JSON.parse(text) as { version: number; jobs: Array<{ id: string }> }
    expect(document.version).toBe(1)
    expect(document.jobs.map((entry) => entry.id)).toContain(job.id)
  })
})
