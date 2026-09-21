/**
 * Transport contract for the compiled ABAC predicate (RFC-ABAC §7.1, RFC-5 §1.4/§7).
 *
 * Carried in gRPC metadata key `x-access-predicate` (GW_METADATA.ACCESS_PREDICATE),
 * base64(JSON CompiledPredicate), next to `x-visibility-scope`.
 *
 *  - CRM (Mongo) domains apply `.mongo` (AND into the read filter).
 *  - PG domains would apply `.ir` via a local `compilePostgres` — deferred in v1 (§6).
 *  - `ir=null && mongo=null` → no ABAC narrowing (no rules / all no-op): domain adds
 *    no predicate (but projectId + visibility still hold — NOT fail-open).
 */
import { AbacNode } from './ir';
import { VisibilityScope } from '../rbac';

export interface CompiledPredicate {
  /** Neutral residual IR (user.* / project.* refs already substituted). null when no ABAC rules. */
  ir: AbacNode | null;
  /** Ready Mongo fragment for CRM domains. null when no ABAC rules. */
  mongo: Record<string, unknown> | null;
}

/** Bundle of access fragments resolved on the gateway (RFC-ABAC §7.1). */
export interface AccessScope {
  visibility: VisibilityScope;
  abac: CompiledPredicate;
}

/** Empty predicate = no ABAC narrowing. */
export const NO_ABAC_PREDICATE: CompiledPredicate = { ir: null, mongo: null };

/** base64(JSON) so the predicate survives as a single gRPC metadata value. */
export function serializeCompiledPredicate(p: CompiledPredicate): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

/**
 * Parse the `x-access-predicate` metadata value. Returns `NO_ABAC_PREDICATE` on
 * absence/garbage — but the domain MUST still apply projectId + visibility (fail-closed
 * on the outer contour, not on the abac fragment alone).
 */
export function parseCompiledPredicate(raw: string | undefined | null): CompiledPredicate {
  if (!raw || !raw.trim()) return NO_ABAC_PREDICATE;
  try {
    const obj = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8')) as Partial<CompiledPredicate>;
    const mongo =
      obj.mongo && typeof obj.mongo === 'object' && !Array.isArray(obj.mongo)
        ? (obj.mongo as Record<string, unknown>)
        : null;
    const ir = obj.ir && typeof obj.ir === 'object' ? (obj.ir as AbacNode) : null;
    return { ir, mongo };
  } catch {
    return NO_ABAC_PREDICATE;
  }
}
