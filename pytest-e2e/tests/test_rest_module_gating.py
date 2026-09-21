"""Module gating — the check that runs before anything about roles."""

from __future__ import annotations

import pytest

from fairflow_e2e.rest import GatewayClient, error_code

pytestmark = [pytest.mark.rest, pytest.mark.slow]


def test_a_route_of_a_disabled_module_is_refused_even_for_the_project_owner(
    admin: GatewayClient, project: str, project_without_orders: str
) -> None:
    """Same route, same caller, two projects: enabled → 200, disabled → 403.

    Two invariants at once:

    * the set of modules is a property of the PROJECT, not of the instance
      (docs/01-architecture.md §3) — which is why the identical request differs
      only by the project it is scoped to;
    * "обращение к маршруту выключенного модуля отвергается с 403
      MODULE_DISABLED **до всякой проверки ролей**"
      (docs/01-architecture.md §3, docs/03-access-model.md §6 step 1).
      The caller here is the project owner and holds every permission there is,
      so a 403 can only come from the module gate — `GatewayModuleGuard` is
      listed before `ProjectAccessGuard` in `@UseGuards(...)` on the CRM BFF.

    Ported from `fairflow-frontend/e2e/tests/10-module-disable.spec.ts` (#87)
    and `18-products-module-guard.spec.ts` (#2), which assert the UI's
    ModuleDisabledState; this is the HTTP answer those screens render.
    """
    enabled = admin.get("/orders", project_id=project, params={"pageIndex": 0, "pageSize": 1})
    assert enabled.status_code == 200, (
        f"`orders` is enabled in this project, expected 200: {enabled.text[:200]}"
    )

    disabled = admin.get(
        "/orders", project_id=project_without_orders, params={"pageIndex": 0, "pageSize": 1}
    )
    assert disabled.status_code == 403, disabled.text
    assert error_code(disabled) == "MODULE_DISABLED", disabled.text
    assert "orders" in disabled.json()["message"], "the message must name the module that is off"
