import type { EntityRefDoc } from '../mongo/mongo.service';

const ENTITY_TYPES = new Set<EntityRefDoc['type']>(['deal', 'contact', 'company', 'order']);

const TOKEN_RE = /\[\[entity:(deal|contact|company|order):([^|\]]+)\|([^\]]*)\]\]/g;

/** Extract deduped entity refs from inline tokens in message text. */
export function extractEntityRefsFromText(text: string): EntityRefDoc[] {
  const refs: EntityRefDoc[] = [];
  const seen = new Set<string>();
  const src = text ?? '';
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    const type = m[1];
    const id = m[2];
    const label = m[3];
    if (!ENTITY_TYPES.has(type as EntityRefDoc['type'])) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      type: type as EntityRefDoc['type'],
      id,
      label: (label ?? '').trim() || type,
    });
  }
  return refs;
}
