import { withRecordOwnerAbacShortCircuit } from './owner-short-circuit';
import { composeAccessFilter } from './compose';

describe('withRecordOwnerAbacShortCircuit (FR-ACCESS-490)', () => {
  it('ORs owner field with abac mongo fragment', () => {
    const abac = { region: { $eq: 'msk' } };
    expect(withRecordOwnerAbacShortCircuit(abac, 'ownerId', 'u1')).toEqual({
      $or: [abac, { ownerId: 'u1' }],
    });
  });

  it('passes through when selfId missing', () => {
    const abac = { region: { $eq: 'msk' } };
    expect(withRecordOwnerAbacShortCircuit(abac, 'ownerId', '')).toBe(abac);
  });
});

describe('composeAccessFilter owner short-circuit', () => {
  it('applies short-circuit in composed filter', () => {
    const filter = composeAccessFilter({
      projectId: 'p1',
      visibility: null,
      abac: { status: { $eq: 'open' } },
      ownerField: 'assigneeId',
      recordOwnerSelfId: 'u9',
    });
    expect(filter).toEqual({
      $and: [
        { projectId: 'p1' },
        { $or: [{ status: { $eq: 'open' } }, { assigneeId: 'u9' }] },
      ],
    });
  });
});
