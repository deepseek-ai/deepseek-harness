#!/usr/bin/env python3
"""Compact a full SDK Session and continue with its retained context."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from deepseek_harness import DeepSeekHarness, RunResult


def display(result: RunResult) -> None:
    """Print the input's result and stop on a reported failure."""
    if result.finish_reason != "completed":
        raise RuntimeError(f"Input ended with {result.finish_reason}: {result.final_response}")
    print(result.final_response)


def main() -> None:
    """Create conversation history, compact it, and ask a follow-up question."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--session-id")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--max-tokens", type=int)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    readme = workspace / "README.md"
    if not readme.is_file():
        parser.error("--workspace must contain README.md to provide conversation history")

    with DeepSeekHarness(
        dsh_home=str(args.dsh_home.resolve()),
        cwd=str(workspace),
        profile="sdk",
        provider=args.provider,
        model=args.model,
        max_tokens=args.max_tokens,
    ) as harness:
        session = harness.start_session(args.session_id)
        display(session.run(
            "Read this project README and summarize its purpose and development commands without using tools.\n\n"
            + readme.read_text(encoding="utf-8")
        ))
        display(session.run("/compact"))
        display(session.run("What are the project's purpose and development commands? Use the earlier README without tools."))


if __name__ == "__main__":
    main()
