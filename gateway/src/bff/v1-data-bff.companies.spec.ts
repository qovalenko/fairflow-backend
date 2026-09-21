/**
 * [be-gw-companies] Волна «Компании», слой gateway/BFF.
 *
 * Закрывает четыре разрыва «домен умеет — до пользователя не доходит»:
 *  1. TODO-110/TODO-153 — merge гейтился несуществующим ключом `companies:execute`
 *     (в каталоге модуля его нет), из-за чего кнопка слияния была скрыта у всех
 *     ролей, включая владельца проекта → приведено к `companies:manage`;
 *  2. TODO-157 — `DELETE /companies/:id?force=true` («удалить навсегда» из корзины)
 *     молча звал soft-delete, который на записи из корзины отдавал NOT_FOUND;
 *  3. TODO-158 — экспорт просил у домена page_size: 1000, а домен режет до 100:
 *     выгружалось максимум 100 строк без признака усечения;
 *  4. TODO-364 — createdBy/updatedBy/source не домапливались в ответе gateway;
 *  5. TODO-366 (частично) — смена владельца не проверяла, что новый владелец
 *     вообще участник проекта.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';
import { REQUIRED_PERMISSION_KEY } from '../guards/require-permission.decorator';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(
  opts: { company?: Record<string, unknown>; control?: Record<string, unknown> } = {},
) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new V1DataBffController(
    stubClient(opts.control ?? {}),
    stubClient(),
    stubClient(opts.company ?? {}),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(),
    outboundMeta,
    {} as never,
    {} as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = { headers: {}, user: { userId: 'u1' } } as never;

function permOf(method: keyof V1DataBffController) {
  return Reflect.getMetadata(
    REQUIRED_PERMISSION_KEY,
    V1DataBffController.prototype[method] as never,
  ) as { subject: string; action: string } | undefined;
}

describe('[be-gw-companies] TODO-110/153: merge гейтится ключом из каталога', () => {
  // `companies:execute` не существует ни в policyCapabilities модуля, ни в
  // DECORATOR_SUBJECT_MAP → проекция allowed[] его не содержит никогда, и FE-гейт
  // (точное совпадение ключа) прячет кнопку у всех ролей, включая владельца.
  // Прецедент: `POST /contacts/merge` → `contacts:manage`.
  it('POST /companies/merge/preview требует companies:manage', () => {
    expect(permOf('previewCompanyMerge')).toEqual({ subject: 'companies', action: 'manage' });
  });

  it('POST /companies/merge требует companies:manage', () => {
    expect(permOf('mergeCompanies')).toEqual({ subject: 'companies', action: 'manage' });
  });

  it('ни один маршрут компаний больше не гейтится действием execute', () => {
    const companyRoutes = Object.getOwnPropertyNames(V1DataBffController.prototype).filter((m) => {
      const perm = Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        V1DataBffController.prototype[m as keyof V1DataBffController] as never,
      ) as { subject?: string; action?: string } | undefined;
      return perm?.subject?.startsWith('companies') && perm?.action === 'execute';
    });
    expect(companyRoutes).toEqual([]);
  });
});

describe('[be-gw-companies] TODO-157: hard-delete из корзины', () => {
  it('force=true роутится на PurgeCompany (жёсткое удаление)', async () => {
    const purgeCompany = jest.fn(() => of({ ok: true }));
    const deleteCompany = jest.fn(() => of({ id: 'co1' }));
    const ctrl = build({ company: { purgeCompany, deleteCompany } });

    const res = await ctrl.deleteCompany(req, 'co1', 'p1', 'true');

    expect(purgeCompany).toHaveBeenCalledWith({ project_id: 'p1', id: 'co1' }, expect.anything());
    expect(deleteCompany).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, purged: true });
  });

  it('без force остаётся мягкое удаление (в корзину)', async () => {
    const purgeCompany = jest.fn(() => of({ ok: true }));
    const deleteCompany = jest.fn(() => of({ id: 'co1' }));
    const ctrl = build({ company: { purgeCompany, deleteCompany } });

    const res = await ctrl.deleteCompany(req, 'co1', 'p1');

    expect(deleteCompany).toHaveBeenCalledWith({ project_id: 'p1', id: 'co1' }, expect.anything());
    expect(purgeCompany).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, purged: false });
  });

  it('force=false не превращается в жёсткое удаление', async () => {
    const purgeCompany = jest.fn(() => of({ ok: true }));
    const deleteCompany = jest.fn(() => of({ id: 'co1' }));
    const ctrl = build({ company: { purgeCompany, deleteCompany } });

    await ctrl.deleteCompany(req, 'co1', 'p1', 'false');

    expect(purgeCompany).not.toHaveBeenCalled();
    expect(deleteCompany).toHaveBeenCalled();
  });
});

describe('[be-gw-companies] TODO-158: экспорт листает страницами по 100', () => {
  const resStub = () => ({ header: jest.fn() }) as never;

  function pagedList(total: number) {
    return jest.fn((payload: unknown) => {
      const { page_index: pageIndex, page_size: pageSize } = payload as {
        page_index: number;
        page_size: number;
      };
      const from = pageIndex * pageSize;
      const rows = Array.from(
        { length: Math.max(0, Math.min(pageSize, total - from)) },
        (_, i) => ({
          id: `co${from + i}`,
          name: `Компания ${from + i}`,
        }),
      );
      return of({ list: rows, total });
    });
  }

  it('собирает больше 100 записей (прежний потолок домена) за несколько страниц', async () => {
    const listCompanies = pagedList(250);
    const ctrl = build({ company: { listCompanies } });

    const buf = (await ctrl.exportCompanies(req, resStub(), 'p1', 'json')) as Buffer;
    const rows = JSON.parse(buf.toString('utf8')) as { id: string }[];

    expect(rows).toHaveLength(250);
    expect(listCompanies).toHaveBeenCalledTimes(3);
    expect((listCompanies.mock.calls[0][0] as { page_size: number }).page_size).toBe(100);
    expect((listCompanies.mock.calls[2][0] as { page_index: number }).page_index).toBe(2);
    expect(rows[249].id).toBe('co249');
  });

  it('перестаёт листать на первой неполной странице', async () => {
    const listCompanies = pagedList(30);
    const ctrl = build({ company: { listCompanies } });

    const buf = (await ctrl.exportCompanies(req, resStub(), 'p1', 'json')) as Buffer;

    expect(JSON.parse(buf.toString('utf8'))).toHaveLength(30);
    expect(listCompanies).toHaveBeenCalledTimes(1);
  });

  it('усечение по потолку помечается заголовком X-Export-Truncated', async () => {
    // Домен всегда отдаёт полную страницу → потолок 100 страниц исчерпан.
    const listCompanies = jest.fn(() =>
      of({ list: Array.from({ length: 100 }, (_, i) => ({ id: `co${i}` })), total: 100000 }),
    );
    const res = resStub() as unknown as { header: jest.Mock };
    const ctrl = build({ company: { listCompanies } });

    await ctrl.exportCompanies(req, res as never, 'p1', 'json');

    expect(listCompanies).toHaveBeenCalledTimes(100);
    expect(res.header).toHaveBeenCalledWith('X-Export-Truncated', 'true');
    expect(res.header).toHaveBeenCalledWith('X-Export-Count', '10000');
  });

  it('ровно потолок записей (10 000) не помечается усечённым', async () => {
    const listCompanies = pagedList(10000);
    const res = resStub() as unknown as { header: jest.Mock };
    const ctrl = build({ company: { listCompanies } });

    await ctrl.exportCompanies(req, res as never, 'p1', 'json');

    expect(listCompanies).toHaveBeenCalledTimes(100);
    expect(res.header).toHaveBeenCalledWith('X-Export-Count', '10000');
    expect(res.header.mock.calls.map((c) => c[0])).not.toContain('X-Export-Truncated');
  });

  it('полная выгрузка не помечается усечённой', async () => {
    const res = resStub() as unknown as { header: jest.Mock };
    const ctrl = build({ company: { listCompanies: pagedList(5) } });

    await ctrl.exportCompanies(req, res as never, 'p1', 'json');

    expect(res.header).toHaveBeenCalledWith('X-Export-Count', '5');
    expect(res.header.mock.calls.map((c) => c[0])).not.toContain('X-Export-Truncated');
  });

  it('фильтры и сортировка списка доезжают до домена (выгрузка = видимый набор)', async () => {
    const listCompanies = pagedList(1);
    const ctrl = build({ company: { listCompanies } });

    await ctrl.exportCompanies(
      req,
      resStub(),
      'p1',
      'csv',
      'акме',
      'active',
      'u9',
      'd1',
      'it',
      'msk',
      'vip,key',
      'name',
      'desc',
    );

    expect(listCompanies.mock.calls[0][0]).toMatchObject({
      project_id: 'p1',
      query: 'акме',
      filter_status: 'active',
      filter_owner_id: 'u9',
      filter_department_id: 'd1',
      filter_industry: 'it',
      filter_region: 'msk',
      filter_tags: 'vip,key',
      sort_by: 'name',
      sort_dir: 'desc',
    });
  });
});

describe('[be-gw-companies] TODO-362: подсказка о дубле — оба направления', () => {
  it('email/website доезжают до домена (домен сам выводит domain)', async () => {
    const findDuplicates = jest.fn((_payload: unknown) => of({ candidates: [] }));
    const ctrl = build({ company: { findDuplicates } });

    await ctrl.findCompanyDuplicates(req, 'p1', '', 'Акме', '', 'i@acme.ru', 'https://acme.ru');

    expect(findDuplicates.mock.calls[0][0]).toMatchObject({
      project_id: 'p1',
      name: 'Акме',
      email: 'i@acme.ru',
      website: 'https://acme.ru',
    });
  });

  it('признак «кандидат в корзине» доезжает до клиента', async () => {
    const findDuplicates = jest.fn(() =>
      of({
        candidates: [
          { id: 'co1', name: 'Акме', inn: '7701', match_reason: 'inn', deleted: true },
          { id: 'co2', name: 'Акме-2', inn: '7702', match_reason: 'name' },
        ],
      }),
    );
    const ctrl = build({ company: { findDuplicates } });

    const res = (await ctrl.findCompanyDuplicates(req, 'p1', '7701')) as {
      candidates: Record<string, unknown>[];
    };

    expect(res.candidates[0]).toMatchObject({ id: 'co1', matchReason: 'inn', deleted: true });
    expect(res.candidates[1].deleted).toBe(false);
  });
});

describe('[be-gw-companies] TODO-364: атрибуция доезжает до карточки', () => {
  it('getCompany отдаёт createdBy/updatedBy/source из snake_case домена', async () => {
    const getCompany = jest.fn(() =>
      of({
        id: 'co1',
        name: 'Акме',
        created_by: 'u7',
        updated_by: 'u8',
        source: 'import',
        created_at: 1,
        updated_at: 2,
      }),
    );
    const ctrl = build({ company: { getCompany } });

    const res = (await ctrl.getCompany(req, 'co1', 'p1')) as Record<string, unknown>;

    expect(res.createdBy).toBe('u7');
    expect(res.updatedBy).toBe('u8');
    expect(res.source).toBe('import');
  });

  it('список компаний тоже несёт атрибуцию по каждой строке', async () => {
    const listCompanies = jest.fn(() =>
      of({ list: [{ id: 'co1', created_by: 'u7', source: 'manual' }, { id: 'co2' }], total: 2 }),
    );
    const ctrl = build({ company: { listCompanies } });

    const res = (await ctrl.listCompanies(req, 'p1')) as { list: Record<string, unknown>[] };

    expect(res.list[0].createdBy).toBe('u7');
    expect(res.list[0].source).toBe('manual');
    expect(res.list[1].createdBy).toBeUndefined();
  });
});

describe('[be-gw-companies] TODO-366: новый владелец обязан быть участником проекта', () => {
  it('отбивает переназначение на пользователя вне проекта, до домена не доезжает', async () => {
    const updateOwner = jest.fn(() => of({ id: 'co1' }));
    const listMembers = jest.fn(() => of({ list: [{ id: 'u1' }, { id: 'u2' }] }));
    const ctrl = build({ company: { updateOwner }, control: { listMembers } });

    await expect(
      ctrl.updateCompanyOwner(req, 'co1', 'p1', { ownerId: 'stranger' }),
    ).rejects.toMatchObject({ response: { code: 'OWNER_NOT_PROJECT_MEMBER' } });
    expect(updateOwner).not.toHaveBeenCalled();
  });

  it('пропускает переназначение на участника проекта', async () => {
    const updateOwner = jest.fn(() => of({ id: 'co1', owner_id: 'u2' }));
    const listMembers = jest.fn(() => of({ list: [{ id: 'u1' }, { id: 'u2' }] }));
    const ctrl = build({ company: { updateOwner }, control: { listMembers } });

    const res = (await ctrl.updateCompanyOwner(req, 'co1', 'p1', {
      ownerId: 'u2',
      departmentId: 'd1',
    })) as Record<string, unknown>;

    expect(updateOwner).toHaveBeenCalledWith(
      { project_id: 'p1', id: 'co1', owner_id: 'u2', department_id: 'd1' },
      expect.anything(),
    );
    expect(res.ownerId).toBe('u2');
  });

  it('смена только отдела (без ownerId) не требует проверки членства', async () => {
    const updateOwner = jest.fn(() => of({ id: 'co1' }));
    const listMembers = jest.fn(() => of({ list: [] }));
    const ctrl = build({ company: { updateOwner }, control: { listMembers } });

    await ctrl.updateCompanyOwner(req, 'co1', 'p1', { departmentId: 'd2' });

    expect(listMembers).not.toHaveBeenCalled();
    expect(updateOwner).toHaveBeenCalled();
  });

  it('fail-closed: недоступный control не даёт сменить владельца', async () => {
    const updateOwner = jest.fn(() => of({ id: 'co1' }));
    const listMembers = jest.fn(() => {
      throw new Error('control down');
    });
    const ctrl = build({ company: { updateOwner }, control: { listMembers } });

    await expect(ctrl.updateCompanyOwner(req, 'co1', 'p1', { ownerId: 'u2' })).rejects.toThrow();
    expect(updateOwner).not.toHaveBeenCalled();
  });
});

describe('[be-gw-companies] TODO-366: гейт переназначения владельца', () => {
  /**
   * Субъект декоратора обязан остаться `companies` — именно он (и только он)
   * протаскивает через ProjectAccessGuard три слоя поверх RBAC: разрешение шар
   * (`SHAREABLE_RESOURCES` содержит 'companies'), overlay module-policy
   * (`isDeniedByPolicy(rules, subject, action)`) и ABAC-предикат
   * (`resolveAccessPredicate(rules, subject, ...)` → `x-access-predicate`).
   * Перевод маршрута на гранулярный субъект (`companies.owner`) выглядит
   * «аккуратнее», но молча выключил бы все три: правило DENY на
   * `companies:write` и условные ABAC-правила модуля перестали бы применяться
   * к смене владельца. Право FE-кнопки согласовано другим способом — субъект
   * `companies.owner:write` добавлен в каталог модуля (module-registry.ts),
   * см. shared/src/permission-companies-owner.spec.ts.
   */
  it('маршрут гейтится companies:write (субъект — companies, не companies.owner)', () => {
    expect(permOf('updateCompanyOwner')).toEqual({ subject: 'companies', action: 'write' });
  });

  it("действие входит в словарь ролей — 'reassign' декоратором не объявляется", () => {
    // `reassign` нет ни в PermissionAction, ни в PROJECT_ROLE_ACTIONS: такой
    // декоратор прошёл бы мимо projectRoleCanKey и запретил маршрут ВСЕМ,
    // включая владельца проекта (мапа DECORATOR_SUBJECT_MAP на flat-проверку
    // гварда не влияет).
    const perms = (Object.getOwnPropertyNames(V1DataBffController.prototype) as string[])
      .map((m) => permOf(m as keyof V1DataBffController))
      .filter((p): p is { subject: string; action: string } => !!p);
    expect(perms.filter((p) => p.action === 'reassign')).toEqual([]);
  });
});
