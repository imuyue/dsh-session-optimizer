#!/usr/bin/env python3
"""Render the charts that compare this plugin's SQLite backend against the
official JSONL backend.

Input: the CSV files in ``benchmarks/data/`` (ASCII keys only).
Output: ``docs/images/<chart>.png`` and ``.svg``.

Usage:
    python benchmarks/plot_results.py                 # Chinese labels when a CJK font exists
    python benchmarks/plot_results.py --lang en       # force English labels
    python benchmarks/plot_results.py --out-dir /tmp/charts

The numbers come from measurements described in ``docs/benchmarks.md``; this
script only draws them, it never measures anything itself.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.ticker import FixedLocator, FuncFormatter, NullLocator

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "benchmarks" / "data"
OUT_DIR = ROOT / "docs" / "images"

SQLITE = "#2563eb"
JSONL = "#94a3b8"
ACCENT = "#ea580c"
GRID = "#e2e8f0"
INK = "#1e293b"
MUTED = "#64748b"

CJK_FONTS = (
    "Microsoft YaHei",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "PingFang SC",
    "Hiragino Sans GB",
    "WenQuanYi Zen Hei",
    "SimHei",
    "Arial Unicode MS",
)

LABELS = {
    "zh": {
        "open_header": "打开会话读 header",
        "read_first_100": "读首屏 100 条",
        "read_tail_100": "读尾页 100 条",
        "read_middle_100": "读中段 100 条",
        "read_mid_100": "读中段 100 条",
        "read_tail_100": "读尾页 100 条",
        "read_random_200": "随机位置读 200 条",
        "stat": "stat（列表元数据）",
        "append_one": "追加 1 条事件",
        "create_session": "新建会话",
        "sqlite": "SQLite 后端",
        "jsonl": "官方 JSONL 后端",
        "latency_title": "交互路径延迟：同一会话（47,374 事件）",
        "latency_sub": "中位数，对数刻度；每轮重建挂载，等价于进程第一次碰到这段历史",
        "latency_x": "耗时（毫秒，对数刻度）",
        "ratio": "倍数",
        "full_scan": "整段读取",
        "fullscan_title": "整段读取：两边都要产出 47,374 个对象",
        "fullscan_x": "耗时（毫秒）",
        "jsonl_zstd_only": "JSONL 纯解压（不 parse）",
        "jsonl_parse_only": "47375 行 JSON.parse（不碰 SQLite）",
        "sqlite_no_seal": "SQLite 逐行比对（无 seal）",
        "sqlite_seal": "SQLite seal 可信快路径",
        "sqlite_chunked_probe": "SQLite 分块压缩（探针口径）",
        "sqlite_chunked_e2e": "SQLite 分块压缩（端到端）",
        "fullscan_sub": "只做解压就要 653 ms；按块读取只碰窗口真正需要的那几块",
        "size_title": "同一会话的磁盘占用",
        "size_x": "体积（MB）",
        "jsonl_zstd": "JSONL + zstd（官方）",
        "sqlite_plain": "SQLite 一行一事件",
        "sqlite_chunked": "SQLite + 512 KiB zstd 分块",
        "size_note": "47,374 事件；分块后比官方 JSONL 还小 39%",
        "chunk_title": "分块压缩前后的读放大（同一会话）",
        "window_100_at_0": "读 100 条 @0",
        "window_500_at_20000": "读 500 条 @20000",
        "page_500_steady": "单页 500 条（稳定态）",
        "backfill_95_pages": "95 页全量回溯",
        "append_one_c": "写 1 条事件",
        "before": "压缩前",
        "after": "压缩后",
        "chunk_x": "耗时（毫秒，对数刻度）",
        "shape_title": "Python 复现：同一份 20,000 事件数据的三种存储形态",
        "shape_sub": "本地生成的数据，Python 绑定；只复现存储形态，不是插件本体的 JavaScript 测量",
        "shape_footer": "由 benchmarks/storage_shape_benchmark.py 生成；数字随机器变化，比例关系不变",
        "shape_x": "耗时（毫秒，对数刻度）",
        "shape_size_title": "同数据量下的体积",
        "shape_size_x": "体积（MB）",
        "jsonl_zstd": "JSONL + zstd（官方形态）",
        "sqlite_plain": "SQLite 一行一事件",
        "sqlite_chunked": "SQLite 512 KiB 分块",
        "footer": "测量环境：Windows / Node 24，DSH 0.2.2-rc.1，单机单会话；复现步骤见 docs/benchmarks.md",
    },
    "en": {
        "open_header": "open session (header)",
        "read_first_100": "first page of 100",
        "read_tail_100": "tail page of 100",
        "read_middle_100": "mid page of 100",
        "read_mid_100": "mid page of 100",
        "read_tail_100": "tail page of 100",
        "read_random_200": "200 events at random offset",
        "stat": "stat (list metadata)",
        "append_one": "append one event",
        "create_session": "create session",
        "sqlite": "SQLite backend",
        "jsonl": "official JSONL backend",
        "latency_title": "Interactive latency, one 47,374-event session",
        "latency_sub": "median, log scale; the mount is rebuilt on every round",
        "latency_x": "time (ms, log scale)",
        "ratio": "speedup",
        "full_scan": "full read",
        "fullscan_title": "Full read: both sides must materialise 47,374 objects",
        "fullscan_x": "time (ms)",
        "jsonl_zstd_only": "JSONL decompress only",
        "jsonl_parse_only": "47375 x JSON.parse",
        "sqlite_no_seal": "SQLite, row-by-row check",
        "sqlite_seal": "SQLite, trusted seal",
        "sqlite_chunked_probe": "SQLite chunked (probe)",
        "sqlite_chunked_e2e": "SQLite chunked (end-to-end)",
        "fullscan_sub": "Decompress-only alone costs 653 ms; chunked reads touch only what a window needs",
        "size_title": "On-disk size of the same session",
        "size_x": "size (MB)",
        "jsonl_zstd": "JSONL + zstd (official)",
        "sqlite_plain": "SQLite, one row per event",
        "sqlite_chunked": "SQLite + 512 KiB zstd chunks",
        "size_note": "47,374 events; chunked is 39% smaller than official JSONL",
        "chunk_title": "Read amplification before and after chunking",
        "window_100_at_0": "100 events @0",
        "window_500_at_20000": "500 events @20000",
        "page_500_steady": "one page of 500 (steady)",
        "backfill_95_pages": "95 pages backfill",
        "append_one_c": "write one event",
        "before": "before",
        "after": "after",
        "chunk_x": "time (ms, log scale)",
        "shape_title": "Python reproduction: three storage shapes, one 20,000-event session",
        "shape_sub": "locally generated data, Python bindings; storage shapes only, not the plugin's JavaScript",
        "shape_footer": "produced by benchmarks/storage_shape_benchmark.py; absolute numbers vary by machine",
        "shape_x": "time (ms, log scale)",
        "shape_size_title": "size for the same data",
        "shape_size_x": "size (MB)",
        "jsonl_zstd": "JSONL + zstd (official shape)",
        "sqlite_plain": "SQLite, one row per event",
        "sqlite_chunked": "SQLite, 512 KiB chunks",
        "footer": "Measured on Windows with Node 24 and DSH 0.2.2-rc.1; reproduction steps in docs/benchmarks.md",
    },
}


def pick_language(requested: str) -> str:
    if requested != "auto":
        return requested
    installed = {f.name for f in font_manager.fontManager.ttflist}
    return "zh" if any(name in installed for name in CJK_FONTS) else "en"


def use_font(lang: str) -> None:
    installed = {f.name for f in font_manager.fontManager.ttflist}
    family = [name for name in CJK_FONTS if name in installed]
    family += ["DejaVu Sans"]
    plt.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": family,
            "axes.unicode_minus": False,
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.edgecolor": GRID,
            "axes.labelcolor": MUTED,
            "text.color": INK,
            "xtick.color": MUTED,
            "ytick.color": INK,
            "svg.fonttype": "none",
        }
    )


def read_csv(name: str) -> list[dict[str, str]]:
    with (DATA_DIR / name).open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def clean(axis, *, log: bool) -> None:
    for side in ("top", "right", "left"):
        axis.spines[side].set_visible(False)
    axis.spines["bottom"].set_color(GRID)
    axis.tick_params(axis="y", length=0)
    axis.grid(axis="x", color=GRID, linewidth=0.9, zorder=0)
    axis.set_axisbelow(True)
    if log:
        axis.set_xscale("log")


def log_ticks(axis, values: list[float]) -> None:
    ticks = []
    for exponent in range(0, 4):
        for mantissa in (1, 2, 5):
            candidate = mantissa * 10**exponent
            if candidate <= max(values) * 1.1:
                ticks.append(candidate)
    axis.xaxis.set_major_locator(FixedLocator(ticks))
    axis.xaxis.set_minor_locator(NullLocator())
    axis.xaxis.set_major_formatter(
        FuncFormatter(lambda value, _pos: f"{value:g}" if value >= 1 else f"{value:g}")
    )


def save(fig, name: str, out_dir: Path, lang: str) -> None:
    """Write ``<name>.<lang>.png`` and ``.svg`` so both READMEs can embed theirs."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for suffix in ("png", "svg"):
        fig.savefig(out_dir / f"{name}.{lang}.{suffix}", bbox_inches="tight", dpi=220)
    plt.close(fig)
    print(f"wrote {out_dir / f'{name}.{lang}.png'}")


