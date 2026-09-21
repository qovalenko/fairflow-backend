"""gRPC metadata the gateway puts on every outbound domain call.

The authoritative list of keys is
`../shared/src/grpc/metadata-keys.ts` (`GW_METADATA`) — it is
explicitly the single source of truth, so this module is a literal transcription
of the subset a domain actually validates.

Two separate checks run on the domain side
(`contact/src/auth-validation/gateway-api-key-validation.service.ts`):

1. `x-service-api-key` must be present and accepted by auth
   (`ApiKeyGrpc.ValidateServiceApiKey`) — otherwise `UNAUTHENTICATED`;
2. `validatePropagatedGatewayMetadata` (shared/src/grpc/inbound-metadata.ts)
   then requires `x-request-id`, a trace context (`traceparent` or
   `x-trace-id`), `x-gateway-issued-at`, and `x-user-id` when the actor is a
   user — otherwise `UNAUTHENTICATED` as well.
"""

from __future__ import annotations

import time
import uuid

# Transcribed from GW_METADATA — do not invent keys here.
REQUEST_ID = "x-request-id"
TRACE_ID = "x-trace-id"
USER_ID = "x-user-id"
ACTOR_TYPE = "x-actor-type"
PROJECT_ID = "x-project-id"
GATEWAY_ISSUED_AT = "x-gateway-issued-at"
GATEWAY_API_KEY_ID = "x-gateway-api-key-id"
SERVICE_API_KEY = "x-service-api-key"
CALL_ID = "x-gw-call-id"

Metadata = list[tuple[str, str]]


def gateway_metadata(
    *,
    service_api_key: str,
    gateway_api_key_id: str,
    user_id: str,
    project_id: str,
) -> Metadata:
    """A complete, well-formed gateway→domain metadata set."""
    return [
        (SERVICE_API_KEY, service_api_key),
        (GATEWAY_API_KEY_ID, gateway_api_key_id),
        (REQUEST_ID, str(uuid.uuid4())),
        (TRACE_ID, str(uuid.uuid4())),
        # `x-gw-call-id` is minted per call and can never be pinned by a client —
        # it is the dedup key of audit/outbox facts (metadata-keys.ts, CALL_ID).
        (CALL_ID, str(uuid.uuid4())),
        (GATEWAY_ISSUED_AT, str(int(time.time() * 1000))),
        (ACTOR_TYPE, "user"),
        (USER_ID, user_id),
        (PROJECT_ID, project_id),
    ]


def without(metadata: Metadata, *keys: str) -> Metadata:
    dropped = {k.lower() for k in keys}
    return [(k, v) for k, v in metadata if k.lower() not in dropped]


def replace(metadata: Metadata, key: str, value: str) -> Metadata:
    return [(k, value if k.lower() == key.lower() else v) for k, v in metadata]
