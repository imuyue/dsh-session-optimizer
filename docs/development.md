# 开发

> English: [docs/en/development.md](en/development.md)

<!-- docs-nav -->
[文档](../README.md#文档) · [架构](architecture.md) · [配置](configuration.md) · [命令行](cli.md) · [控制台](console.md) · [基准测试](benchmarks.md) · [限制](limitations.md) · **开发**

## 环境要求

| 工具 | 版本 |
| --- | --- |
| Node.js | >= 24.9.0 |
| npm | 任意较新版本 |
| DSH | `0.2.2-rc.1`（peer，`>=0.2.2-rc.1`）|
| Python | 3.x，仅在画基准图时需要（`zstandard`、`matplotlib`）|

## 构建

```bash
npm install
npm run build          # tsc -p tsconfig.json && node scripts/build-client.mjs
```

| 脚本 | 作用 |
| --- | --- |
| `npm run build` | 宿主代码加客户端 bundle |
| `npm run build:host` | 只跑 `tsc -p tsconfig.json` |
| `npm run build:client` | 用 rolldown 把 `client/` 打成 `lib/client.js`（CJS，React 外置）|
| `npm run typecheck` | 宿主与客户端类型检查，不产出文件 |
| `npm test` | `vitest run` |

`lib/` 是构建产物，已在 `.gitignore` 中。`cordis.patch.yml`、`locale/*.json`、`icon.svg` 原样发布（列在 `package.json` 的 `files` 里）。

客户端 bundle 由宿主通过 `window.__ModuleLoader__.load` 加载，因此必须是单个 CJS 文件且 React 外置。`client/ambient.d.ts` 提供插槽与服务类型，`tsconfig.client.json` 负责校验它。

## 测试

```bash
npm test                       # 全量
npx vitest run tests/database.spec.ts
```

测试是行为级的：多数 spec 通过官方 `SessionPersistence` 契约驱动插件，而不是调用内部辅助函数，所以用例通过意味着契约仍然成立。`tests/vendor/` 与 `tests/fixtures/official/` 存放固定的官方契约源码副本（`official-sessions.mjs`、`official-workspace.mjs`）作为判定基准——它们是测试夹具，不是运行时依赖。

改动写路径时，必须守住的握手是：

* `append` 可以在字节落盘前返回，`flush` 不行；
* 撕裂尾绝不能被读出；
* `revision` 只随内容变化，不随时间或进程变化。

## 重新生成图表

```bash
python benchmarks/plot_results.py --lang both      # 读 benchmarks/data/*.csv
python benchmarks/storage_shape_benchmark.py       # 重新测量 Python 复现
```

`plot_results.py` 为 `zh` 与 `en` 各生成 `docs/images/<chart>.<lang>.{png,svg}`。有 `Microsoft YaHei` 时用它，没有中文字体时回落到英文标签并给出警告。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 宿主代码（见[架构](architecture.md)）|
| `client/` | 控制台界面，打包到 `lib/client.js` |
| `tests/` | vitest 用例与契约夹具 |
| `scripts/` | 构建辅助（`build-client.mjs`、`build-performance-addon.mjs`、`patch-initial-history.mjs`、`check-md-tables.py`）|
| `benchmarks/` | 测量数据与绘图脚本 |
| `locale/` | 控制台文案 |
| `docs/` | 中文文档；`docs/en/` 为英文版 |
| `archive/` | 历史设计记录与开发探针，不随包发布 |

## 约定

* TypeScript strict、ESM、内置模块加 `node:` 前缀；新增运行时依赖必须在 PR 里写明理由。
* SQLite 访问保持同步并限定在 `src/database.ts`；不能阻塞宿主的调用一律走执行器（worker 或 inline）。
* JSONL 一侧只通过官方 provider 读写，绝不直接解析文件，以同时支持两种编码与两种布局。
* 文档只描述行为与约束。设计历程、里程碑表格与个人笔记属于 `archive/`，不属于 `docs/`。
* 一段源码一行：Markdown 自己会软换行，段落不手工折断。表格、围栏代码块与列表项各自独占起行。