def bar_pair(axis, rows, label_of, *, labels, colors, width=0.36):
    """Draw two bars per row (SQLite above, JSONL below) on a log x axis."""
    height = 0.38
    for index, row in enumerate(rows):
        base = len(rows) - 1 - index
        left = float(row["sqlite_ms"])
        right = float(row["jsonl_ms"])
        axis.barh(base + height / 2, left, height, color=colors[0], zorder=3)
        axis.barh(base - height / 2, right, height, color=colors[1], zorder=3)
        axis.text(
            left * 1.12,
            base + height / 2,
            f"{left:.1f} ms" if left >= 1 else f"{left:.2f} ms",
            va="center",
            fontsize=8.5,
            color=colors[0],
            fontweight="bold",
        )
        axis.text(
            right * 1.12,
            base - height / 2,
            f"{right:.1f} ms" if right >= 1 else f"{right:.2f} ms",
            va="center",
            fontsize=8.5,
            color=MUTED,
        )
        ratio = row["ratio"]
        axis.text(
            1.02,
            base,
            f"×{float(ratio):g}" if float(ratio) >= 1 else f"×{float(ratio):g}",
            transform=axis.get_yaxis_transform(),
            va="center",
            ha="left",
            fontsize=9,
            color=ACCENT if float(ratio) >= 1 else MUTED,
            fontweight="bold" if float(ratio) >= 2 else "normal",
        )
    axis.set_yticks([len(rows) - 1 - i for i in range(len(rows))])
    axis.set_yticklabels([label_of(row) for row in rows], fontsize=9.5)


