# fairflow-pytest-e2e

Integration tests for the **Fairflow CRM** platform, written in Python/pytest.

Fairflow is a project-centric modular CRM: a NestJS gateway is the single public
entrypoint (REST over HTTP), and every domain service behind it speaks **only**
gRPC. This suite is a small, deliberately opinionated sample — it does not try
to cover the product. It picks the handful of architectural invariants that are
genuinely interesting to verify from the outside, and verifies each one exactly
once.

The selection principle: **no CRUD for the sake of CRUD.** A test earns its
place only if it would catch a real architectural regression — a boundary that
stopped being enforced, a check that started running in the wrong order, an
error that stopped carrying its meaning across a process hop.

---

## What it covers

### The project boundary (the one invariant everything else rests on)

A project is the unit of data isolation. The trusted project id travels as
`x-project-id` gRPC metadata; a `projectId` in a request body is *untrusted
input*. Both halves of that defence are tested: the gateway refuses a body that
contradicts the authorized project (403 `PROJECT_ACCESS_DENIED`), and the domain
refuses it again one layer down (`PERMISSION_DENIED`). The duplication is on
purpose — reaching the internal network must not bypass the boundary.

### Two layers of authorization

1. **client → gateway** — `Authorization: Bearer <JWT>`, verified at the edge;
2. **gateway → domain** — a service API key in gRPC metadata.

A domain never parses an end-user token. The suite proves this from the
attacker's position: it dials the `contact` service directly and shows that a
real end-user JWT is worth exactly as much as no credential at all.

### Ordering of the route checks

Module gate → membership/role → permission key → record visibility. A route of a
module that is switched off for the project answers `403 MODULE_DISABLED` **even
to the project owner** — which is only observable if the module gate really does
run before the role check.

### The granular allow-list over the flat role matrix

The most interesting rule in the access model. `member` owns the verbs
`read, write, move, export` — and yet must be able to issue documents. Granting
`execute` to the role would have widened *every* `*:execute` key in the catalog
(automations included), so instead a named key list grants exactly
`documents.generate:execute`. The test pins all three sides of that: the key is
allowed, the surrounding subject is not widened, and `import` is still not a
synonym of `write`.

### Error semantics across a process hop

A domain raises an `RpcException`; the gateway unwraps it into HTTP. The mapping
(`ALREADY_EXISTS` → 409, `FAILED_PRECONDITION` → 422, `INVALID_ARGUMENT` → 400,
`UNAUTHENTICATED` → 401) is tested by provoking each code in a real domain, not
by asserting a lookup table.

---

## Ported scenarios → source

The system already has 153 Playwright specs and a set of Jest integration specs.
This suite re-expresses a few of them at the protocol level, where the invariant
actually lives.

