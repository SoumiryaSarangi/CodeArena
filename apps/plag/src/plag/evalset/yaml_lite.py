"""Just enough YAML for `problem.yaml`'s checker line (the plag service has no YAML dependency, and needs none)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


def load(path: Path) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for line in path.read_text().split("\n"):
        m = re.match(r"^checker:\s*\{(.*)\}\s*$", line)
        if m:
            fields = {}
            for part in m.group(1).split(","):
                if ":" in part:
                    k, v = part.split(":", 1)
                    fields[k.strip()] = v.strip()
            out["checker"] = fields
    return out
