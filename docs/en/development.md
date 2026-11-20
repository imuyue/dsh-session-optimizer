# Development

> 简体中文：[docs/development.md](../development.md)

<!-- docs-nav -->
[Docs](../../README.en.md#documentation) · [Architecture](architecture.md) · [Configuration](configuration.md) · [CLI](cli.md) · [Console](console.md) · [Benchmarks](benchmarks.md) · [Limitations](limitations.md) · **Development**

## Requirements

| tool | version |
| --- | --- |
| Node.js | >= 24.9.0 |
| npm | any recent version |
| DSH | `0.2.2-rc.1` (peer, `>=0.2.2-rc.1`) |
| Python | 3.x, only for the benchmark charts (`zstandard`, `matplotlib`) |

## Build

```bash
npm install
npm run build          # tsc -p tsconfig.json && node scripts/build-client.mjs
```

| script | what it does |
| --- | --- |
| `npm run build` | host code plus the client bundle |
| `npm run build:host` | `tsc -p tsconfig.json` only |
| `npm run build:client` | rolldown bundle of `client/` into `lib/client.js` (CJS, React external) |
| `npm run typecheck` | host and client type checks without emitting |
| `npm test` | `vitest run` |

`lib/` is a build artifact and is git-ignored. `cordis.patch.yml`, `locale/*.json` and `icon.svg` are shipped as-is (they are listed in `files` in `package.json`).

The client bundle is loaded by the host through `window.__ModuleLoader__.load`, so it must be a single CJS file with React left external. `client/ambient.d.ts` supplies the slot and service types; `tsconfig.client.json` is the config that checks it.

## Tests

```bash
npm test                       # whole suite
npx vitest run tests/database.spec.ts
```

The suite is behavioural: most specs drive the plugin through the official `SessionPersistence` contract rather than through internal helpers, so a passing suite means the contract still holds. `tests/vendor/` and `tests/fixtures/official/` hold pinned copies of the official contract sources (`official-sessions.mjs`, `official-workspace.mjs`) used as the oracle — they are test fixtures, not a vendored runtime dependency.

When touching the write path, the handshake to respect is:

* `append` may return before the bytes are durable, `flush` may not;
* a torn tail must never be served;
* `revision` changes with content only, never with time or process.

### CI and both platforms

`.github/workflows/ci.yml` runs `typecheck`, `build` and `npm test` on `ubuntu-latest` **and** `windows-latest`. Both are needed: file leases, atomic renames and session directories are exactly where Linux and Windows disagree, so a Linux-only run hides every Windows-specific failure — which is how a release once shipped with 40 failing tests.

Keep the Windows constraint in mind when touching file paths: **while this process holds a connection — even `readOnly: true` — the store and its `-wal`/`-shm` cannot be renamed or deleted.** The system answers `EBUSY` (`EPERM` for a directory) and a retry cannot help, because the handle is ours. Every rename, delete or archive path asks `releaseStore()` (`src/store-lease.ts`) first — executors register a releaser at construction, and worker mode forwards that call to the worker thread. In tests, if the seeding context still caches the connection, `await releaseStore(path)` before touching the file.

## Regenerating the charts

```bash
python benchmarks/plot_results.py --lang both      # reads benchmarks/data/*.csv
python benchmarks/storage_shape_benchmark.py       # re-measures the Python reproduction
```

`plot_results.py` writes `docs/images/<chart>.<lang>.{png,svg}` for `zh` and `en`. It uses `Microsoft YaHei` when available and falls back to English labels with a warning when no CJK font exists.

## Layout

| path | content |
| --- | --- |
| `src/` | host code (see [architecture](architecture.md#source-map)) |
| `client/` | console UI, bundled to `lib/client.js` |
| `tests/` | vitest specs and contract fixtures |
| `scripts/` | build helpers (`build-client.mjs`, `build-performance-addon.mjs`, `patch-initial-history.mjs`, `check-md-tables.py`) |
| `benchmarks/` | measurement data and the plotting scripts |
| `locale/` | console strings |
| `docs/` | Chinese documentation; `docs/en/` holds the English version |
| `archive/` | historical design notes and development probes, not part of the package |

## Conventions

* TypeScript strict, ESM, `node:` prefixed built-ins, no new runtime dependency without a reason recorded in the pull request.
* SQLite access stays synchronous and confined to `src/database.ts`; everything that must not block the host goes through the executor (worker or inline).
* The JSONL side is only ever read through the official provider — never by parsing files directly, so both encodings and both layouts stay supported.
* Documentation describes behaviour and constraints. Design history, milestone tables and personal notes belong in `archive/`, not in `docs/`.
* One paragraph per source line: Markdown soft-wraps by itself, so a paragraph is never broken by hand. Tables, code fences and list items each start on their own line.

## Release

**Hard rule: no release without a tested update path.** A version that works only on a fresh install is a broken version — it fails exactly the people already running the previous one. Before publishing, run "install the previous version, install this version over it, restart, conversations still land in SQLite" on both Linux and Windows, and keep the commands and their output with the release notes.

Steps, once per machine:

1. Create a profile whose bundles are only `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` and this plugin.
2. `dsh plugin --profile <p> add dsh-session-optimizer@<previous>`, then boot `dsh <p> -- --port <n> --no-open` and confirm the port is listening.
3. With that process still running, `dsh plugin --profile <p> add <local tgz>` to install over it.
4. Stop it and boot again: the log must contain neither `did not activate` nor `has been registered`, and `dsh --profile <p> --dump-config` must show `disabled: true` on `session-persistence-jsonl`.
5. Do one real read and write (a sentence in the web app, or one headless task) and confirm the new store lands under `sessions-sqlite`.

Why the test suite is not enough: it mounts the plugin directly, bypassing profile composition and the loader patch layer, so "did the patch apply" and "in what order do services register" are invisible there — which is how 0.1.31 shipped `service "sessionPersistence" has been registered`. When that residue is what a composition reaches, the plugin now logs an actionable warning and lets the official backend serve instead of failing the profile.