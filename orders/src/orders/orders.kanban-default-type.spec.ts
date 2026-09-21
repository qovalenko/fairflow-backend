import type { VisibilityScope } from '@fairflow/shared';
import { ObjectId } from 'mongodb';
import { pickDefaultKanbanOrderType, OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';

const SCOPE = { mode: 'all', ownerIds: [], sharedRecordIds: [] } as unknown as VisibilityScope;

describe('pickDefaultKanbanOrderType', () => {
  const types = [
    { id: 'template-empty', name: 'Стандартная продажа' },
    { id: 'ot-license', name: 'Продажа лицензий' },
    { id: 'ot-implementation', name: 'Внедрение' },
  ];

  it('prefers the first type that has orders over an empty types[0]', () => {
    const picked = pickDefaultKanbanOrderType(
      types,
      new Map([
        ['template-empty', 0],
        ['ot-license', 14],
        ['ot-implementation', 13],
      ]),
    );
    expect(picked?.id).toBe('ot-license');
  });

  it('falls back to types[0] when no type has orders', () => {
    const picked = pickDefaultKanbanOrderType(types, new Map());
    expect(picked?.id).toBe('template-empty');
  });
});

describe('OrdersService.getKanban default type (box B2B regression)', () => {
  it('without typeId loads the first type that actually has cards', async () => {
    const types = [
      {
        id: 'template-empty',
        name: 'Стандартная продажа',
        stages: [{ id: 's1', name: 'Оформление' }],
      },
      {
        id: 'ot-license',
        name: 'Продажа лицензий',
        stages: [{ id: 'os1', name: 'Оформление' }],
      },
    ];
    let aggregateCalls = 0;
    const mongo = {
      orderTypes: () => ({
        find: () => ({ toArray: async () => types }),
      }),
      orders: () => ({
        aggregate: (pipeline: Record<string, unknown>[]) => {
          aggregateCalls += 1;
          // First aggregate: resolve default type by counts.
          if (aggregateCalls === 1) {
            return {
              toArray: async () => [{ _id: 'ot-license', c: 2 }],
            };
          }
          // Second aggregate: facet board columns for the resolved type.
          const facet = (pipeline[1] as Record<string, unknown>).$facet as Record<
            string,
            Record<string, unknown>[]
          >;
          const match = (facet.c0[0] as Record<string, unknown>).$match as { stageId: string };
          return {
            toArray: async () => [
              {
                c0: [
                  {
                    _id: new ObjectId(),
                    id: 'o1',
                    stageId: match.stageId,
                    typeId: 'ot-license',
                    number: 'ORD-1',
                    updatedAt: 1,
                  },
                ],
              },
            ],
          };
        },
      }),
    } as unknown as ConstructorParameters<typeof OrdersService>[0];

    const service = new OrdersService(
      mongo,
      {} as unknown as ConstructorParameters<typeof OrdersService>[1],
      {} as unknown as ConstructorParameters<typeof OrdersService>[2],
      noopSpecValidator,
    );

    const board = (await service.getKanban('p1', undefined, SCOPE)) as {
      type_id?: string;
      columns?: { orders?: unknown[] }[];
    };

    expect(board.type_id).toBe('ot-license');
    expect(board.columns?.[0]?.orders).toHaveLength(1);
    expect(aggregateCalls).toBe(2);
  });
});
