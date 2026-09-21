"""gRPC status → HTTP status, as seen from outside the system.

The table lives in docs/02-grpc-model.md §4 and is implemented once, in
`shared/src/grpc/grpc-to-http.ts`. What makes it worth an integration test is
that the *source* of each code is a domain service several hops away: the
domain raises an `RpcException`, the gateway unwraps it, and the client is
supposed to see a specific HTTP status and a stable semantic code.
"""

from __future__ import annotations

import pytest

from fairflow_e2e.rest import GatewayClient, error_code
from conftest import unique

pytestmark = [pytest.mark.rest, pytest.mark.slow]


def test_duplicate_creation_surfaces_as_409_already_exists(
    admin: GatewayClient, project: str
) -> None:
    """`ALREADY_EXISTS` → 409.

    Source of the code: `pipe.service.createDealSource` refuses a second source
    with the same name inside a project. The scenario also re-states the
    isolation rule in passing — uniqueness is scoped `{projectId, name}`.
    """
    name = unique("source")
    first = admin.post("/deal-sources", project_id=project, json={"name": name})
    assert first.status_code in (200, 201), first.text

    duplicate = admin.post("/deal-sources", project_id=project, json={"name": name})

    assert duplicate.status_code == 409, duplicate.text
    assert error_code(duplicate) == "ALREADY_EXISTS", duplicate.text


def test_an_illegal_state_transition_surfaces_as_422_failed_precondition(
    admin: GatewayClient, project: str, open_deal: dict
) -> None:
    """`FAILED_PRECONDITION` → 422.

    A deal moves through a configurable pipeline and closing it is a state
    transition, not a field update (docs/04-domain-model.md §2). Closing an
    already-closed deal is therefore a precondition failure, which must arrive
    as 422 — distinctly from a 400 (malformed request) or a 409 (conflict).

    Related UI flow: `fairflow-frontend/e2e/tests/09-deals-details-lifecycle.spec.ts`.
    """
    deal_id = open_deal["id"]

    closed = admin.post(f"/deals/{deal_id}/close", project_id=project, json={"result": "won"})
    assert closed.status_code in (200, 201), closed.text

    again = admin.post(f"/deals/{deal_id}/close", project_id=project, json={"result": "won"})

    assert again.status_code == 422, again.text
    assert error_code(again) == "FAILED_PRECONDITION", again.text


def test_a_malformed_payload_surfaces_as_400_invalid_argument(
    admin: GatewayClient, project: str
) -> None:
    """`INVALID_ARGUMENT` → 400.

    The domain validates independently of the gateway — "домен ОБЯЗАН проверить
    его повторно — gRPC зовут не только через gateway" is an explicit comment in
    the contracts. An empty name reaches `createDealSource` and comes back as
    `INVALID_ARGUMENT`.
    """
    response = admin.post("/deal-sources", project_id=project, json={"name": "   "})

    assert response.status_code == 400, response.text
    assert error_code(response) == "INVALID_ARGUMENT", response.text
