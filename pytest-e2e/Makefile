.PHONY: install protos test rest grpc collect clean

# Dependencies are managed with uv (https://docs.astral.sh/uv/).
# Plain pip works too: `python -m venv .venv && .venv/bin/pip install -e .`
install:
	uv sync

# Regenerate the python gRPC stubs from ../proto.
# Output lands in ./generated, which is gitignored on purpose.
protos:
	uv run python scripts/gen_protos.py --clean

test:
	uv run pytest

rest:
	uv run pytest -m rest

grpc: protos
	uv run pytest -m grpc

collect:
	uv run pytest --collect-only -q

clean:
	rm -rf generated .pytest_cache
