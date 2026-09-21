#!/usr/bin/env python3
"""Generate python gRPC stubs from the Fairflow `.proto` contracts.

The stubs are build output: they are NOT committed (see `.gitignore`) and must
be regenerated whenever the contracts move. Run `make protos` (or this script
directly) before `pytest -m grpc`.

Two include paths matter:

* the repository proto root (`FAIRFLOW_PROTO_DIR`, default
  `../proto`), so that `fairflow/<domain>/v1/<domain>.proto`
  resolves and the generated modules keep their package path
  (`fairflow.contact.v1.contact_pb2`) — sibling `.proto` files import each
  other by that same repo-relative path;
* the well-known types bundled with `grpcio-tools`, so imports of
  `google/protobuf/*.proto` (struct.proto is used by control/product/search)
  resolve without a system protoc installation.

By default only the contracts the suite actually calls are generated
(`fairflow/common/v1` + `fairflow/contact/v1`); `--all` generates everything
under the proto root.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

DEFAULT_TARGETS = ("fairflow/common/v1", "fairflow/contact/v1")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--proto-dir",
        default=os.environ.get("FAIRFLOW_PROTO_DIR", "../proto"),
        help="repository proto root (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        default="generated",
        help="output directory, added to pythonpath by pytest (default: %(default)s)",
    )
    parser.add_argument("--all", action="store_true", help="generate every contract, not just the used ones")
    parser.add_argument("--clean", action="store_true", help="wipe the output directory first")
    args = parser.parse_args()

    try:
        from grpc_tools import protoc
    except ImportError:
        print("grpcio-tools is not installed — run `uv sync` (or `pip install -e .`) first.", file=sys.stderr)
        return 2

    proto_root = Path(args.proto_dir).resolve()
    if not proto_root.is_dir():
        print(
            f"proto root not found: {proto_root}\n"
            "Point FAIRFLOW_PROTO_DIR at the backend repository's `proto/` directory.",
            file=sys.stderr,
        )
        return 2

    if args.all:
        sources = sorted(proto_root.rglob("*.proto"))
    else:
        sources = sorted(
            path
            for target in DEFAULT_TARGETS
            for path in (proto_root / target).glob("*.proto")
        )
    if not sources:
        print(f"no .proto files found under {proto_root}", file=sys.stderr)
        return 2

    out_dir = Path(args.out).resolve()
    if args.clean and out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    well_known = Path(protoc.__file__).parent / "_proto"

    command = [
        "protoc",
        f"--proto_path={proto_root}",
        f"--proto_path={well_known}",
        f"--python_out={out_dir}",
        f"--pyi_out={out_dir}",
        f"--grpc_python_out={out_dir}",
        *[str(path) for path in sources],
    ]
    code = protoc.main(command)
    if code != 0:
        print(f"protoc failed with exit code {code}", file=sys.stderr)
        return code

    # protoc emits plain directories; namespace packages make them importable,
    # but an explicit __init__.py keeps tooling (and older resolvers) happy.
    for directory in {path.parent for path in out_dir.rglob("*_pb2.py")}:
        while directory != out_dir:
            (directory / "__init__.py").touch()
            directory = directory.parent

    print(f"generated {len(sources)} contract(s) into {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
