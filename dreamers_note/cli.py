from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import load_vault_config, validate_vault_config
from .runtime import initialize_runtime_dir


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Dreamers note framework CLI.")
    subparsers = parser.add_subparsers(dest="command")
    status = subparsers.add_parser("status", help="Report package config and runtime paths.")
    status.add_argument("--config", default=None, help="Path to vault config JSON.")
    status.add_argument("--runtime-dir", default=None, help="Override runtime directory.")
    status.add_argument(
        "--no-init-runtime",
        action="store_true",
        help="Report runtime path without creating runtime files.",
    )
    return parser


def run_status(args: argparse.Namespace) -> int:
    config = load_vault_config(
        Path(args.config) if args.config else None,
        runtime_dir=Path(args.runtime_dir) if args.runtime_dir else None,
    )
    initialized = False
    if not args.no_init_runtime:
        initialize_runtime_dir(config.runtime_dir)
        initialized = True

    validation = validate_vault_config(config)
    print("package: dreamers-note")
    print(f"vault_path: {config.vault_path}")
    print(f"runtime_dir: {config.runtime_dir}")
    print(f"runtime_initialized: {'yes' if initialized else 'no'}")
    if validation.ok:
        print("validation: ok")
        return 0
    print("validation: failed")
    for error in validation.errors:
        print(f"- {error.reason}: {error.message}", file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command in {None, "status"}:
        if args.command is None:
            args = parser.parse_args(["status", *(argv or [])])
        return run_status(args)
    parser.error(f"unknown command: {args.command}")
    return 2
