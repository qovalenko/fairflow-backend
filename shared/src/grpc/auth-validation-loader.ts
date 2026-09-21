/**
 * proto-loader options for the domain-side `AUTH_VALIDATION_GRPC` client — the
 * client every domain uses to validate the gateway service-API-key against auth
 * `ApiKeyGrpc.ValidateServiceApiKey`.
 *
 * P8 HOTFIX: this client was registered WITHOUT a `loader`, so proto-loader
 * defaulted to camelCase. The auth service is built with `keepCase:true`, so the
 * request field `api_key` was dropped and the response `active`/`key_id` fields
 * were mis-decoded → every ValidateServiceApiKey came back `{active:false}` and
 * every domain answered 401 "Invalid gateway service API key".
 *
 * Derived from `CANONICAL_GRPC_LOADER_OPTIONS` (see `loader-options.ts` for why
 * keepCase/longs/arrays are mandatory), so this client can no longer drift away
 * from the repo-wide baseline. Kept in one place — imported by every domain's
 * AuthValidationModule — so the config cannot silently diverge per module.
 *
 * Deliberate deviations from the canon, all four justified:
 *  - `longs: String` — the whole `ApiKeyGrpc` validation contract is strings and
 *    booleans (`api_key`, `key_id`, `scopes`, `active`); it carries no int64 and
 *    is not expected to. Should one ever appear it would be an opaque
 *    identifier, for which the string form is lossless. EXPLICIT, not inherited
 *    by accident.
 *  - `enums: String` — auth returns enum-ish values that are logged/compared as
 *    names, never as ordinals.
 *  - `defaults: true` — an absent `active` must decode as `false`, not
 *    `undefined`; fail-closed depends on the field being present.
 *  - `oneofs: true` — surfaces the virtual oneof discriminator for future
 *    variant responses.
 *
 * `keepCase:true` is load-bearing here and MUST match the auth loader. The
 * repo-wide pin test (`loader-options.pin.spec.ts`) asserts it, along with the
 * presence of an explicit `longs`.
 */

import { buildGrpcLoaderOptions } from './loader-options';

export const authValidationLoaderOptions = buildGrpcLoaderOptions({
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
