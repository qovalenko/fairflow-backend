import type { OutboxCausation } from '@fairflow/shared';
import type { ScopeDoc } from '../mongo/mongo.service';

/**
 * PEP context resolved by the gRPC controller from trusted gateway metadata
 * (contracts/chat.md §1/§2.2). The service NEVER reads scope/actor from the body.
 */
export interface ChatCtx {
  /** Acting end-user (x-user-id). */
  userId: string;
  /** Isolation scope (project | org | workspace) resolved from metadata. */
  scope: ScopeDoc;
  /** Lineage for emitted events (RFC-4 §Р-1). */
  causation?: OutboxCausation;
}

/** Re-export the storage scope shape for service signatures. */
export type Scope = ScopeDoc;
