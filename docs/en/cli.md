# Command line

> 简体中文：[docs/cli.md](../cli.md)

<!-- docs-nav -->
[Docs](../../README.en.md#documentation) · [Architecture](architecture.md) · [Configuration](configuration.md) · **CLI** · [Console](console.md) · [Benchmarks](benchmarks.md) · [Limitations](limitations.md) · [Development](development.md)

The package installs one binary, `dsh-session-optimizer` (built from `src/cli.ts`, exposed through `bin` in `package.json`). It operates on directories and never mounts a plugin, so it works on a store while DSH is closed and can be used to migrate, verify and export without touching a profile.

```
Usage: dsh-session-optimizer <command> [options]

  import           Copy sessions from a JSONL root into per-session SQLite files
  export           Write sessions from SQLite back to a JSONL root
  verify           Compare the SQLite copy against the JSONL original
  uninstall-check  List sessions that exist only in SQLite (unsafe to uninstall)
  upgrade          Move stores to this build's layout version
  compact          Seal the tail and give back free pages

  --from <dir>     Source root (JSONL root for import/verify, SQLite root for export)
  --to <dir>       Target root (SQLite root for import, JSONL root for export)
  --root <dir>     SQLite root (uninstall-check, upgrade, compact)
  --jsonl <dir>    JSONL root (uninstall-check)
  --session <id>   Only this session (default: every session in the source)
  --force          Replace an existing target session
  --json           Machine-readable report on stdout
```

Exit codes: `0` success, `1` verification or safety failure, `2` usage error.

## Copying into SQLite

```bash
dsh-session-optimizer import --from ~/.dsh/sessions --to ~/.dsh/sessions-sqlite
dsh-session-optimizer import --from ~/.dsh/sessions --to ~/.dsh/sessions-sqlite \
  --session <sessionId> --json
```

* The JSONL side is always read through the official provider, so both encodings (`.jsonl` and `.jsonl.zstd`) are understood, and so are the flat and per-session layouts.
* A session is staged at `<session.db>.importing`, read back event by event and compared, then renamed into place. A crash leaves the staging file behind; the console reports it in the overview instead of hiding it.
* The write lease on the target directory is taken before publishing.
* Without `--force`, an existing target session is skipped and reported as skipped.

## Copying back to JSONL

```bash
dsh-session-optimizer export --from ~/.dsh/sessions-sqlite --to ~/.dsh/sessions
dsh-session-optimizer verify --from ~/.dsh/sessions --to ~/.dsh/sessions-sqlite
```

`export` is the mirror image: staging at `<session dir>.exporting`, a read-back comparison, then an atomic rename of the inner session directory. `verify` walks both sides and compares headers and every event, which is the check to run before deleting a store.

Header fields are normalised for the receiving host: the physical `type: "session"` tag is dropped, and `cwd` is folded into an absolute path the opening host accepts (`C:\APP\x` ↔ `/mnt/c/APP/x`, UNC ↔ `//server/share`). A conversion that cannot express the `cwd` on the target host is refused instead of writing a header the host will reject.

## Uninstalling safely

```bash
dsh-session-optimizer uninstall-check --root ~/.dsh/sessions-sqlite --jsonl ~/.dsh/sessions
dsh-session-optimizer export --from ~/.dsh/sessions-sqlite --to ~/.dsh/sessions
# then remove the plugin and the two patch entries from cordis.patch.yml
```

`uninstall-check` lists conversations that exist only in SQLite (`sqlite`), only in JSONL (`jsonl`), orphaned directories, and unreadable databases. Uninstalling without exporting the `sqlite` column loses those conversations.

## Upgrading a store

```bash
dsh-session-optimizer upgrade --root ~/.dsh/sessions-sqlite
```

`upgrade` moves stores to the layout version this build writes, inside one `BEGIN IMMEDIATE` transaction per session; it is the only operation besides `compact()` that raises `user_version`.

## Reclaiming free pages

```bash
dsh-session-optimizer compact --root ~/.dsh/sessions-sqlite
dsh-session-optimizer compact --root ~/.dsh/sessions-sqlite --session <sessionId>
```

`compact` seals any tail still worth a frame, then gives back every free page. The `compact()` that runs on the append path only reclaims the pages that seal just freed, and a store whose tail is already under half a frame returns before that — so pages left by a truncation stay in the file. This command is not on the append path. It reclaims in batches of 1000 pages so one statement does not spill its working set into the WAL.
