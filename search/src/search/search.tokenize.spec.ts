/**
 * Single tokenizer + normalized phone/email variants (TODO-260).
 *
 * AS-IS: two copy-pasted tokenizers (SearchService.toTokens and the projection
 * mapper) that both KEPT `-`/`.`/`+` separators, so the index stored
 * `+7 912 123-45-67` and a query by the last digits (`4567`) — a substring
 * RegExp over title/subtitle/tokens — never matched. There was no normalized
 * digit form at all.
 */
import { SearchService } from './search.service';
import { ProjectionApply, type ProjectionDoc } from './search-projection.apply';
import { buildTokens } from './tokenize';
import { buildMongo, row } from './fake-mongo.testkit';
import type { VisibilityScope } from '@fairflow/shared';

const PID = 'proj-1';
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

describe('buildTokens (TODO-260)', () => {
  it('adds the digits-only phone plus its 4/7/10-digit tails', () => {
    const tokens = buildTokens(['Иван Петров', '+7 (912) 123-45-67']);
    const parts = tokens.split(' ');
    expect(parts).toContain('79121234567');
    expect(parts).toContain('4567');
    expect(parts).toContain('1234567');
    expect(parts).toContain('9121234567');
  });

  it('keeps the whole address and makes the local part matchable', () => {
    const tokens = buildTokens(['Ivan', 'IVAN.Petrov@Mail.RU']);
    expect(tokens.split(' ')).toContain('ivan.petrov@mail.ru');
    // The local part is matchable by the read path's substring RegExp; it is not
    // duplicated as a separate token because the full address already contains it.
    expect(tokens).toContain('ivan.petrov');
  });

  it('does not treat a short digit group (e.g. an email suffix) as a phone', () => {
    expect(buildTokens(['ivan2024@mail.ru']).split(' ')).not.toContain('2024');
  });

  it('keeps the base normalization (lowercase, single spaces, no punctuation noise)', () => {
    expect(buildTokens(['  ООО  «Ромашка»,  ', null, undefined, ''])).toBe('ооо ромашка');
  });
});

describe('both index paths share the tokenizer (TODO-260)', () => {
  it('reindex: a contact is found by the last 4 digits of the phone', async () => {
    const { mongo } = buildMongo({
      contacts: [
        row('c1', {
          projectId: PID,
          firstName: 'Иван',
          lastName: 'Петров',
          phone: '+7 (912) 123-45-67',
          email: 'ivan.petrov@mail.ru',
          ownerId: 'user-1',
        }),
      ],
    });
    const svc = new SearchService(mongo as never);

    const byTail = await svc.search(PID, '4567', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(byTail.list.map((h) => h.entity_id)).toEqual(['c1']);

    const byLocal = await svc.search(PID, 'ivan.petrov', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(byLocal.list.map((h) => h.entity_id)).toEqual(['c1']);
  });

  it('event delta: the projection produces the same normalized tokens', async () => {
    const writes: ProjectionDoc[] = [];
    const apply = new ProjectionApply({
      upsert: async (d) => {
        writes.push(d);
      },
      tombstone: async () => undefined,
    });

    await apply.apply('crm.contact.created', PID, {
      payload: {
        contactId: 'c1',
        firstName: 'Иван',
        lastName: 'Петров',
        phone: '+7 (912) 123-45-67',
        ownerId: 'user-1',
        updatedAt: 1000,
      },
      timestamp: new Date(1000).toISOString(),
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].tokens?.split(' ')).toContain('79121234567');
    expect(writes[0].tokens).toBe(
      buildTokens(['Иван Петров', '', '+7 (912) 123-45-67']),
    );
  });
});
