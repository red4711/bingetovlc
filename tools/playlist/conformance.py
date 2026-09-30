#!/usr/bin/env python3
"""Independent Python reference implementation of the bingetovlc handoff format.

This file exists to be a *second opinion*. The JavaScript in src/core/ and the
PowerShell handler in tools/windows/ are written by different people, in
different languages, running on different operating systems. If all three agree
on the same golden vectors, a whole class of bug ("the playlist played the wrong
episodes on someone else's machine") cannot ship unnoticed.

It is deliberately written from the format description in docs/SPEC.md rather
than translated from the JavaScript, and it uses only the standard library.

Usage:
    python3 tools/playlist/conformance.py --vectors tests/fixtures/vectors.json
    python3 tools/playlist/conformance.py --decode 'eyJ2IjoxLC...'      # inspect a URI payload
    python3 tools/playlist/conformance.py --from-uri 'vlc://open?d=...'
Exit codes: 0 all vectors agree, 1 a vector disagrees, 2 the input was unusable.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import sys
from pathlib import Path

PAYLOAD_VERSION = 1
URI_SAFE = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


class PayloadError(ValueError):
    pass


def b64url_decode(text: str) -> bytes:
    """Decode base64url, tolerating padding, the base64 alphabet and escapes."""
    cleaned = "".join(text.split())
    try:
        cleaned = cleaned.replace("+", "-").replace("/", "_")
        from urllib.parse import unquote

        cleaned = unquote(cleaned)
    except Exception:  # noqa: BLE001
        pass
    cleaned = cleaned.rstrip("=")
    invalid = sorted(set(cleaned) - URI_SAFE)
    if invalid:
        raise PayloadError(f"invalid base64url character(s): {''.join(invalid)}")
    padding = "=" * (-len(cleaned) % 4)
    if len(cleaned) % 4 == 1:
        # A base64 string can never have a length of 1 mod 4: this is the
        # signature of a payload that was cut off in transit.
        raise PayloadError("payload was truncated or corrupted in transit")
    try:
        return base64.urlsafe_b64decode(cleaned + padding)
    except (binascii.Error, ValueError) as error:
        raise PayloadError(f"not valid base64url: {error}") from error


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def decode_payload(text: str) -> dict:
    raw = b64url_decode(text)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PayloadError(f"payload is not valid UTF-8 JSON: {error}") from error
    validate(payload)
    return payload


def encode_payload(payload: dict) -> str:
    return b64url_encode(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def validate(payload: dict) -> None:
    if not isinstance(payload, dict):
        raise PayloadError("payload is not an object")
    if payload.get("v") != PAYLOAD_VERSION:
        raise PayloadError(f"unsupported payload version {payload.get('v')!r} (this build speaks {PAYLOAD_VERSION})")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise PayloadError("payload has no items")
    declared = payload.get("n")
    if declared is not None and declared != len(items):
        raise PayloadError(f"payload is incomplete: it declares {declared} items but contains {len(items)}")
    for index, item in enumerate(items):
        url = item.get("u") if isinstance(item, dict) else None
        if not isinstance(url, str) or "://" not in url:
            raise PayloadError(f"item {index} is not an absolute URL")
    return None


def one_line(text: object) -> str:
    return " ".join(str("" if text is None else text).replace("\t", " ").split())


def format_duration(seconds: object) -> str:
    if seconds is None:
        return "-1"
    try:
        value = float(seconds)
    except (TypeError, ValueError):
        return "-1"
    if value <= 0:
        return "-1"
    return str(int(round(value)))


def build_m3u(payload: dict, include_tokens: bool = True) -> str:
    opts = payload.get("opts") or {}
    lines = ["#EXTM3U"]
    if payload.get("title"):
        lines.append(f"#PLAYLIST:{one_line(payload['title'])}")
    for item in payload["items"]:
        url = item["u"]
        lines.append(f"#EXTINF:{format_duration(item.get('d'))},{one_line(item.get('t') or url)}")
        if opts.get("cache"):
            lines.append(f"#EXTVLCOPT:network-caching={int(round(float(opts['cache'])))}")
        if opts.get("referrer"):
            lines.append(f"#EXTVLCOPT:http-referrer={one_line(opts['referrer'])}")
        if opts.get("ua"):
            lines.append(f"#EXTVLCOPT:http-user-agent={one_line(opts['ua'])}")
        lines.append(url if include_tokens else url.split("?", 1)[0])
    return "\n".join(lines) + "\n"


def from_uri(uri: str) -> dict:
    """Accept vlc://open?d=…, bingetovlc://open?d=… and the manual url= form."""
    if "://" not in uri:
        raise PayloadError("not a URI: no scheme separator")
    scheme, rest = uri.split("://", 1)
    if scheme.lower() not in {"vlc", "bingetovlc"}:
        raise PayloadError(f"unexpected scheme {scheme!r}")
    rest = rest.split("#", 1)[0]
    if "?" not in rest:
        raise PayloadError("URI has no query string")
    query = rest.split("?", 1)[1]
    params: dict[str, str] = {}
    for pair in query.split("&"):
        if "=" in pair:
            key, value = pair.split("=", 1)
            params[key] = value
    if "d" in params:
        return decode_payload(params["d"])
    if "url" in params:
        from urllib.parse import unquote

        url = unquote(params["url"])
        payload = {"v": PAYLOAD_VERSION, "src": "manual", "server": "", "title": one_line(params.get("t") or url), "n": 1,
                   "items": [{"u": url}]}
        validate(payload)
        return payload
    raise PayloadError("URI has neither a d nor a url parameter")