| Test | Invariant | Source |
| --- | --- | --- |
| `test_login_issues_a_jwt_that_authorizes_subsequent_requests` | edge JWT is minted and accepted | `e2e/tests/01-login.spec.ts` (#21) |
| `test_a_request_without_a_valid_token_is_401` | `UNAUTHENTICATED` → 401 + error envelope | `e2e/tests/06-auth-negative.spec.ts` (#22); `docs/02-grpc-model.md` §4 |
| `test_a_body_project_id_that_contradicts_the_authorized_project_is_refused` | cross-project write IDOR is refused at the gateway | `docs/04-domain-model.md` §1; `CrmBffController.authoritativeProjectId` (SEC-ISO-1) |
| `test_a_record_of_another_project_is_invisible` | isolation is a mandatory field + filter; a miss is 404, never a leak | `e2e/tests/12-search-nav-isolation-p0.spec.ts`; `docs/04-domain-model.md` §1 |
| `test_a_route_of_a_disabled_module_is_refused_even_for_the_project_owner` | module gate precedes the role check | `e2e/tests/10-module-disable.spec.ts` (#87), `18-products-module-guard.spec.ts` (#2); `docs/01-architecture.md` §3 |
| `test_duplicate_creation_surfaces_as_409_already_exists` | `ALREADY_EXISTS` → 409 | `docs/02-grpc-model.md` §4; `pipe.service.createDealSource` |
| `test_an_illegal_state_transition_surfaces_as_422_failed_precondition` | `FAILED_PRECONDITION` → 422 | `e2e/tests/09-deals-details-lifecycle.spec.ts`; `docs/02-grpc-model.md` §4 |
| `test_a_malformed_payload_surfaces_as_400_invalid_argument` | domain re-validates independently of the gateway | `docs/02-grpc-model.md` §4 |
| `test_viewer_may_read_and_nothing_else` | `viewer` = `read`; `create`/`update` are one verb | `docs/03-access-model.md` §1, §3.2 |
| `test_member_may_generate_documents_without_gaining_execute_everywhere` | granular allow-list over the flat matrix | `docs/03-access-model.md` §4; `e2e/tests/12-documents-tab-generate.spec.ts`, `23-documents-settings-perms.spec.ts` |
| `test_a_domain_refuses_anything_that_is_not_a_service_api_key` | domains never parse end-user JWTs | `docs/02-grpc-model.md` §3; `contact/.../grpc-inbound-api-key.guard.spec.ts` |
| `test_a_valid_key_is_not_enough_without_the_propagated_context` | the metadata contract is enforced, fail-closed | `docs/02-grpc-model.md` §2; `shared/src/grpc/inbound-metadata.ts` |
| `test_a_complete_gateway_call_is_accepted` | positive control for the layer-2 contract | `docs/02-grpc-model.md` §3 |
| `test_a_body_project_id_contradicting_the_metadata_is_permission_denied` | domain-side half of the project boundary | `docs/04-domain-model.md` §1; `resolveProjectId` |

---

## Running it

### 1. Install

Dependencies are managed with [uv](https://docs.astral.sh/uv/):

```bash
uv sync          # or: make install
```

Plain pip works just as well:

```bash
python -m venv .venv && .venv/bin/pip install -e .
```

### 2. Generate the gRPC stubs

The Python stubs are **build output** — they are not committed (see
`.gitignore`) and must be regenerated whenever the contracts move.

```bash
make protos                       # -> ./generated
# or, explicitly:
uv run python scripts/gen_protos.py --proto-dir ../proto --clean
```

Two include paths are passed to `protoc`: the repository proto root (so that
`fairflow/<domain>/v1/<domain>.proto` resolves and sibling contracts can import
each other by the same repo-relative path, e.g. `fairflow/common/v1/common.proto`)
and the well-known types bundled with `grpcio-tools` (so `google/protobuf/*.proto`
resolves without a system `protoc`). `./generated` is on pytest's `pythonpath`.

By default only the contracts the suite calls are generated; `--all` generates
every contract under the proto root.

### 3. Configure

Copy `.env.example` to `.env` and fill it in — or export the variables. Every
default points at `localhost`; **no real host, account or key is committed
anywhere in this repository.**

| Variable | Default | Needed by |
| --- | --- | --- |
| `FAIRFLOW_GATEWAY_URL` | `http://localhost:3000` | all REST tests |
| `FAIRFLOW_ADMIN_EMAIL` / `FAIRFLOW_ADMIN_PASSWORD` | — | all REST tests |
| `FAIRFLOW_CONTACT_GRPC` | `localhost:5003` | all gRPC tests |
| `FAIRFLOW_SERVICE_API_KEY` / `FAIRFLOW_GATEWAY_API_KEY_ID` | — | the positive gRPC tests |
| `FAIRFLOW_PROTO_DIR` | `../proto` | `make protos` |
| `FAIRFLOW_HTTP_TIMEOUT` | `30` | all REST tests |

The account must be able to create projects and list users (the role-matrix
tests borrow a second existing account — this edition has self-registration
permanently disabled, so the suite cannot provision one).

### 4. Run

```bash
uv run pytest                 # everything
uv run pytest -m rest         # REST through the gateway only
uv run pytest -m grpc         # direct gRPC into a domain only
uv run pytest -m rbac         # the role-model scenarios
uv run pytest --collect-only  # no stand required
```

Markers are declared in `pyproject.toml`: `rest`, `grpc`, `rbac`, `slow`.

---

## Behaviour without a running stand

By design, **a missing stand or a missing credential is a SKIP, never a
failure.** Nothing touches the network or imports the generated stubs at
collection time, so `pytest --collect-only` always succeeds, and a full run on a
laptop with nothing started reports skips with an explicit reason:

```
SKIPPED [3] gateway unreachable at http://localhost:3000 (ConnectError); set FAIRFLOW_GATEWAY_URL or start the stand
SKIPPED [9] protobuf stubs are missing — run `make protos` (scripts/gen_protos.py)
```

The skip reasons are meant to be actionable: they name the variable to set or
the command to run.

---

## Layout

```
pyproject.toml            deps, pytest config, markers
Makefile                  install / protos / test / collect
.env.example              every knob, placeholders only
scripts/gen_protos.py     protoc wrapper -> ./generated (gitignored)
src/fairflow_e2e/
  config.py               env-driven settings, no baked-in values
  rest.py                 httpx client + error-envelope reader
  grpc_meta.py            the x-* metadata contract, transcribed from GW_METADATA
tests/
  conftest.py             session/login/project/channel fixtures, skip policy
  test_rest_auth.py
  test_rest_project_isolation.py
  test_rest_module_gating.py
  test_rest_error_mapping.py
  test_rest_role_matrix.py
  test_grpc_domain_auth.py
```

Every test carries a docstring naming the invariant it pins and the document or
spec it came from — the suite is meant to be readable as documentation of the
system's boundaries.