def plot_interactive(lang: str, out_dir: Path) -> None:
    t = LABELS[lang]
    rows = read_csv("interactive-latency.csv")
    fig, axis = plt.subplots(figsize=(9.4, 4.9))
    clean(axis, log=True)
    log_ticks(axis, [float(r["jsonl_ms"]) for r in rows])
    bar_pair(
        axis,
        rows,
        lambda row: t[row["operation"].strip()],
        labels=t,
        colors=(SQLITE, JSONL),
    )
    axis.set_xlabel(t["latency_x"], fontsize=9.5)
    axis.set_title(t["latency_title"], loc="left", fontsize=13, fontweight="bold", pad=26)
    axis.text(
        0,
        1.035,
        t["latency_sub"],
        transform=axis.transAxes,
        fontsize=9,
        color=MUTED,
    )
    axis.set_xlim(right=1000)
    axis.annotate(
        t["ratio"],
        xy=(1.02, 1.0),
        xycoords=axis.transAxes,
        xytext=(0, 6),
        textcoords="offset points",
        fontsize=8.5,
        color=MUTED,
        ha="left",
    )
    handles = [
        plt.Rectangle((0, 0), 1, 1, color=SQLITE),
        plt.Rectangle((0, 0), 1, 1, color=JSONL),
    ]
    axis.legend(
        handles,
        [t["sqlite"], t["jsonl"]],
        loc="lower right",
        frameon=False,
        fontsize=9,
        handlelength=1.1,
    )
    fig.text(0.008, -0.03, t["footer"], fontsize=7.5, color=MUTED)
    save(fig, "interactive-latency", out_dir, lang)


