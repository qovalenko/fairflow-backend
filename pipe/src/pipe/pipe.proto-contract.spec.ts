import { join } from 'node:path';
import * as protoLoader from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';

/**
 * Contract tests for `proto/fairflow/pipe/v1/pipe.proto` — the wire itself, not the
 * service. Both fixes here are of the class "the domain can do it, the user never
 * sees it": a field missing from the contract is silently dropped by protobuf.js,
 * so the code on both sides looks correct while the data never crosses.
 *
 *  - TODO-185: Link{Contact,Company}Request must carry the PII `snapshot` that the
 *    gateway resolves — without it every link/qualify stored an EMPTY snapshot and
 *    drift detection had nothing to compare against.
 *  - TODO-385: UpdateDealRequest's clearable fields must have proto3 field presence
 *    (`optional`), otherwise "" and "absent" are the same byte sequence and a link
 *    can never be cleared. This ALSO pins the loader options: `defaults: true`
 *    would resurrect the bug by materializing every absent field.
 */
describe('pipe.proto contract', () => {
  const PROTO_DIR = join(__dirname, '..', '..', '..', 'proto');
  const PROTO_PATH = join(PROTO_DIR, 'fairflow', 'pipe', 'v1', 'pipe.proto');

  const root = new protobuf.Root();
  root.resolvePath = (_origin: string, target: string) => join(PROTO_DIR, target);
  const loaded = root.loadSync(join('fairflow', 'pipe', 'v1', 'pipe.proto'), { keepCase: true });

  const type = (name: string) => loaded.lookupType(`fairflow.pipe.v1.${name}`);

  /** Encode → decode with the SAME options the services use (pipe/src/main.ts). */
  const roundTrip = (name: string, payload: Record<string, unknown>) => {
    const t = type(name);
    return t.toObject(t.decode(t.encode(t.fromObject(payload)).finish()));
  };

  it('loads with the runtime loader options (keepCase + longs, no defaults)', () => {
    const pkg = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: Number,
      includeDirs: [PROTO_DIR],
    });
    expect(pkg['fairflow.pipe.v1.PipeGrpc']).toBeDefined();
  });

  describe('TODO-185: link requests carry the PII snapshot', () => {
    it('LinkContactRequest.snapshot survives the wire', () => {
      const out = roundTrip('LinkContactRequest', {
        project_id: 'p-1',
        id: 'd-1',
        contact_id: 'c-1',
        snapshot: { name: 'Иван Петров', phone: '+79990000000', email: 'i@p.ru' },
      });
      expect(out.snapshot).toEqual({
        name: 'Иван Петров',
        phone: '+79990000000',
        email: 'i@p.ru',
      });
    });

    it('LinkCompanyRequest.snapshot survives the wire', () => {
      const out = roundTrip('LinkCompanyRequest', {
        project_id: 'p-1',
        id: 'd-1',
        company_id: 'co-1',
        snapshot: { name: 'ООО Ромашка' },
      });
      expect(out.snapshot).toEqual({ name: 'ООО Ромашка' });
    });

    // Домен теперь ОТКЛОНЯЕТ link без снимка (fail-closed: снимок = доказательство
    // того, что донора прочитали под видимостью вызывающего). Проверка «есть/нет»
    // держится на присутствии поля-сообщения: без `defaults` отсутствующий снимок
    // приходит как undefined, а снимок пустого контакта — как ПУСТОЙ объект.
    it('an absent snapshot stays absent, a blank-contact snapshot stays present', () => {
      const base = { project_id: 'p-1', id: 'd-1', contact_id: 'c-1' };
      expect(roundTrip('LinkContactRequest', base).snapshot).toBeUndefined();
      const blank = roundTrip('LinkContactRequest', {
        ...base,
        snapshot: { name: '', phone: '', email: '' },
      }).snapshot;
      expect(blank).toBeDefined();
      expect(blank).toMatchObject({ name: '', phone: '', email: '' });
    });

    it('the snapshot INPUT has no client-forgeable linked_at/linked_by', () => {
      const fields = Object.keys(type('ContactSnapshotInput').fields);
      expect(fields.sort()).toEqual(['email', 'name', 'phone']);
      expect(Object.keys(type('CompanySnapshotInput').fields)).toEqual(['name']);
    });
  });

  describe('TODO-385: UpdateDealRequest has field presence on clearable fields', () => {
    const CLEARABLE = [
      'contact_id',
      'company_id',
      'product_id',
      'source',
      'notes',
      'assignee_id',
      'department_id',
      'name',
      'amount',
      'currency',
      'pipeline_id',
      'stage_id',
    ];

    // protobuf.js reports EVERY proto3 singular field as `optional`; real explicit
    // presence shows up as membership in a synthetic oneof named `_<field>`.
    it.each(CLEARABLE)('%s has explicit presence (synthetic oneof)', (field) => {
      expect(type('UpdateDealRequest').fields[field].partOf?.name).toBe(`_${field}`);
    });

    it('an explicitly empty value is distinguishable from an absent one', () => {
      const cleared = roundTrip('UpdateDealRequest', {
        project_id: 'p-1',
        id: 'd-1',
        contact_id: '',
      });
      expect(cleared).toHaveProperty('contact_id', '');

      const untouched = roundTrip('UpdateDealRequest', { project_id: 'p-1', id: 'd-1' });
      expect(untouched).not.toHaveProperty('contact_id');
    });

    it('project_id / id stay required-by-convention (no presence games on identity)', () => {
      expect(type('UpdateDealRequest').fields.project_id.partOf).toBeFalsy();
      expect(type('UpdateDealRequest').fields.id.partOf).toBeFalsy();
    });
  });

  describe('TODO-189: ListDealsRequest.include_deleted survives the wire', () => {
    it('true доезжает до домена (иначе корзина показывает живые сделки)', () => {
      const out = roundTrip('ListDealsRequest', { project_id: 'p-1', include_deleted: true });
      expect(out.include_deleted).toBe(true);
    });

    it('обычный список не несёт флага (proto3: false не сериализуется)', () => {
      const out = roundTrip('ListDealsRequest', { project_id: 'p-1', include_deleted: false });
      expect(out.include_deleted).toBeFalsy();
    });
  });
});
