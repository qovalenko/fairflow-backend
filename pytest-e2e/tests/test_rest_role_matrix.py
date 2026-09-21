"""The project role model, asked of the production policy decision point.

Roles are checked through `POST /api/v1/projects/:projectId/access/simulate`,
which runs the SAME resolver as enforcement (RBAC → ABAC → visibility →
sharing) and returns the layered trace — see `PdpService.simulateExplain`
(control) and docs/03-access-model.md §6. That is what makes these tests
integration tests rather than a restatement of `shared/src/rbac.ts`: the
decision comes from the deployed catalog of the real project.
"""

from __future__ import annotations

from typing import Callable

import pytest

from fairflow_e2e.rest import GatewayClient

pytestmark = [pytest.mark.rest, pytest.mark.rbac, pytest.mark.slow]


def decide(admin: GatewayClient, project_id: str, user_id: str, subject: str, action: str) -> dict:
    response = admin.post(
        f"/projects/{project_id}/access/simulate",
        project_id=project_id,
        json={"userId": user_id, "subject": subject, "action": action},
    )
    assert response.status_code == 200, f"simulate({subject}:{action}) -> {response.status_code} {response.text[:200]}"
    return response.json()


def assert_decision(result: dict, expected: str, key: str) -> None:
    assert result.get("decision") == expected, (
        f"{key}: expected {expected}, got {result.get('decision')} "
        f"(reason={result.get('reason')}, role={result.get('role')})"
    )


def test_viewer_may_read_and_nothing_else(
    admin: GatewayClient, project_with_member: Callable[[str], str], second_user_id: str
) -> None:
    """`viewer` holds exactly one verb: `read` (docs/03-access-model.md §3.2).

    The matrix is flat — a role owns a set of the ten closed verbs, applied to
    every subject in the project catalog. So one probe per verb is enough to
    pin the whole row, and `write` is the interesting one: `create` and
    `update` are normalised into `write` on the way in, which means "cannot
    create" and "cannot edit" are literally the same decision (§1).
    """
    project_id = project_with_member("viewer")

    assert_decision(decide(admin, project_id, second_user_id, "contacts", "read"), "allow", "contacts:read")
    assert_decision(decide(admin, project_id, second_user_id, "contacts", "write"), "deny", "contacts:write")
    assert_decision(decide(admin, project_id, second_user_id, "contacts", "delete"), "deny", "contacts:delete")


def test_member_may_generate_documents_without_gaining_execute_everywhere(
    admin: GatewayClient, project_with_member: Callable[[str], str], second_user_id: str
) -> None:
    """The granular allow-list on top of the flat matrix — the most interesting
    rule in the access model (docs/03-access-model.md §4).

    `member`'s verb set is `read, write, move, export`. A product decision
    (owner, 2026-08-16) says a member must nevertheless be able to issue
    documents. Putting `execute` into the role would have silently widened
    EVERY `*:execute` key in the catalog — automations included. Instead a named
    key list (`PROJECT_ROLE_KEY_ALLOWLIST`) grants exactly
    `documents.generate:execute` and nothing else; it can only add, never
    subtract.

    The three probes below are the actual shape of that rule:

    * `documents.generate:execute` → allow — granted by name;
    * `documents:delete`           → deny  — `delete` is not a member verb, and
      the allow-list did not widen the `documents` subject as a whole;
    * `contacts:import`            → deny  — `import` is deliberately NOT a
      synonym of `write` (§1): mass mutation is manager+ only.

    The corresponding UI gate (the same catalog key, `documents.generate:execute`)
    is exercised by `fairflow-frontend/e2e/tests/12-documents-tab-generate.spec.ts`
    and `23-documents-settings-perms.spec.ts`.
    """
    project_id = project_with_member("member")

    assert_decision(
        decide(admin, project_id, second_user_id, "documents.generate", "execute"),
        "allow",
        "documents.generate:execute",
    )
    assert_decision(
        decide(admin, project_id, second_user_id, "documents", "delete"), "deny", "documents:delete"
    )
    assert_decision(
        decide(admin, project_id, second_user_id, "contacts", "import"), "deny", "contacts:import"
    )
