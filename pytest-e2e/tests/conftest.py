"""Shared fixtures.

Design rule for this suite: **a missing stand or a missing credential is a SKIP,
never an error**. Collection must succeed on a laptop with nothing running, so
nothing at import time touches the network or the generated protobuf stubs.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Callable, Iterator

import httpx
import pytest

from fairflow_e2e.config import Settings, load_dotenv
from fairflow_e2e.rest import GatewayClient, GatewayError

REPO_ROOT = Path(__file__).resolve().parent.parent


def unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


# ── configuration / transport ────────────────────────────────────────────────


@pytest.fixture(scope="session")
def settings() -> Settings:
    load_dotenv(REPO_ROOT / ".env")
    return Settings.from_env()


@pytest.fixture(scope="session")
def http(settings: Settings) -> Iterator[httpx.Client]:
    with httpx.Client(timeout=settings.http_timeout, follow_redirects=False) as client:
        yield client


@pytest.fixture(scope="session")
def gateway_up(settings: Settings, http: httpx.Client) -> None:
    """Probe the gateway's ops contract before running any REST scenario.

    `GET /healthz` is one of the four operational routes every Fairflow service
    exposes over HTTP (docs/01-architecture.md §1, `ops-http-contract`); on the
    gateway it is excluded from the `/api` prefix.
    """
    try:
        response = http.get(f"{settings.gateway_url}/healthz")
    except httpx.HTTPError as exc:
        pytest.skip(f"gateway unreachable at {settings.gateway_url} ({exc.__class__.__name__}); "
                    "set FAIRFLOW_GATEWAY_URL or start the stand")
    if response.status_code != 200:
        pytest.skip(f"gateway /healthz answered {response.status_code}, stand is not ready")


@pytest.fixture(scope="session")
def anonymous(settings: Settings, http: httpx.Client, gateway_up: None) -> GatewayClient:
    """Unauthenticated caller — used for the 401 scenarios."""
    return GatewayClient(settings.api_base, http)


@pytest.fixture(scope="session")
def admin(settings: Settings, http: httpx.Client, gateway_up: None) -> GatewayClient:
    """Logged-in project owner.

    `POST /api/v1/auth/login` answers `{token, user:{userId,…}}`. Self
    registration is permanently disabled on this edition
    (`AuthController.register` → 403 `REGISTRATION_DISABLED`), so the suite
    cannot provision its own account: without credentials it SKIPs.
    """
    if not settings.has_admin_credentials:
        pytest.skip("FAIRFLOW_ADMIN_EMAIL / FAIRFLOW_ADMIN_PASSWORD are not set")
    client = GatewayClient(settings.api_base, http)
    response = client.post(
        "/auth/login",
        json={"email": settings.admin_email, "password": settings.admin_password},
    )
    if response.status_code != 200:
        pytest.skip(f"login failed: {response.status_code} {response.text[:200]}")
    body = response.json()
    if body.get("mfaRequired"):
        pytest.skip("the configured account requires a second factor; use an account without 2FA")
    token = body.get("token")
    user_id = (body.get("user") or {}).get("userId")
    if not token or not user_id:
        pytest.skip(f"login response carried no token/userId: {response.text[:200]}")
    client.token = token
    client.user_id = user_id
    return client


# ── stand data ───────────────────────────────────────────────────────────────


ProjectFactory = Callable[..., str]


@pytest.fixture(scope="session")
def make_project(admin: GatewayClient) -> Iterator[ProjectFactory]:
    """Create throwaway projects and archive them afterwards.

    The project is the unit of isolation (docs/04-domain-model.md §1), so every
    scenario that writes data gets its own — nothing leaks between tests.
    `modules` is the per-project module set; locked modules (`deals`,
    `statistics`, `profile`, `notifications`) are added by the server.
    """
    created: list[str] = []

    def _make(name: str, modules: list[str]) -> str:
        body = admin.json_ok(
            "POST",
            "/projects",
            json={"name": unique(name), "templateId": "blank", "modules": modules},
        )
        project_id = body.get("id")
        if not project_id:
            pytest.skip(f"project creation returned no id: {body}")
        created.append(project_id)
        return project_id

    yield _make

    for project_id in created:
        admin.delete(f"/projects/{project_id}")


@pytest.fixture(scope="session")
def project(make_project: ProjectFactory) -> str:
    """A project with the modules the CRM scenarios need switched on."""
    return make_project("e2e-crm", ["contacts", "deals", "documents", "orders"])


@pytest.fixture(scope="session")
def project_without_orders(make_project: ProjectFactory) -> str:
    """Same tenant shape, but the `orders` module is deliberately OFF."""
    return make_project("e2e-no-orders", ["contacts", "deals"])


@pytest.fixture(scope="session")
def second_user_id(admin: GatewayClient) -> str:
    """Some user on the stand who is not the admin.

    Needed by the role-matrix scenarios: roles are assigned to real project
    members, and registration is closed, so the suite can only borrow an account
    that already exists. `GET /api/v1/users` is gated on the *system* manage
    role — a different axis from project roles (docs/03-access-model.md §3.3).
    """
    response = admin.get("/users", params={"skip": 0, "take": 50})
    if response.status_code != 200:
        pytest.skip(f"cannot list users ({response.status_code}); the account lacks system manage rights")
    users = response.json().get("list") or []
    for user in users:
        if user.get("id") and user["id"] != admin.user_id:
            return str(user["id"])
    pytest.skip("the stand has only one user account; role-matrix scenarios need a second one")


MemberProject = Callable[[str], str]


@pytest.fixture(scope="session")
def project_with_member(
    admin: GatewayClient,
    make_project: ProjectFactory,
    second_user_id: str,
) -> MemberProject:
    """Return a project where `second_user_id` holds the requested project role.

    One project per role so the roles never interfere. Module set matters: the
    permission catalog is *derived* from the enabled modules
    (docs/01-architecture.md §3), so `documents.generate:execute` only exists
    here because `documents` is on.
    """
    cache: dict[str, str] = {}

    def _for_role(role: str) -> str:
        if role in cache:
            return cache[role]
        project_id = make_project(f"e2e-role-{role}", ["contacts", "deals", "documents"])
        response = admin.post(
            f"/projects/{project_id}/members",
            project_id=project_id,
            json={"userId": second_user_id, "role": role},
        )
        if response.status_code >= 400:
            pytest.skip(f"cannot add a {role} to the project: {response.status_code} {response.text[:200]}")
        cache[role] = project_id
        return project_id

    return _for_role


@pytest.fixture
def contact_in_project(admin: GatewayClient, project: str) -> dict:
    """A contact that exists in `project` and nowhere else."""
    try:
        return admin.json_ok(
            "POST",
            "/contacts",
            project_id=project,
            json={"firstName": unique("Iso"), "lastName": "Test"},
        )
    except GatewayError as exc:
        pytest.skip(f"cannot seed a contact: {exc}")


@pytest.fixture
def open_deal(admin: GatewayClient, project: str) -> dict:
    """A freshly created, still-open deal in `project`."""
    try:
        return admin.json_ok(
            "POST",
            "/deals",
            project_id=project,
            json={"name": unique("deal")},
        )
    except GatewayError as exc:
        pytest.skip(f"cannot seed a deal: {exc}")


# ── gRPC ─────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def contact_pb2() -> tuple:
    """Import the generated stubs, or SKIP with the command that creates them."""
    try:
        from fairflow.contact.v1 import contact_pb2, contact_pb2_grpc  # type: ignore
    except ImportError:
        pytest.skip("protobuf stubs are missing — run `make protos` (scripts/gen_protos.py)")
    return contact_pb2, contact_pb2_grpc


@pytest.fixture(scope="session")
def contact_stub(settings: Settings, contact_pb2: tuple):
    """`ContactGrpc` stub pointed straight at the domain, bypassing the gateway.

    Plaintext on purpose: inside the cluster there is no TLS between services
    (docs/02-grpc-model.md §1).
    """
    import grpc

    _, contact_pb2_grpc = contact_pb2
    channel = grpc.insecure_channel(settings.contact_grpc)
    try:
        grpc.channel_ready_future(channel).result(timeout=5)
    except grpc.FutureTimeoutError:
        channel.close()
        pytest.skip(f"contact domain unreachable at {settings.contact_grpc}; set FAIRFLOW_CONTACT_GRPC")
    stub = contact_pb2_grpc.ContactGrpcStub(channel)
    yield stub
    channel.close()


@pytest.fixture(scope="session")
def service_key(settings: Settings) -> tuple[str, str]:
    if not settings.has_service_key:
        pytest.skip("FAIRFLOW_SERVICE_API_KEY / FAIRFLOW_GATEWAY_API_KEY_ID are not set")
    return settings.service_api_key, settings.gateway_api_key_id


@pytest.fixture(scope="session")
def grpc_project_id(settings: Settings) -> str:
    """Project scope for the direct gRPC calls.

    Deliberately NOT the REST fixture: the gRPC scenarios must be runnable
    against a domain alone, without a gateway or an admin account. A random id
    is enough — every assertion here is about the authorization layer, which
    rejects (or accepts) the call before any lookup happens.
    """
    return f"e2e-{uuid.uuid4().hex[:12]}"


@pytest.fixture(scope="session")
def grpc_user_id() -> str:
    return f"e2e-user-{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="session")
def end_user_jwt(settings: Settings, http: httpx.Client) -> str:
    """An end-user access token, used to prove a domain will NOT accept one.

    A real JWT when credentials are configured; otherwise a structurally valid
    but unsigned stand-in — which is the point of the assertion: the domain is
    supposed to ignore user tokens entirely rather than verify them
    (docs/02-grpc-model.md §3, "доменные сервисы не разбирают пользовательский JWT").
    """
    if settings.has_admin_credentials:
        try:
            response = http.post(
                f"{settings.api_base}/auth/login",
                json={"email": settings.admin_email, "password": settings.admin_password},
            )
            token = response.json().get("token") if response.status_code == 200 else None
            if token:
                return str(token)
        except httpx.HTTPError:
            pass
    header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    payload = "eyJzdWIiOiJlMmUtdXNlciIsImlhdCI6MH0"
    return f"{header}.{payload}.not-a-real-signature"