def plot_full_scan(lang: str, out_dir: Path) -> None:
    t = LABELS[lang]
    rows = read_csv("full-scan.csv")
    order = [
        "jsonl_zstd_only",
        "jsonl_parse_only",
        "jsonl",
        "sqlite_no_seal",
        "sqlite_seal",
        "sqlite_chunked_probe",
        "sqlite_chunked_e2e",
    ]
    rows.sort(key=lambda row: order.index(row["implementation"]))
    fig, axis = plt.subplots(figsize=(9.4, 4.2))
    clean(axis, log=False)
    colors = {
        "jsonl": JSONL,
        "jsonl_zstd_only": "#cbd5e1",
        "jsonl_parse_only": "#cbd5e1",
        "sqlite_no_seal": "#93b4f5",
        "sqlite_seal": SQLITE,
        "sqlite_chunked_probe": "#1d4ed8",
        "sqlite_chunked_e2e": "#1e3a8a",
    }
    positions = list(range(len(rows)))[::-1]
    for position, row in zip(positions, rows):
        value = float(row["ms"])
        axis.barh(
            position,
            value,
            height=0.62,
            color=colors[row["implementation"]],
            zorder=3,
        )
        axis.text(
            value + 12,
            position,
            f"{value:.0f} ms",
            va="center",
            fontsize=9,
            fontweight="bold",
            color=INK,
        )
    axis.set_yticks(positions)
    axis.set_yticklabels([t[row["implementation"]] for row in rows], fontsize=9.5)
    axis.set_xlim(0, 1010)
    axis.set_xlabel(t["fullscan_x"], fontsize=9.5)
    axis.set_title(t["fullscan_title"], loc="left", fontsize=13, fontweight="bold", pad=26)
    axis.text(
        0.0,
        1.045,
        t["fullscan_sub"],
        transform=axis.transAxes,
        fontsize=8.5,
        color=MUTED,
        va="bottom",
    )
    fig.text(0.008, -0.04, t["footer"], fontsize=7.5, color=MUTED)
    save(fig, "full-scan", out_dir, lang)


