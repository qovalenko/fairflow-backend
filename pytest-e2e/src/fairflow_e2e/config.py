"""Environment-driven configuration.

Every setting comes from an environment variable. Only addresses get a default
(and only a localhost one); anything that is a credential has no default at all
— a missing credential makes the affected tests SKIP with an explicit reason
rather than fail or, worse, silently run against the wrong stand.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


@dataclass(frozen=True)
class Settings:
    # REST — the gateway is the only public entrypoint (docs/01-architecture.md §1).
    gateway_url: str
    admin_email: str
    admin_password: str

    # gRPC — a domain service addressed directly (docs/02-grpc-model.md §1).
    contact_grpc: str
    service_api_key: str
    gateway_api_key_id: str

    proto_dir: Path
    http_timeout: float

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            gateway_url=_env("FAIRFLOW_GATEWAY_URL", "http://localhost:3000").rstrip("/"),
            admin_email=_env("FAIRFLOW_ADMIN_EMAIL"),
            admin_password=_env("FAIRFLOW_ADMIN_PASSWORD"),
            contact_grpc=_env("FAIRFLOW_CONTACT_GRPC", "localhost:5003"),
            service_api_key=_env("FAIRFLOW_SERVICE_API_KEY"),
            gateway_api_key_id=_env("FAIRFLOW_GATEWAY_API_KEY_ID"),
            proto_dir=Path(_env("FAIRFLOW_PROTO_DIR", "../proto")),
            http_timeout=float(_env("FAIRFLOW_HTTP_TIMEOUT", "30")),
        )

    @property
    def api_base(self) -> str:
        """URL prefix of the versioned REST surface.

        The gateway does `setGlobalPrefix('api')` + URI versioning with
        `defaultVersion: '1'` (gateway/src/application.ts), so every BFF route
        lives under `/api/v1`.
        """
        return f"{self.gateway_url}/api/v1"

    @property
    def has_admin_credentials(self) -> bool:
        return bool(self.admin_email and self.admin_password)

    @property
    def has_service_key(self) -> bool:
        return bool(self.service_api_key and self.gateway_api_key_id)


def load_dotenv(path: Path) -> None:
    """Minimal `.env` loader — no dependency, never overrides a real env var."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())
