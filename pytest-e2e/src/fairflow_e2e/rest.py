"""Thin REST client over the gateway.

Mirrors what the frontend actually sends (see
`fairflow-frontend/e2e/fixtures/api.ts`): `Authorization: Bearer <JWT>` for the
user, and the project scope as BOTH the `X-Project-Id` header and a
`?projectId=` query parameter — different BFF handlers read different sources,
and the body is never an authoritative source of the project.
"""

from __future__ import annotations

from typing import Any, Mapping

import httpx


class GatewayError(RuntimeError):
    def __init__(self, response: httpx.Response) -> None:
        super().__init__(f"{response.request.method} {response.request.url} -> "
                         f"{response.status_code} {response.text[:500]}")
        self.response = response


def error_code(response: httpx.Response) -> str:
    """Semantic error code from the gateway error envelope.

    `AppErrorFilter` (gateway/src/common/app-error.filter.ts) emits both a flat
    `code` and a nested `error.code`; guards set explicit codes such as
    `MODULE_DISABLED`, `PROJECT_ACCESS_DENIED`, `PERMISSION_DENIED`.
    """
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    nested = body.get("error")
    if isinstance(nested, dict) and isinstance(nested.get("code"), str):
        return nested["code"]
    return body["code"] if isinstance(body.get("code"), str) else ""


class GatewayClient:
    """Authenticated (or anonymous) caller of `/api/v1/...`."""

    def __init__(self, base: str, http: httpx.Client, token: str = "", user_id: str = "") -> None:
        self._base = base
        self._http = http
        self.token = token
        self.user_id = user_id

    def headers(self, project_id: str | None = None, *, anonymous: bool = False) -> dict[str, str]:
        head: dict[str, str] = {}
        if self.token and not anonymous:
            head["Authorization"] = f"Bearer {self.token}"
        if project_id:
            head["X-Project-Id"] = project_id
        return head

    def request(
        self,
        method: str,
        path: str,
        *,
        project_id: str | None = None,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        headers: Mapping[str, str] | None = None,
        anonymous: bool = False,
    ) -> httpx.Response:
        query: dict[str, Any] = dict(params or {})
        if project_id:
            query.setdefault("projectId", project_id)
        merged = self.headers(project_id, anonymous=anonymous)
        merged.update(headers or {})
        return self._http.request(
            method,
            f"{self._base}{path}",
            params=query or None,
            json=json,
            headers=merged,
        )

    def get(self, path: str, **kw: Any) -> httpx.Response:
        return self.request("GET", path, **kw)

    def post(self, path: str, **kw: Any) -> httpx.Response:
        return self.request("POST", path, **kw)

    def patch(self, path: str, **kw: Any) -> httpx.Response:
        return self.request("PATCH", path, **kw)

    def delete(self, path: str, **kw: Any) -> httpx.Response:
        return self.request("DELETE", path, **kw)

    def json_ok(self, method: str, path: str, **kw: Any) -> Any:
        """Call and require 2xx — for fixture setup, never for assertions."""
        response = self.request(method, path, **kw)
        if response.status_code >= 400:
            raise GatewayError(response)
        return response.json()
