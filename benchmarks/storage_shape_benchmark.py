#!/usr/bin/env python3
"""Compare three storage shapes for the same session data.

| shape | what it is |
| --- | --- |
| ``jsonl_zstd`` | the official backend: one sequential zstd stream of JSON lines |
| ``sqlite_plain`` | this plugin before chunking: one SQLite row per event |
| ``sqlite_chunked`` | this plugin after ``compact()``: 512 KiB zstd chunks plus a tail of rows |

The script does **not** run the plugin or the official backend. It rebuilds the
shapes with Python's own ``sqlite3`` and ``zstandard`` bindings from one
synthetic session, so the structural trade-off is reproducible on any machine
without DSH installed:

* a sequential stream has to decompress every frame before the offset, so the
  cost of a window read grows with how deep the window sits;
* an index makes every window cost the same, wherever it sits;
* a full read is bounded by ``json.loads`` in all three shapes, so the gap
  there stays small - that is the honest part of the comparison;
* rows are far bigger than a compressed stream until ``compact()`` runs, which
  is why the plugin adds ``event_chunk``.

Usage:
    python benchmarks/storage_shape_benchmark.py
    python benchmarks/storage_shape_benchmark.py --events 50000 --rounds 7
"""

from __future__ import annotations

import argparse
import io
import json
import platform
import random
import sqlite3
import statistics
import sys
import tempfile
import time
from pathlib import Path

import zstandard

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "benchmarks" / "data"
FRAME_EVENTS = 64
ZSTD_LEVEL = 3
CHUNK_BUDGET = 512 * 1024


# --------------------------------------------------------------------------
# one synthetic session, serialised once so no side pays for json.dumps
# --------------------------------------------------------------------------


def vocabulary(size: int = 4096, seed: int = 7) -> list[str]:
    rng = random.Random(seed)
    consonants = "bcdfghjklmnprstvwz"
    vowels = "aeiou"
    words = set()
    while len(words) < size:
        word = "".join(rng.choice(consonants) + rng.choice(vowels) for _ in range(3))
        words.add(word)
    return sorted(words)


def build_session(count: int, seed: int = 11) -> list[str]:
    """Return ``count`` serialised events shaped like a real DSH session."""
    rng = random.Random(seed)
    words = vocabulary()
    kinds = ("user/message", "assistant/message", "tool/call", "tool/result")
    lines: list[str] = []
    for seq in range(count):
        kind = kinds[seq % len(kinds)]
        length = 40 + (seq * 37) % 260
        text = " ".join(rng.choices(words, k=length))
        if kind == "user/message":
            data = {"content": [{"type": "text", "text": text}]}
        elif kind == "assistant/message":
            data = {"content": [{"type": "text", "text": text}]}
        elif kind == "tool/call":
            data = {"name": "read_file", "arguments": {"path": f"src/module-{seq % 97}.ts", "limit": 200}}
        else:
            data = {"content": [{"type": "text", "text": text}], "isError": False}
        event = {"type": kind, "seq": seq, "time": 1762900000000 + seq * 137, "data": data}
        lines.append(json.dumps(event, ensure_ascii=False))
    return lines


HEADER = {"version": 4, "sessionId": "session-bench", "cwd": "/bench"}


# --------------------------------------------------------------------------
# shape 1: one sequential zstd stream of JSON lines, header first
# --------------------------------------------------------------------------


class JsonlStore:
    def __init__(self, path: Path, lines: list[str]) -> None:
        self.path = path
        self.lines = lines
        self.compressor = zstandard.ZstdCompressor(level=ZSTD_LEVEL)
        self.decompressor = zstandard.ZstdDecompressor()
        header = json.dumps({"type": "session", **HEADER}, ensure_ascii=False)
        payload = [header] + lines
        with path.open("wb") as handle:
            for start in range(0, len(payload), FRAME_EVENTS):
                frame = ("\n".join(payload[start : start + FRAME_EVENTS]) + "\n").encode()
                handle.write(self.compressor.compress(frame))

    def _reader(self):
        return io.BufferedReader(self.decompressor.stream_reader(self.path.open("rb")))

    def read_window(self, start: int, count: int) -> list[dict]:
        reader = self._reader()
        try:
            reader.readline()  # session header
            for _ in range(start):
                reader.readline()
            return [json.loads(reader.readline()) for _ in range(count)]
        finally:
            reader.close()

    def read_all(self) -> list[dict]:
        reader = self._reader()
        try:
            reader.readline()
            return [json.loads(line) for line in reader]
        finally:
            reader.close()

    def append(self, line: str) -> None:
        with self.path.open("ab") as handle:
            handle.write(self.compressor.compress((line + "\n").encode()))

    def size(self) -> int:
        return self.path.stat().st_size


# --------------------------------------------------------------------------
# shape 2 and 3: one row per event, optionally folded into zstd chunks
# --------------------------------------------------------------------------


