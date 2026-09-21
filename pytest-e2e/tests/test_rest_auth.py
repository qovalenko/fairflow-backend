"""Layer 1 of the authorization model: client → gateway, `Authorization: Bearer`."""

from __future__ import annotations

import pytest

from fairflow_e2e.rest import GatewayClient, error_code

pytestmark = pytest.mark.rest


def test_login_issues_a_jwt_that_authorizes_subsequent_requests(admin: GatewayClient) -> None:
    """The gateway mints a JWT on login and accepts it as the caller's identity.

    Invariant: the gateway is the only public entrypoint and the only place the
    end-user token is verified — `JWT_SECRET` must match the one auth signed
    with (docs/02-grpc-model.md §3 "Слой 1").

    Ported from `fairflow-frontend/e2e/tests/01-login.spec.ts` (#21 "успешный
    вход email+password → JWT"), reduced to the transport it really exercises:
    `POST /api/v1/auth/login` → token → `GET /api/v1/auth/me`.
    """
    response = admin.get("/auth/me")

    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["userId"] == admin.user_id, "the token must resolve to the account that logged in"


CREDENTIAL_CASES = {
    "no-authorization-header": {},
    "token-that-is-not-a-jwt": {"Authorization": "Bearer not-a-real-token"},
}


@pytest.mark.parametrize("presented", list(CREDENTIAL_CASES))
def test_a_request_without_a_valid_token_is_401(
    anonymous: GatewayClient, presented: str
) -> None:
    """A protected route answers 401, and with the documented error envelope.

    Invariant: `UNAUTHENTICATED` maps to HTTP 401 (docs/02-grpc-model.md §4,
    table implemented in `shared/src/grpc/grpc-to-http.ts`), and every error is
    wrapped by `AppErrorFilter` into `{code, message, details, requestId,
    error:{…}}`.

    Ported from `fairflow-frontend/e2e/tests/06-auth-negative.spec.ts` (#22 —
    the UI assertion "неверные credentials → Alert danger" is here reduced to
    the HTTP contract underneath it).
    """
    response = anonymous.get("/auth/me", headers=CREDENTIAL_CASES[presented], anonymous=True)

    assert response.status_code == 401, (
        f"presented {presented}: expected 401, got {response.status_code} {response.text[:200]}"
    )
    assert error_code(response) == "UNAUTHENTICATED", response.text
    assert "requestId" in response.json(), "every error envelope carries the correlation id"
