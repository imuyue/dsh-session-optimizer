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

### CI 与两个平台

`.github/workflows/ci.yml` 在 `ubuntu-latest` 与 `windows-latest` 上都跑 `typecheck`、`build` 与 `npm test`。两个平台都要跑是有原因的：文件租约、原子改名与会话目录正是 Linux 与 Windows 分歧最大的地方，只在 Linux 上跑会让 Windows 专属的失败完全不可见——一个带 40 条失败用例的版本就是这样发出去的。

改动文件路径时记住 Windows 的约束：**本进程持有连接（哪怕 `readOnly: true`）时，该库及其 `-wal`/`-shm` 无法改名或删除**，系统回 `EBUSY`（目录是 `EPERM`），重试无效，因为句柄是自己的。任何改名/删除/归档案路径都要先经 `releaseStore()`（`src/store-lease.ts`）——执行器在启动时注册释放器，worker 模式会把它转发到工作线程。测试里如果播种用的 `ctx` 仍缓存着连接，同样要先 `await releaseStore(path)` 再动文件。

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

## 发布

**铁律：更新路径没有实测通过，就不发版。** 一个只在全新安装下可用的版本是坏版本——它只会让已经在用旧版本的人撞上错误。发布前必须在 linux 与 Windows 上各跑一遍「装上一版 → 覆盖安装这一版 → 重启 → 会话仍写进 SQLite」，并把命令与输出贴进发布记录。

步骤（两台机器各一次）：

1. 建一个只含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与本插件 bundle 的 profile。
2. `dsh plugin --profile <p> add dsh-session-optimizer@<上一版>`，启动 `dsh <p> -- --port <n> --no-open`，确认端口在听。
3. 保持进程运行，`dsh plugin --profile <p> add <本地 tgz>` 覆盖安装。
4. 结束进程后重启，确认启动日志既无 `did not activate` 也无 `has been registered`，且 `dsh --profile <p> --dump-config` 里 `session-persistence-jsonl` 带 `disabled: true`。
5. 触发一次真实读写（web 里发一句话，或 headless 跑一条任务），确认新库落在 `sessions-sqlite` 下。

为什么测试套件不够：套件直接挂插件，绕过了 profile 组合与 loader 的 patch 层，「patch 是否生效」与「服务注册顺序」这两类问题在测试里看不见——0.1.31 的 `service "sessionPersistence" has been registered` 就是这样漏出去的。遇到这类残留，插件现在的行为是记一条可照做的告警并让官方后端继续服务，而不是让 profile 起不来。