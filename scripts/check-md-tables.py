"""Report Markdown tables whose rows disagree with the header's column count."""

import io
import re
import sys

ESCAPED_PIPE = re.compile(r"\\\|")


def cells(line: str) -> int:
    """Count cell separators, ignoring `\\|` escapes inside a cell."""
    return ESCAPED_PIPE.sub("", line).count("|")


def check(path: str) -> int:
    lines = io.open(path, encoding="utf-8").read().split("\n")
    problems = []
    index = 0
    while index < len(lines):
        line = lines[index]
        divider = lines[index + 1] if index + 1 < len(lines) else ""
        is_table = line.startswith("|") and divider.startswith("|") and set(
            divider.replace("|", "").replace(" ", "").replace("-", "").replace(":", "")
        ) == set()
        if not is_table:
            index += 1
            continue
        width = cells(line)
        row = index
        while row < len(lines) and lines[row].startswith("|"):
            if cells(lines[row]) != width:
                problems.append((row + 1, cells(lines[row]), width))
            row += 1
        index = row
    print(f"{path}: {len(lines)} lines, {len(problems)} table row(s) off")
    for line_no, got, want in problems:
        print(f"  line {line_no}: {got} pipes, header has {want}")
    return 1 if problems else 0


if __name__ == "__main__":
    failed = 0
    for target in sys.argv[1:]:
        failed |= check(target)
    sys.exit(failed)
