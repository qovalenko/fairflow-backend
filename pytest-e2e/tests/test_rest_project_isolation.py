"""The project boundary — the load-bearing invariant of the whole platform.

"Проект — единица изоляции. … `projectId` берётся из метадаты, а не из тела
запроса" (docs/04-domain-model.md §1). The boundary is defended twice:
at the gateway, which refuses a body that contradicts the authorized project,
and inside the domain, whose every query carries a `{projectId, …}` filter.
"""

from __future__ import annotations

import pytest

from fairflow_e2e.rest import GatewayClient, error_code
from conftest import unique

pytestmark = [pytest.mark.rest, pytest.mark.slow]


def test_a_body_project_id_that_contradicts_the_authorized_project_is_refused(
    admin: GatewayClient, project: str, project_without_orders: str
) -> None:
    """Authorize in project A, try to write into project B → 403.

    This is the cross-project write IDOR the platform is explicitly built
    against: the guards authorize on the project taken from the path/query/
    `X-Project-Id` header, so a `projectId` smuggled in the JSON body must never
    win (`CrmBffController.authoritativeProjectId` → 403 `PROJECT_ACCESS_DENIED`,
    marked SEC-ISO-1 in the source; docs/04-domain-model.md §1 "Защита границы").

    Note that the caller is a legitimate member of BOTH projects — the request is
    rejected on the mismatch itself, not on missing rights in the other project.
    """
    response = admin.post(
        "/deals",
        project_id=project,
        json={"name": unique("smuggled"), "projectId": project_without_orders},
    )

    assert response.status_code == 403, response.text
    assert error_code(response) == "PROJECT_ACCESS_DENIED", response.text


def test_a_record_of_another_project_is_invisible(
    admin: GatewayClient, project: str, project_without_orders: str, contact_in_project: dict
) -> None:
    """The same record id, read under a different project, does not exist.

    Isolation is implemented as "mandatory field + filter", not as a database
    per tenant: CRM documents carry a top-level `projectId` and every read is
    built as `{projectId, …}` (docs/04-domain-model.md §1). A miss is
    `NOT_FOUND`, which the gateway maps to 404 (docs/02-grpc-model.md §4) — the
    404 is deliberate, the API must not leak that the record exists elsewhere.

    Ported from the isolation half of
    `fairflow-frontend/e2e/tests/12-search-nav-isolation-p0.spec.ts`.
    """
    contact_id = contact_in_project["id"]

    in_own_project = admin.get(f"/contacts/{contact_id}", project_id=project)
    assert in_own_project.status_code == 200, in_own_project.text

    in_other_project = admin.get(f"/contacts/{contact_id}", project_id=project_without_orders)
    assert in_other_project.status_code == 404, in_other_project.text
    assert error_code(in_other_project) == "NOT_FOUND", in_other_project.text
