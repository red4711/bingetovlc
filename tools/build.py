#!/usr/bin/env python3
"""Assemble dist/bingetovlc.user.js from src/.

A Tampermonkey userscript has to be a single file, but keeping one 2500 line file
in git would make the interesting parts (payload codec, ordering, M3U format)
unreviewable and untestable. So the source is small ES modules that Node can
import directly for tests, and this script flattens them.

What it does, in order:
  1. reads the metadata block from src/meta.js and substitutes the version from
     package.json
  2. concatenates the modules in dependency order, stripping `import`/`export`
     so the result is one classic script
  3. refuses to build on a name collision between modules: flattening modules
     into one scope is exactly where a silent bug would hide, so this is an
     error, not a warning
  4. wraps everything in an IIFE so nothing leaks into the page
  5. runs `node --check` on the result when Node is available
  6. in --check mode, compares against the committed dist/ and exits 2 on drift
     (CI uses this so a stale userscript can never be shipped)

Usage:
    python3 tools/build.py            # write dist/bingetovlc.user.js
    python3 tools/build.py --check    # fail if dist/ is out of date
    python3 tools/build.py --stdout   # print to stdout, write nothing
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "src"
DIST = REPO / "dist"
OUTPUT = DIST / "bingetovlc.user.js"

# Dependency order. Anything referenced at module top level must appear earlier.
MODULES = [
    "core/payload.js",
    "core/ordering.js",
    "core/m3u.js",
    "core/handoff.js",
    "core/emby/api.js",
    "core/emby/adapter.js",
    "core/generic/adapter.js",
    "core/diagnostics.js",
    "ui/settings.js",
    "ui/panel.js",
    "ui/banner.js",
    "main.js",
]

IMPORT_RE = re.compile(r"^\s*import\s+.*?;\s*$", re.MULTILINE)
MULTILINE_IMPORT_RE = re.compile(r"^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*\n", re.MULTILINE)
EXPORT_RE = re.compile(r"^(export\s+)(?:default\s+)?", re.MULTILINE)
DECL_RE = re.compile(
    r"^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)


class BuildError(SystemExit):
    pass


def read_version() -> str:
    try:
        return json.loads((REPO / "package.json").read_text(encoding="utf-8"))["version"]
    except Exception:  # noqa: BLE001
        return "0.0.0"


def read_meta() -> str:
    text = (SRC / "meta.js").read_text(encoding="utf-8")
    return text.replace("{{VERSION}}", read_version()).strip()


def strip_module(text: str, name: str) -> str:
    if MULTILINE_IMPORT_RE.search(text):
        raise BuildError(f"{name}: multi-line import found; keep imports on one line so the flattener stays simple")
    text = IMPORT_RE.sub("", text)
    text = EXPORT_RE.sub("", text)
    if re.search(r"^\s*export\b", text, re.MULTILINE):
        raise BuildError(f"{name}: an export survived flattening")
    if re.search(r"^\s*import\b", text, re.MULTILINE):
        raise BuildError(f"{name}: an import survived flattening")
    return text.rstrip() + "\n"


def collect() -> tuple[str, dict[str, str], list[tuple[str, str]], int]:
    parts: list[str] = []
    owners: dict[str, str] = {}
    collisions: list[tuple[str, str]] = []
    total_module_bytes = 0
    for relative in MODULES:
        path = SRC / relative
        if not path.exists():
            raise BuildError(f"missing module: src/{relative}")
        text = strip_module(path.read_text(encoding="utf-8"), relative)
        total_module_bytes += len(text)
        for declared in DECL_RE.findall(text):
            if declared in owners and owners[declared] != relative:
                collisions.append((declared, f"{owners[declared]} vs {relative}"))
            owners[declared] = relative
        separator = f"// ---- src/{relative} " + "-" * max(0, 60 - len(relative))
        # NOTE: the f-string prefix must cover the module body too. An earlier
        # version prefixed only the separator, so every module was emitted as the
        # literal text "{text}" and the bundle still passed `node --check`
        # (a bare identifier is valid syntax, it just throws at runtime). The
        # symbol-completeness check in main() exists because of that bug.
        parts.append(f"{separator}\n\n{text}")
    return "\n".join(parts), owners, collisions, total_module_bytes


def verify_completeness(source: str, owners: dict[str, str], total_module_bytes: int) -> None:
    """Assert the bundle really contains every module.

    `node --check` only proves the bundle parses. A flattener that drops module
    bodies (or truncates them) still parses, so parseability is not evidence that
    the userscript works. These two checks are: every declared top-level symbol
    must appear in the output, and the output must be at least as large as the
    sum of its modules.
    """
    missing = sorted(name for name in owners if name not in source)
    if missing:
        raise BuildError(
            "the bundle is missing %d top-level symbol(s) declared in src/: %s"
            % (len(missing), ", ".join(missing[:12]))
        )
    if len(source) < total_module_bytes:
        raise BuildError(
            f"the bundle ({len(source)} bytes) is smaller than its modules ({total_module_bytes} bytes)"
        )


def assemble(body: str) -> str:
    meta = read_meta()
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
    banner = (
        f"// built by tools/build.py from src/ - do not edit this file directly.\n"
        f"// source digest: {digest}  modules: {len(MODULES)}\n"
        f"// Rebuild with: python3 tools/build.py\n"
    )
    source = f"{meta}\n\n{banner}\n(function () {{\n  'use strict';\n\n{body}\n}})();\n"
    # The version placeholder is substituted everywhere, not just in the header,
    # so the runtime report and the metadata cannot disagree.
    source = source.replace("{{VERSION}}", read_version())
    # Only the all-caps placeholder form counts: JSDoc legitimately writes
    # `@returns {{a: string}}`, so a bare "{{" search would reject valid source.
    leftovers = re.findall(r"\{\{[A-Z_]+\}\}", source)
    if leftovers:
        raise BuildError("an unsubstituted placeholder survived the build: " + ", ".join(sorted(set(leftovers))))
    return source


def node_check(source: str) -> None:
    node = shutil.which("node")
    if not node:
        print("note: node not found, skipping syntax check", file=sys.stderr)
        return
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
        handle.write(source)
        temp_path = handle.name
    try:
        result = subprocess.run([node, "--check", temp_path], capture_output=True, text=True)
        if result.returncode != 0:
            raise BuildError("node --check failed:\n" + (result.stderr or result.stdout))
    finally:
        Path(temp_path).unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail (exit 2) if the committed dist is out of date")
    parser.add_argument("--stdout", action="store_true", help="print the bundle instead of writing it")
    args = parser.parse_args()

    body, owners, collisions, total_module_bytes = collect()
    if collisions:
        print("error: name collisions between modules (flattening would shadow them):", file=sys.stderr)
        for declared, where in collisions:
            print(f"  {declared}: {where}", file=sys.stderr)
        return 1

    source = assemble(body)
    verify_completeness(source, owners, total_module_bytes)
    node_check(source)

    if args.stdout:
        sys.stdout.write(source)
        return 0

    if args.check:
        existing = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if existing != source:
            print(f"error: {OUTPUT.relative_to(REPO)} is out of date. Run: python3 tools/build.py", file=sys.stderr)
            return 2
        print(f"ok: {OUTPUT.relative_to(REPO)} matches src/ ({len(source)} bytes, {len(owners)} top-level symbols)")
        return 0

    DIST.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(source, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(REPO)}: {len(source)} bytes, {len(source.splitlines())} lines, "
          f"{len(MODULES)} modules, {len(owners)} top-level symbols")
    return 0


if __name__ == "__main__":
    sys.exit(main())
