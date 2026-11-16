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