class SqliteStore:
    def __init__(self, path: Path, lines: list[str], *, chunked: bool) -> None:
        self.path = path
        self.lines = lines
        self.chunked = chunked
        self.decompressor = zstandard.ZstdDecompressor()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._build()
        if chunked:
            self._compact()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, isolation_level=None)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _build(self) -> None:
        connection = sqlite3.connect(self.path)
        connection.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE storage_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                                       header_json TEXT NOT NULL);
            CREATE TABLE session_event (seq INTEGER PRIMARY KEY,
                                        event_type TEXT NOT NULL,
                                        event_time_ms INTEGER NOT NULL,
                                        event_json TEXT NOT NULL) WITHOUT ROWID;
            CREATE TABLE event_chunk (first_seq INTEGER PRIMARY KEY,
                                      last_seq INTEGER NOT NULL,
                                      event_count INTEGER NOT NULL,
                                      raw_bytes INTEGER NOT NULL,
                                      compressed_bytes INTEGER NOT NULL,
                                      payload BLOB NOT NULL,
                                      CHECK (last_seq = first_seq + event_count - 1));
            """
        )
        connection.execute("INSERT INTO storage_meta VALUES (1, ?)", (json.dumps(HEADER),))
        connection.executemany(
            "INSERT INTO session_event VALUES (?, ?, ?, ?)",
            [
                (seq, json.loads(line)["type"], 1762900000000 + seq * 137, line)
                for seq, line in enumerate(self.lines)
            ],
        )
        connection.commit()
        connection.close()

    def _compact(self) -> None:
        """Fold whole 512 KiB groups of rows into ``event_chunk``."""
        connection = self._connect()
        try:
            group: list[tuple[int, str]] = []
            raw = 0
            with connection:
                for seq, line in connection.execute("SELECT seq, event_json FROM session_event ORDER BY seq"):
                    group.append((seq, line))
                    raw += len(line.encode()) + 1
                    if raw >= CHUNK_BUDGET:
                        self._flush(connection, group, raw)
                        group, raw = [], 0
                if group and raw >= CHUNK_BUDGET // 2:  # keep the small tail as rows
                    self._flush(connection, group, raw)
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("VACUUM")
        finally:
            connection.close()

    def _flush(self, connection: sqlite3.Connection, group: list[tuple[int, str]], raw: int) -> None:
        payload = zstandard.ZstdCompressor(level=ZSTD_LEVEL).compress(
            ("\n".join(line for _seq, line in group) + "\n").encode()
        )
        first, last = group[0][0], group[-1][0]
        connection.execute(
            "INSERT INTO event_chunk VALUES (?, ?, ?, ?, ?, ?)",
            (first, last, len(group), raw, len(payload), payload),
        )
        connection.execute("DELETE FROM session_event WHERE seq >= ? AND seq <= ?", (first, last))

    def _chunk_lines(self, connection: sqlite3.Connection, first_seq: int) -> list[str]:
        # No frame cache here on purpose: every window read pays the decompression
        # of its chunk, which is the conservative measurement.
        row = connection.execute("SELECT payload FROM event_chunk WHERE first_seq = ?", (first_seq,)).fetchone()
        return self.decompressor.decompress(row[0]).decode().split("\n")[:-1]

    def read_window(self, start: int, count: int) -> list[dict]:
        connection = self._connect()
        try:
            end = start + count
            windows: list[tuple[int, str]] = []
            if self.chunked:
                for first, last in connection.execute(
                    "SELECT first_seq, last_seq FROM event_chunk WHERE last_seq >= ? AND first_seq < ?",
                    (start, end),
                ):
                    lines = self._chunk_lines(connection, first)
                    for offset, line in enumerate(lines):
                        seq = first + offset
                        if start <= seq < end:
                            windows.append((seq, line))
            for seq, line in connection.execute(
                "SELECT seq, event_json FROM session_event WHERE seq >= ? AND seq < ?", (start, end)
            ):
                windows.append((seq, line))
            windows.sort()
            return [json.loads(line) for _seq, line in windows]
        finally:
            connection.close()

    def read_all(self) -> list[dict]:
        connection = self._connect()
        try:
            events: list[dict] = []
            if self.chunked:
                for first, payload in connection.execute(
                    "SELECT first_seq, payload FROM event_chunk ORDER BY first_seq"
                ):
                    lines = self.decompressor.decompress(payload).decode().split("\n")[:-1]
                    events.extend(json.loads(line) for line in lines)
            events.extend(
                json.loads(line)
                for (line,) in connection.execute("SELECT event_json FROM session_event ORDER BY seq")
            )
            return events
        finally:
            connection.close()

    def append(self, line: str) -> None:
        connection = self._connect()
        try:
            seq = connection.execute("SELECT COALESCE(MAX(seq), -1) + 1 FROM session_event").fetchone()[0]
            if self.chunked:
                row = connection.execute("SELECT last_seq FROM event_chunk ORDER BY last_seq DESC LIMIT 1").fetchone()
                seq = max(seq, (row[0] + 1) if row else 0)
            connection.execute(
                "INSERT INTO session_event VALUES (?, ?, ?, ?)",
                (seq, json.loads(line)["type"], 1762900000000 + seq * 137, line),
            )
        finally:
            connection.close()

    def size(self) -> int:
        total = self.path.stat().st_size
        for suffix in ("-wal", "-shm"):
            side = Path(str(self.path) + suffix)
            if side.exists():
                total += side.stat().st_size
        return total


# --------------------------------------------------------------------------
# measurement
# --------------------------------------------------------------------------


def measure(label: str, rounds: int, operation) -> float:
    samples = []
    for _ in range(rounds):
        started = time.perf_counter()
        operation()
        samples.append((time.perf_counter() - started) * 1000)
    value = statistics.median(samples)
    print(f"  {label:<22} {value:8.3f} ms")
    return value


def run_store(key: str, label: str, store, count: int, rounds: int) -> list[tuple[str, str, float]]:
    print(f"\n{label}")
    operations = (
        ("read_first_100", lambda: store.read_window(0, 100)),
        ("read_mid_100", lambda: store.read_window(count // 2, 100)),
        ("read_tail_100", lambda: store.read_window(count - 100, 100)),
        ("full_scan", store.read_all),
        ("append_one", lambda: store.append(store.lines[0])),
    )
    rows = []
    for operation, op in operations:
        row_rounds = max(1, rounds // 2) if operation == "full_scan" else rounds
        rows.append((key, operation, measure(operation, row_rounds, op)))
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--events", type=int, default=20000, help="session size in events (default 20000)")
    parser.add_argument("--rounds", type=int, default=5, help="rounds per operation, median reported (default 5)")
    parser.add_argument("--out-dir", default=str(DATA_DIR), help="where the CSV files are written")
    arguments = parser.parse_args()

    count = arguments.events
    rounds = arguments.rounds
    lines = build_session(count)
    print(f"session: {count} events, {sum(len(line) for line in lines) / 1e6:.2f} MB of JSON, {rounds} rounds")

    with tempfile.TemporaryDirectory(prefix="dsh-bench-") as workdir:
        work = Path(workdir)
        stores = {
            "jsonl_zstd": JsonlStore(work / "session.v4.jsonl.zstd", lines),
            "sqlite_plain": SqliteStore(work / "plain" / "session.db", lines, chunked=False),
            "sqlite_chunked": SqliteStore(work / "chunked" / "session.db", lines, chunked=True),
        }
        rows: list[tuple[str, str, float]] = []
        labels = {
            "jsonl_zstd": "JSONL + zstd (official shape)",
            "sqlite_plain": "SQLite, one row per event (before compact)",
            "sqlite_chunked": "SQLite, 512 KiB zstd chunks (after compact)",
        }
        for name, store in stores.items():
            rows.extend(run_store(name, labels[name], store, count, rounds))
        sizes = {name: store.size() for name, store in stores.items()}

    out_dir = Path(arguments.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    latency_csv = out_dir / "storage-shape-latency.csv"
    with latency_csv.open("w", encoding="utf-8", newline="") as handle:
        handle.write("backend,operation,ms\n")
        for backend, operation, value in rows:
            handle.write(f"{backend},{operation},{value:.3f}\n")

    size_csv = out_dir / "storage-shape-size.csv"
    with size_csv.open("w", encoding="utf-8", newline="") as handle:
        handle.write("backend,mb\n")
        for backend, value in sizes.items():
            handle.write(f"{backend},{value / 1e6:.3f}\n")

    meta = {
        "events": count,
        "rounds": rounds,
        "frame_events": FRAME_EVENTS,
        "chunk_budget": CHUNK_BUDGET,
        "zstd_level": ZSTD_LEVEL,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "sqlite": sqlite3.sqlite_version,
        "zstandard": zstandard.__version__,
        "note": "synthetic session, Python bindings, storage shapes only; not the plugin's JavaScript measurement",
    }
    (out_dir / "storage-shape-meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    by_operation: dict[str, dict[str, float]] = {}
    for backend, operation, value in rows:
        by_operation.setdefault(operation, {})[backend] = value
    print("\n| operation | JSONL + zstd | SQLite rows | SQLite chunks |")
    print("| --- | --- | --- | --- |")
    for operation, values in by_operation.items():
        print(
            f"| {operation} | {values['jsonl_zstd']:.2f} ms | "
            f"{values['sqlite_plain']:.2f} ms | {values['sqlite_chunked']:.2f} ms |"
        )
    print(
        "\nsize: " + ", ".join(f"{name} {value / 1e6:.2f} MB" for name, value in sizes.items())
    )
    print(f"wrote storage-shape-latency.csv, storage-shape-size.csv, storage-shape-meta.json to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
