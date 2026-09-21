"""Layer 2 of the authorization model: gateway → domain, over gRPC.

These tests deliberately skip the gateway and dial a domain service directly —
the position an attacker who reached the internal network would be in, and the
only way to observe the second layer at all. Everything asserted here comes
from `contact/src/auth-validation/gateway-api-key-validation.service.ts`,
`shared/src/grpc/inbound-metadata.ts` and docs/02-grpc-model.md §2–§3.

No `google.rpc` details are inspected: the contract is the gRPC status code.
"""

from __future__ import annotations

import pytest

from fairflow_e2e import grpc_meta

pytestmark = pytest.mark.grpc


def status_name(error) -> str:
    return error.code().name


@pytest.fixture
def valid_metadata(service_key: tuple[str, str], grpc_user_id: str, grpc_project_id: str):
    key, key_id = service_key
    return grpc_meta.gateway_metadata(
        service_api_key=key,
        gateway_api_key_id=key_id,
        user_id=grpc_user_id,
        project_id=grpc_project_id,
    )


CREDENTIAL_CASES = {
    "nothing": lambda jwt: [],
    "end-user-jwt-in-authorization": lambda jwt: [("authorization", f"Bearer {jwt}")],
    "end-user-jwt-as-service-key": lambda jwt: [(grpc_meta.SERVICE_API_KEY, jwt)],
}


@pytest.mark.parametrize("presented", list(CREDENTIAL_CASES))
def test_a_domain_refuses_anything_that_is_not_a_service_api_key(
    contact_stub, contact_pb2, end_user_jwt: str, grpc_project_id: str, presented: str
) -> None:
    """A domain accepts exactly one credential: the gateway's service API key.

    "Отсутствие ключа — сразу `UNAUTHENTICATED`, до всякой бизнес-логики", and
    the companion invariant "доменные сервисы не разбирают пользовательский
    JWT" (docs/02-grpc-model.md §3). The end-user token is not merely
    insufficient — it is never parsed, which is why presenting it produces the
    same `UNAUTHENTICATED` as presenting nothing.

    Backend counterpart: `contact/src/auth-validation/grpc-inbound-api-key.guard.spec.ts`
    (unit) and the `access` wave of `*.integration.spec.ts` (against a stand).
    """
    import grpc

    pb2, _ = contact_pb2
    request = pb2.ListContactsRequest(project_id=grpc_project_id, page_index=0, page_size=1)
    metadata = CREDENTIAL_CASES[presented](end_user_jwt)

    with pytest.raises(grpc.RpcError) as caught:
        contact_stub.ListContacts(request, metadata=metadata)

    assert status_name(caught.value) == "UNAUTHENTICATED", f"presented {presented}: {caught.value}"


@pytest.mark.parametrize(
    "missing",
    [grpc_meta.REQUEST_ID, grpc_meta.TRACE_ID, grpc_meta.GATEWAY_ISSUED_AT, grpc_meta.USER_ID],
)
def test_a_valid_key_is_not_enough_without_the_propagated_context(
    contact_stub, contact_pb2, valid_metadata, missing: str
) -> None:
    """The metadata contract is enforced, not merely documented.

    After the key check, `validatePropagatedGatewayMetadata` requires the full
    context the gateway is supposed to have resolved: `x-request-id`, a trace
    context, `x-gateway-issued-at`, and `x-user-id` whenever `x-actor-type` is
    `user` (shared/src/grpc/inbound-metadata.ts). Anything missing is
    `UNAUTHENTICATED` — a call that "almost" looks like it came from the
    gateway is rejected like one that did not.

    That is the practical reason `GW_METADATA` is declared to be the single
    source of truth for these keys (docs/02-grpc-model.md §2): a typo in a key
    name fails closed.
    """
    import grpc

    pb2, _ = contact_pb2
    request = pb2.ListContactsRequest(page_index=0, page_size=1)

    with pytest.raises(grpc.RpcError) as caught:
        contact_stub.ListContacts(request, metadata=grpc_meta.without(valid_metadata, missing))

    assert status_name(caught.value) == "UNAUTHENTICATED", f"dropped {missing}: {caught.value}"


def test_a_complete_gateway_call_is_accepted(contact_stub, contact_pb2, valid_metadata) -> None:
    """The positive control: the same request, with the full metadata set, works.

    The project scope travels ONLY in `x-project-id`; the request body carries
    no `project_id` at all, exactly as `resolveProjectId` expects of a
    gateway-originated call. An empty result set is a pass — the assertion is
    that the call was authorized and answered, not what the project contains.
    """
    pb2, _ = contact_pb2
    request = pb2.ListContactsRequest(page_index=0, page_size=1)

    response = contact_stub.ListContacts(request, metadata=valid_metadata)

    assert response.total >= 0
    assert len(response.list) <= 1


def test_a_body_project_id_contradicting_the_metadata_is_permission_denied(
    contact_stub, contact_pb2, valid_metadata
) -> None:
    """The domain-side half of the project boundary.

    `resolveProjectId` (shared/src/grpc/inbound-metadata.ts) treats the trusted
    `x-project-id` metadata as authoritative and rejects a request body that
    disagrees with `PERMISSION_DENIED` — "подменить границу изоляции через body
    нельзя" (docs/04-domain-model.md §1 "Защита границы").

    This is the same invariant `test_rest_project_isolation.py` asserts at the
    gateway, one layer down: the defence is intentionally duplicated, so
    reaching the internal network does not bypass it.
    """
    import grpc

    pb2, _ = contact_pb2
    # Any well-formed id works: the mismatch is rejected before the lookup.
    request = pb2.GetContactRequest(project_id="some-other-project", id="0" * 24)

    with pytest.raises(grpc.RpcError) as caught:
        contact_stub.GetContact(request, metadata=valid_metadata)

    assert status_name(caught.value) == "PERMISSION_DENIED", str(caught.value)
