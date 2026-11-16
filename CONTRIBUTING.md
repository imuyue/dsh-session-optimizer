# Contributing

## Getting set up

```bash
npm install
npm run build      # host + client
npm test           # vitest
```

Node.js `>=24.9.0` and DSH `0.2.2-rc.1` are the supported versions. Python is only needed to regenerate the benchmark charts.

## Before you open a pull request

* `npm run typecheck` passes.
* `npm test` passes. Specs that drive the `SessionPersistence` contract are the important ones — they are the oracle for whether the backend still behaves like one.
* New behaviour is documented in `docs/` (Chinese) **and** `docs/en/` (English). Documentation describes behaviour and constraints only; design history and development notes stay out of the repository's user-facing docs.
* If you change a number in `benchmarks/data/`, say how it was measured in the pull request — machine, backend versions, sample size, and whether the store was warm.

## Invariants to keep

| invariant | why |
| --- | --- |
| `append()` may return before the bytes are durable, `flush()` may not | the host relies on `flush` as the durability barrier |
| a torn tail is never served | a partial write must not surface as an event |
| `revision` changes with content only | it is compared across processes to detect changes |
| the JSONL side is only touched through the official provider | two encodings and two layouts stay supported for free |
| one writer per session | the lease is what keeps concurrent hosts from interleaving commits |
| publishing happens after staging, read-back and rename | a crashed migration must leave the old store intact |

## Code style

TypeScript strict, ESM, `node:` prefixed built-ins, no dependency added without a reason stated in the pull request. SQLite access stays synchronous and confined to `src/database.ts`; anything that must not block the host goes through the executor (`worker` or `inline`).

## Reporting a problem

Include the plugin version, the DSH version, the operating system, the session size in events, and — when the report is about a specific conversation — the console's overview output for that store (counts, bytes, effective pragmas, and any reported problem). Do not paste conversation content: a store contains the entire conversation, including anything sensitive you typed.
