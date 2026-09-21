import { uuidv7 } from 'uuidv7';

/** Canonical entity id (UUIDv7 per architecture-api-rules-v1). */
export function newEntityId(): string {
  return uuidv7();
}