def plot_storage(lang: str, out_dir: Path) -> None:
    t = LABELS[lang]
    rows = read_csv("storage-size.csv")
    rows.sort(key=lambda row: float(row["mb"]))
    fig, axis = plt.subplots(figsize=(9.4, 2.9))
    clean(axis, log=False)
    palette = {"jsonl_zstd": JSONL, "sqlite_plain": "#93b4f5", "sqlite_chunked": SQLITE}
    for position, row in zip(range(len(rows))[::-1], rows):
        value = float(row["mb"])
        axis.barh(position, value, height=0.58, color=palette[row["backend"]], zorder=3)
        axis.text(
            value + 2.5,
            position,
            f"{value:.1f} MB",
            va="center",
            fontsize=10,
            fontweight="bold",
            color=INK,
        )
    axis.set_yticks(list(range(len(rows)))[::-1])
    axis.set_yticklabels([t[row["backend"]] for row in rows], fontsize=9.5)
    axis.set_xlim(0, 195)
    axis.set_xlabel(t["size_x"], fontsize=9.5)
    axis.set_title(t["size_title"], loc="left", fontsize=13, fontweight="bold", pad=24)
    axis.text(0, 1.06, t["size_note"], transform=axis.transAxes, fontsize=9, color=MUTED)
    fig.text(0.008, -0.14, t["footer"], fontsize=7.5, color=MUTED)
    save(fig, "storage-size", out_dir, lang)


def plot_chunking(lang: str, out_dir: Path) -> None:
    t = LABELS[lang]
    rows = read_csv("chunking.csv")
    fig, axis = plt.subplots(figsize=(9.4, 4.3))
    clean(axis, log=True)
    values = [float(r["before_ms"]) for r in rows] + [float(r["after_ms"]) for r in rows]
    log_ticks(axis, values)
    height = 0.34
    key = {
        "window_100_at_0": "window_100_at_0",
        "window_500_at_20000": "window_500_at_20000",
        "page_500_steady": "page_500_steady",
        "backfill_95_pages": "backfill_95_pages",
        "append_one": "append_one_c",
    }
    for index, row in enumerate(rows):
        base = len(rows) - 1 - index
        before = float(row["before_ms"])
        after = float(row["after_ms"])
        axis.barh(base + height / 2, before, height, color="#cbd5e1", zorder=3)
        axis.barh(base - height / 2, after, height, color=SQLITE, zorder=3)
        axis.text(before * 1.06, base + height / 2, f"{before:.2f} ms".replace(".00", ""), va="center", fontsize=8.5, color=MUTED)
        axis.text(after * 1.06, base - height / 2, f"{after:.2f} ms".replace(".00", ""), va="center", fontsize=8.5, color=SQLITE, fontweight="bold")
        delta = (before - after) / before * 100
        axis.text(
            1.02,
            base,
            f"-{delta:.0f}%" if delta > 0 else f"+{abs(delta):.0f}%",
            transform=axis.get_yaxis_transform(),
            va="center",
            fontsize=9,
            color=ACCENT if delta > 0 else MUTED,
            fontweight="bold",
        )
    axis.set_yticks(list(range(len(rows)))[::-1])
    axis.set_yticklabels([t[key[row["operation"]]] for row in rows], fontsize=9.5)
    axis.set_xlim(right=1500)
    axis.set_xlabel(t["chunk_x"], fontsize=9.5)
    axis.set_title(t["chunk_title"], loc="left", fontsize=13, fontweight="bold", pad=14)
    handles = [
        plt.Rectangle((0, 0), 1, 1, color="#cbd5e1"),
        plt.Rectangle((0, 0), 1, 1, color=SQLITE),
    ]
    axis.legend(handles, [t["before"], t["after"]], loc="lower right", frameon=False, fontsize=9, handlelength=1.1)
    fig.text(0.008, -0.04, t["footer"], fontsize=7.5, color=MUTED)
    save(fig, "chunking", out_dir, lang)