def check_vectors(path: Path) -> int:
    document = json.loads(path.read_text(encoding="utf-8"))
    failures = 0
    for vector in document["vectors"]:
        name = vector["name"]
        problems: list[str] = []
        try:
            payload = decode_payload(vector["base64"])
        except PayloadError as error:
            problems.append(f"decode failed: {error}")
            payload = None
        if payload is not None:
            if payload != vector["payload"]:
                problems.append("decoded payload differs from the vector's payload")
            if encode_payload(payload) != vector["base64"]:
                problems.append(f"re-encoded base64 differs: {encode_payload(payload)[:40]}... != {vector['base64'][:40]}...")
            m3u = build_m3u(payload)
            if m3u != vector["m3u"]:
                problems.append("generated m3u differs from the vector")
                for got, want in zip(m3u.splitlines(), vector["m3u"].splitlines()):
                    if got != want:
                        problems.append(f"  first difference:\n    got  {got!r}\n    want {want!r}")
                        break
            shareable = build_m3u(payload, include_tokens=False)
            if shareable != vector["m3uShareable"]:
                problems.append("shareable m3u differs from the vector")
            if "api_key" in shareable:
                problems.append("shareable m3u leaked a token")
            try:
                round_trip = from_uri(vector["uri"])
                if round_trip != payload:
                    problems.append("URI round trip differs from the payload")
            except PayloadError as error:
                problems.append(f"URI parse failed: {error}")
        if problems:
            failures += 1
            print(f"FAIL {name}")
            for problem in problems:
                print(f"     {problem}")
        else:
            count = len(payload["items"])
            if count < 4:
                print(f"PASS {name} ({count} item{'s' if count != 1 else ''})")
            else:
                print(f"PASS {name} ({count} items)")
    total = len(document["vectors"])
    if failures:
        print(f"\n{failures} of {total} vectors disagree with the Python implementation")
        return 1
    print(f"\nall {total} vectors agree with the Python implementation")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vectors", type=Path, help="path to tests/fixtures/vectors.json")
    parser.add_argument("--decode", help="base64url payload to decode and print")
    parser.add_argument("--from-uri", dest="from_uri", help="full vlc:// URI to decode")
    parser.add_argument("--m3u", action="store_true", help="also print the M3U for --decode/--from-uri")
    args = parser.parse_args()

    if args.vectors:
        return check_vectors(args.vectors)
    if args.decode or args.from_uri:
        try:
            payload = from_uri(args.from_uri) if args.from_uri else decode_payload(args.decode)
        except PayloadError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        if args.m3u:
            print()
            print(build_m3u(payload))
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
