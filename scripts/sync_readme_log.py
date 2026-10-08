#!/usr/bin/env python3
"""Regenerate README.md's stage line, dev-usage table and conversation appendix.

Reads local Claude Code session transcripts (*.jsonl) for this project. Exports only
human-typed user messages, harness notices and visible assistant text; tool inputs/outputs
are reduced to one-line markers and model reasoning blocks are skipped without being read.
Token usage comes from each API message's `usage` field, de-duplicated by message id.

Usage:
  python3 scripts/sync_readme_log.py --stage "Planning documents committed"
  python3 scripts/sync_readme_log.py --self-test
"""
import argparse
import collections
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKERS = ("stage", "dev-usage", "conversation")

REDACTIONS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED-PRIVATE-KEY]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "[REDACTED-GITHUB-TOKEN]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "[REDACTED-GITHUB-TOKEN]"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{10,}"), "[REDACTED-API-KEY]"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}"), "[REDACTED-API-KEY]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED-AWS-KEY]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "[REDACTED-SLACK-TOKEN]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "[REDACTED-JWT]"),
    (re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/\-]{16,}=*"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b(\w*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\w*)(\s*[:=]\s*)([\"']?)[^\s\"']{8,}\3"),
     r"\1\2\3[REDACTED]\3"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[REDACTED-EMAIL]"),
]
SYSTEM_REMINDER = re.compile(r"<system-reminder>[\s\S]*?</system-reminder>")


def redact(text: str) -> str:
    for pattern, repl in REDACTIONS:
        text = pattern.sub(repl, text)
    return text


def fence(text: str) -> str:
    # A fence longer than any backtick run inside keeps the message verbatim.
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}text\n{text}\n{ticks}"


def default_transcripts_dir() -> Path:
    return Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(ROOT))


def load_sessions(directory: Path):
    sessions = []
    for path in directory.glob("*.jsonl"):
        records = []
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        stamps = [r["timestamp"] for r in records if r.get("timestamp")]
        if stamps:
            sessions.append({"id": path.stem, "records": records, "start": min(stamps), "end": max(stamps)})
    return sorted(sessions, key=lambda s: s["start"])


def phase_for(phases, session_id, ts):
    best = None
    for p in phases:
        if p["session"] in (session_id, "*") and p["start"] <= ts and (best is None or p["start"] >= best["start"]):
            best = p
    return best["name"] if best else "Unassigned"


def user_text(record):
    content = record.get("message", {}).get("content")
    if isinstance(content, str):
        parts = [content]
    else:
        parts = [b.get("text", "") for b in content or [] if b.get("type") == "text"]
    return SYSTEM_REMINDER.sub("", "\n".join(parts)).strip()


def render_conversation(sessions):
    out = []
    for n, s in enumerate(sessions, 1):
        out.append(f"#### Session {n}: `{s['id'][:8]}` ({s['start'][:19]}Z → {s['end'][:19]}Z)\n")
        tools = collections.Counter()

        def flush_tools():
            if tools:
                summary = ", ".join(f"{name} ×{count}" for name, count in tools.items())
                out.append(f"_[tool activity omitted: {summary}]_\n")
                tools.clear()

        for r in s["records"]:
            kind = r.get("type")
            if kind == "user":
                text = user_text(r)
                if not text:
                    continue  # tool results and injected context only
                flush_tools()
                if r.get("origin", {}).get("kind") == "human":
                    label = "User"
                elif r.get("isMeta"):
                    label = "Harness notice"
                else:
                    label = "User (system-generated)"
                out.append(f"**{label}** · {r.get('timestamp', '')[:19]}Z\n\n{fence(redact(text))}\n")
            elif kind == "assistant":
                message = r.get("message", {})
                for block in message.get("content") or []:
                    btype = block.get("type")
                    if btype == "tool_use":
                        tools[block.get("name", "tool")] += 1
                    elif btype == "text" and block.get("text", "").strip():
                        flush_tools()
                        label = "Assistant" if message.get("model") != "<synthetic>" else "Assistant (system-generated)"
                        out.append(f"**{label}** · {r.get('timestamp', '')[:19]}Z\n\n{fence(redact(block['text'].strip()))}\n")
                    # thinking / redacted_thinking blocks are intentionally skipped
        flush_tools()
    return "\n".join(out)


def collect_usage(sessions, phases):
    seen = set()
    rows = collections.OrderedDict()
    for s in sessions:
        for r in s["records"]:
            message = r.get("message") or {}
            if r.get("type") != "assistant" or message.get("model") in (None, "<synthetic>"):
                continue
            mid = message.get("id") or r.get("requestId")
            usage = message.get("usage")
            if not usage or mid in seen:
                continue
            seen.add(mid)
            key = (phase_for(phases, s["id"], r["timestamp"]), message["model"])
            row = rows.setdefault(key, collections.Counter())
            row["calls"] += 1
            row["input"] += usage.get("input_tokens", 0)
            row["cache_write"] += usage.get("cache_creation_input_tokens", 0)
            row["cache_read"] += usage.get("cache_read_input_tokens", 0)
            row["output"] += usage.get("output_tokens", 0)
    return rows