def plot_storage_shape(lang: str, out_dir: Path) -> None:
    """Chart the locally generated numbers from storage_shape_benchmark.py."""
    latency_path = DATA_DIR / "storage-shape-latency.csv"
    size_path = DATA_DIR / "storage-shape-size.csv"
    if not latency_path.exists() or not size_path.exists():
        print("skip storage-shape: run benchmarks/storage_shape_benchmark.py first")
        return
    t = LABELS[lang]
    rows = read_csv("storage-shape-latency.csv")
    sizes = read_csv("storage-shape-size.csv")
    operations = ["read_first_100", "read_mid_100", "read_tail_100", "full_scan", "append_one"]
    backends = ["sqlite_plain", "sqlite_chunked", "jsonl_zstd"]
    palette = {"jsonl_zstd": JSONL, "sqlite_plain": "#93b4f5", "sqlite_chunked": SQLITE}
    values = {(row["backend"], row["operation"]): float(row["ms"]) for row in rows}

    fig, (left, right) = plt.subplots(
        1,
        2,
        figsize=(12.8, 4.6),
        gridspec_kw={"width_ratios": [2.3, 1], "wspace": 0.5},
    )
    clean(left, log=True)
    positive = [value for value in values.values() if value > 0]
    log_ticks(left, positive)
    height = 0.26
    for index, operation in enumerate(operations):
        base = len(operations) - 1 - index
        for offset, backend in enumerate(backends):
            value = values.get((backend, operation), 0.0)
            position = base + (1 - offset) * height
            left.barh(position, value, height * 0.92, color=palette[backend], zorder=3)
            left.text(
                value * 1.08,
                position,
                f"{value:.2f}",
                va="center",
                fontsize=7.8,
                color=INK if backend == "sqlite_chunked" else MUTED,
                fontweight="bold" if backend == "sqlite_chunked" else "normal",
            )
    left.set_yticks(list(range(len(operations)))[::-1])
    left.set_yticklabels([t[operation] for operation in operations], fontsize=9.5)
    left.set_xlabel(t["shape_x"], fontsize=9)
    left.set_title(t["shape_title"], loc="left", fontsize=12.5, fontweight="bold", pad=24)
    left.text(0, 1.045, t["shape_sub"], transform=left.transAxes, fontsize=8.5, color=MUTED)
    handles = [plt.Rectangle((0, 0), 1, 1, color=palette[name]) for name in backends]
    left.legend(
        handles,
        [t[name] for name in backends],
        loc="upper left",
        bbox_to_anchor=(0.0, -0.16),
        ncol=3,
        frameon=False,
        fontsize=8.5,
        handlelength=1.0,
        columnspacing=1.4,
    )

    clean(right, log=False)
    ordered = sorted(sizes, key=lambda row: float(row["mb"]))
    for position, row in zip(range(len(ordered))[::-1], ordered):
        value = float(row["mb"])
        right.barh(position, value, height=0.5, color=palette[row["backend"]], zorder=3)
        right.text(value * 1.02, position, f"{value:.1f} MB", va="center", fontsize=8.5, color=INK)
    right.set_yticks(list(range(len(ordered)))[::-1])
    right.set_yticklabels([t[row["backend"]] for row in ordered], fontsize=8.5)
    right.set_xlim(0, max(float(row["mb"]) for row in ordered) * 1.28)
    right.set_xlabel(t["shape_size_x"], fontsize=9)
    right.set_title(t["shape_size_title"], loc="left", fontsize=12.5, fontweight="bold", pad=14)

    fig.text(0.008, -0.13, t["shape_footer"], fontsize=7.5, color=MUTED)
    save(fig, "storage-shape-local", out_dir, lang)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang", choices=("auto", "both", "zh", "en"), default="both")
    parser.add_argument("--out-dir", default=str(OUT_DIR))
    arguments = parser.parse_args()
    languages = ("zh", "en") if arguments.lang == "both" else (arguments.lang,)
    out_dir = Path(arguments.out_dir)
    for requested in languages:
        lang = pick_language(requested)
        if requested == "zh" and lang == "en":
            print("warning: no CJK font found, the zh charts fall back to English labels")
        use_font(lang)
        plot_interactive(lang, out_dir)
        plot_full_scan(lang, out_dir)
        plot_storage(lang, out_dir)
        plot_chunking(lang, out_dir)
        plot_storage_shape(lang, out_dir)


if __name__ == "__main__":
    main()
