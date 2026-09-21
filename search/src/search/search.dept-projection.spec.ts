/**
 * TODO-263 (department half) — the seam between an event payload and the
 * «Мой отдел» scope preset (TODO-262 / FR-SEARCH-140).
 *
 * The owner half is pinned by `search.index-writes.spec.ts` (orphan accounting).
 * The department half was untested end-to-end, yet it is the exact seam the
 * pending producer fix lands on: `crm.*.created` payloads currently ship
 * `ownerId` but NOT `departmentId` (contacts.service.ts / companies.service.ts),
 * so event-indexed records carry `departmentId: null` and `scope=dept` can never
 * match them. These tests fix the receiving contract of the search domain so the
 * producer-side change is verifiable, and pin the two properties the domain owes
 * regardless of when it ships:
 *
 *  - a department that IS in the payload reaches the index (camelCase AND
 *    snake_case) and makes the preset match;
 *  - a department that is NOT in the payload is never invented — the preset then
 *    excludes the record (fail-closed narrowing), and a later PARTIAL event must
 *    not blank a department already known (TODO-264 merge, `absent ≠ blank`).
 */
import type { VisibilityScope } from '@fairflow/shared';
import { ProjectionApply } from './search-projection.apply';
import { SearchDeltaWriterImpl } from './search-delta.writer';
import { SearchService } from './search.service';
import { buildMongo } from './fake-mongo.testkit';

const PID = 'proj-1';
const TS = '2026-08-18T10:00:00.000Z';
const TS_LATER = '2026-08-18T11:00:00.000Z';

/** Wide visibility so the tests isolate the preset from the ABAC/visibility PEP. */
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

function build() {
  const { mongo, index } = buildMongo({});
  const svc = new SearchService(mongo as never);
  return { svc, index, apply: new ProjectionApply(new SearchDeltaWriterImpl(svc)) };
}

/** `scope=dept` search over the contact type. */
const deptSearch = (svc: SearchService, departmentIds: string[]) =>
  svc.search(PID, 'петров', 0, 25, {
    entityTypes: ['contact'],
    ownerScope: 'dept',
    scopeDepartmentIds: departmentIds,
    ctx: { scope: ALL_SCOPE },
  });

describe('event projection → department → «Мой отдел» preset (TODO-263)', () => {
  it('a payload departmentId reaches the index and the dept preset matches it', async () => {
    const { svc, index, apply } = build();

    await apply.apply('crm.contact.created', PID, {
      payload: {
        contactId: 'c1',
        firstName: 'Иван',
        lastName: 'Петров',
        ownerId: 'user-1',
        departmentId: 'dep-1',
      },
      timestamp: TS,
    });

    expect(index.docs[0].departmentId).toBe('dep-1');
    expect((await deptSearch(svc, ['dep-1'])).total).toBe(1);
    // …and only for that department — the preset stays a narrowing.
    expect((await deptSearch(svc, ['dep-2'])).total).toBe(0);
  });

  it('accepts the snake_case `department_id` spelling producers may emit', async () => {
    const { svc, index, apply } = build();

    await apply.apply('crm.contact.created', PID, {
      payload: {
        contactId: 'c1',
        firstName: 'Иван',
        lastName: 'Петров',
        owner_id: 'user-1',
        department_id: 'dep-1',
      },
      timestamp: TS,
    });

    expect(index.docs[0].departmentId).toBe('dep-1');
    expect((await deptSearch(svc, ['dep-1'])).total).toBe(1);
  });

  it('a later partial *.updated without a department does not blank the known one', async () => {
    const { svc, index, apply } = build();

    await apply.apply('crm.contact.created', PID, {
      payload: {
        contactId: 'c1',
        firstName: 'Иван',
        lastName: 'Петров',
        ownerId: 'user-1',
        departmentId: 'dep-1',
      },
      timestamp: TS,
    });
    // Verbatim contacts.service.ts update() shape: only the changed field.
    await apply.apply('crm.contact.updated', PID, {
      payload: {
        contactId: 'c1',
        changes: [{ field: 'firstName', oldValue: 'Иван', newValue: 'Пётр', changedAt: 1 }],
      },
      timestamp: TS_LATER,
    });

    expect(index.docs).toHaveLength(1);
    expect(index.docs[0].departmentId).toBe('dep-1');
    expect((await deptSearch(svc, ['dep-1'])).total).toBe(1);
  });

  it('no department in the payload → null on the index (never invented) and the preset excludes it', async () => {
    const { svc, index, apply } = build();

    // Today's producer payload (contacts.service.ts:242-250): owner but no department.
    await apply.apply('crm.contact.created', PID, {
      payload: {
        contactId: 'c1',
        firstName: 'Иван',
        lastName: 'Петров',
        ownerId: 'user-1',
      },
      timestamp: TS,
    });

    expect(index.docs[0].departmentId).toBeNull();
    // The record is indexed and findable without the preset…
    const wide = await svc.search(PID, 'петров', 0, 25, {
      entityTypes: ['contact'],
      ctx: { scope: ALL_SCOPE },
    });
    expect(wide.total).toBe(1);
    // …but «Мой отдел» must not guess a department for it (narrow, never widen).
    expect((await deptSearch(svc, ['dep-1'])).total).toBe(0);
  });
});