def render_usage(rows):
    head = ("| Phase | Model | API calls | Input (uncached) | Cache write | Cache read | Output |\n"
            "| --- | --- | ---: | ---: | ---: | ---: | ---: |")
    lines = [head]
    totals = collections.defaultdict(collections.Counter)
    for (phase, model), c in rows.items():
        lines.append(f"| {phase} | `{model}` | {c['calls']:,} | {c['input']:,} | {c['cache_write']:,} | "
                     f"{c['cache_read']:,} | {c['output']:,} |")
        totals[model].update(c)
    for model, c in totals.items():
        lines.append(f"| **Total** | `{model}` | **{c['calls']:,}** | **{c['input']:,}** | **{c['cache_write']:,}** | "
                     f"**{c['cache_read']:,}** | **{c['output']:,}** |")
    lines.append("| All phases | WebFetch page-summarizer model | unavailable | unavailable | unavailable | unavailable | unavailable |")
    lines.append("| All phases | Safety classifier passes | unavailable | unavailable | unavailable | unavailable | unavailable |")
    return "\n".join(lines)


def replace_block(text, name, body):
    pattern = re.compile(rf"(<!-- {name}:start -->\n)[\s\S]*?(\n<!-- {name}:end -->)")
    if not pattern.search(text):
        sys.exit(f"README is missing the <!-- {name}:start/end --> markers")
    return pattern.sub(lambda m: m.group(1) + body + m.group(2), text)


def self_test():
    assert redact("token gho_" + "a" * 36) == "token [REDACTED-GITHUB-TOKEN]"
    assert redact("SESSION_SECRET=abcdefgh123") == "SESSION_SECRET=[REDACTED]"
    assert redact("Authorization: Bearer abcdefghijklmnop1234") == "Authorization: Bearer [REDACTED]"
    assert redact("mail me@example.com") == "mail [REDACTED-EMAIL]"
    assert redact("plain words stay") == "plain words stay"
    assert fence("a ```b``` c").startswith("````text")
    phases = [{"name": "A", "session": "s1", "start": "2026-01-01T00:00:00Z"},
              {"name": "B", "session": "s1", "start": "2026-01-02T00:00:00Z"},
              {"name": "W", "session": "*", "start": "2026-01-03T00:00:00Z"}]
    assert phase_for(phases, "s1", "2026-01-01T12:00:00Z") == "A"
    assert phase_for(phases, "s1", "2026-01-02T12:00:00Z") == "B"
    assert phase_for(phases, "s2", "2026-01-04T00:00:00Z") == "W"
    assert phase_for(phases, "s2", "2026-01-01T00:00:00Z") == "Unassigned"
    dup = {"type": "assistant", "timestamp": "2026-01-01T01:00:00Z",
           "message": {"id": "m1", "model": "x", "usage": {"input_tokens": 1, "output_tokens": 2}}}
    rows = collect_usage([{"id": "s1", "records": [dup, dup]}], phases)
    assert rows[("A", "x")]["calls"] == 1 and rows[("A", "x")]["output"] == 2
    print("self-test passed")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--transcripts-dir", type=Path, default=default_transcripts_dir())
    ap.add_argument("--readme", type=Path, default=ROOT / "README.md")
    ap.add_argument("--phases", type=Path, default=ROOT / "docs" / "dev-phases.json")
    ap.add_argument("--stage", help="Short description of the latest captured stage")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if not args.transcripts_dir.is_dir():
        sys.exit(f"Transcript directory not found: {args.transcripts_dir} (dev usage stays 'unavailable')")

    sessions = load_sessions(args.transcripts_dir)
    phases = json.loads(args.phases.read_text())["phases"]
    readme = args.readme.read_text(encoding="utf-8")
    last = max(s["end"] for s in sessions)[:19] + "Z"
    if args.stage:
        readme = replace_block(readme, "stage", f"**Latest captured stage:** {args.stage} (transcripts captured up to {last}).")
    readme = replace_block(readme, "dev-usage", render_usage(collect_usage(sessions, phases)))
    readme = replace_block(readme, "conversation", render_conversation(sessions))
    args.readme.write_text(readme, encoding="utf-8")
    print(f"Updated {args.readme.relative_to(ROOT)} from {len(sessions)} session(s), last record {last}")


if __name__ == "__main__":
    main()
