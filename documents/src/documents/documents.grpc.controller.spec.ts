import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { GW_METADATA, serializeVisibilityScope, type VisibilityScope } from '@fairflow/shared';
import { DocumentsGrpcController } from './documents.grpc.controller';
import type { DocumentsService } from './documents.service';

type Call = { args: unknown[] };

const onlyOwnScope: VisibilityScope = {
  mode: 'restricted',
  level: 'only_own',
  selfId: 'u1',
  ownerIds: ['u1'],
  sharedRecordIds: [],
} as VisibilityScope;

function makeController() {
  const calls: Record<string, Call[]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push({ args });
      return Promise.resolve({});
    };
  const documents = {
    provisionDefaults: record('provisionDefaults'),
    listTemplates: record('listTemplates'),
    createTemplate: record('createTemplate'),
    getTemplate: record('getTemplate'),
    createTemplateRevision: record('createTemplateRevision'),
    publishTemplate: record('publishTemplate'),
    archiveTemplate: record('archiveTemplate'),
    listTemplateRevisions: record('listTemplateRevisions'),
    getTemplateDownloadUrl: record('getTemplateDownloadUrl'),
    deleteTemplate: record('deleteTemplate'),
    listDocuments: record('listDocuments'),
    getDocument: record('getDocument'),
    listVersions: record('listVersions'),
    generateDocument: record('generateDocument'),
    regenerateDocument: record('regenerateDocument'),
    uploadDocument: record('uploadDocument'),
    getDownloadUrl: record('getDownloadUrl'),
    checkDrift: record('checkDrift'),
    checkDriftBatch: record('checkDriftBatch'),
    deleteDocument: record('deleteDocument'),
    countOwnedRecords: jest.fn().mockResolvedValue(3),
    reassignOwnedRecords: jest.fn().mockResolvedValue({ reassigned: 2 }),
  } as unknown as DocumentsService;
  return { controller: new DocumentsGrpcController(documents), calls, documents };
}

function meta(entries: Record<string, string>): Metadata {
  const m = new Metadata();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

describe('DocumentsGrpcController project id (Д-5)', () => {
  it('prefers x-project-id metadata over the body when they match', async () => {
    const { controller, calls } = makeController();
    await controller.listTemplates(
      { project_id: 'meta-project', context_type: 'deal' },
      meta({ [GW_METADATA.PROJECT_ID]: 'meta-project' }),
    );
    expect(calls.listTemplates[0].args[0]).toBe('meta-project');
  });

  it('rejects a body project_id that conflicts with trusted metadata', () => {
    const { controller } = makeController();
    expect(() =>
      controller.listTemplates(
        { project_id: 'body-project', context_type: 'deal' },
        meta({ [GW_METADATA.PROJECT_ID]: 'meta-project' }),
      ),
    ).toThrow(RpcException);
  });
});

describe('DocumentsGrpcController actor identity', () => {
  it('passes x-user-id from metadata, not a body user_id, into createTemplate', async () => {
    const { controller, calls } = makeController();
    await controller.createTemplate(
      { project_id: 'p1', name: 'Tpl', user_id: 'spoofed' } as never,
      meta({ [GW_METADATA.PROJECT_ID]: 'p1', [GW_METADATA.USER_ID]: 'u-real' }),
    );
    expect(calls.createTemplate[0].args[1]).toBe('u-real');
  });

  it('forwards metadata to getDownloadUrl for the chat membership gate', async () => {
    const { controller, calls } = makeController();
    const m = meta({ [GW_METADATA.PROJECT_ID]: 'p1', [GW_METADATA.USER_ID]: 'u1' });
    await controller.getDownloadUrl({ version_id: 'v1' }, m);
    expect(calls.getDownloadUrl[0].args[4]).toBe(m);
  });
});

describe('DocumentsGrpcController listDocuments mapping', () => {
  it('maps proto filters and ignores invalid source_kind values', async () => {
    const { controller, calls } = makeController();
    await controller.listDocuments(
      {
        project_id: 'p1',
        context_type: 'deal',
        record_id: 'd1',
        page_index: 1,
        page_size: 10,
        source_kind: 'bogus',
        empty_vars_only: true,
        empty_vars_only_set: true,
        has_drift: true,
        has_drift_set: true,
      },
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    const opts = calls.listDocuments[0].args[1] as Record<string, unknown>;
    expect(opts).toMatchObject({
      contextType: 'deal',
      recordId: 'd1',
      pageIndex: 1,
      pageSize: 10,
      hasDrift: true,
      emptyVarsOnly: true,
    });
    expect(opts.sourceKind).toBeUndefined();
  });
});

describe('DocumentsGrpcController offboarding RPCs', () => {
  it('countMemberOwnedRecords wraps the service counter', async () => {
    const { controller, documents } = makeController();
    const res = await controller.countMemberOwnedRecords(
      { project_id: 'p1', user_id: 'u1' },
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    expect(documents.countOwnedRecords).toHaveBeenCalledWith('p1', 'u1');
    expect(res).toEqual({ count: 3 });
  });

  it('reassignMemberOwnedRecords returns the reassigned count', async () => {
    const { controller, documents } = makeController();
    const res = await controller.reassignMemberOwnedRecords(
      { project_id: 'p1', from_user_id: 'u-old', to_user_id: 'u-new' },
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    expect(documents.reassignOwnedRecords).toHaveBeenCalledWith('p1', 'u-old', 'u-new', expect.any(Number));
    expect(res).toEqual({ reassigned: 2 });
  });
});

describe('DocumentsGrpcController provisioning', () => {
  it('forwards enabled_modules to provisionDefaults', async () => {
    const { controller, calls } = makeController();
    await controller.provisionDefaults(
      { project_id: 'p1', enabled_modules: ['documents', 'deals'] },
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    expect(calls.provisionDefaults[0].args).toEqual(['p1', ['documents', 'deals']]);
  });
});

describe('DocumentsGrpcController template RPCs', () => {
  it('delegates getTemplate with project id from metadata', async () => {
    const { controller, calls } = makeController();
    await controller.getTemplate(
      { project_id: 'p1', id: 'tpl-1', version: 2 },
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    expect(calls.getTemplate[0].args).toEqual(['p1', 'tpl-1', 2]);
  });

  it('forwards createTemplateRevision with actor and access metadata', async () => {
    const { controller, calls } = makeController();
    const m = meta({
      [GW_METADATA.PROJECT_ID]: 'p1',
      [GW_METADATA.USER_ID]: 'u1',
      [GW_METADATA.ENABLED_MODULES]: JSON.stringify(['documents', 'deals']),
    });
    await controller.createTemplateRevision(
      { project_id: 'p1', id: 'tpl-1', bucket: 'docs', object_key: 'p1/t.docx' } as never,
      m,
    );
    expect(calls.createTemplateRevision[0].args[0]).toBe('p1');
    expect(calls.createTemplateRevision[0].args[2]).toBe('u1');
    expect(calls.createTemplateRevision[0].args[4]).toEqual(['documents', 'deals']);
  });

  it('delegates publishTemplate and archiveTemplate to the service', async () => {
    const { controller, calls } = makeController();
    const m = meta({ [GW_METADATA.PROJECT_ID]: 'p1', [GW_METADATA.USER_ID]: 'u1' });
    await controller.publishTemplate({ project_id: 'p1', id: 'tpl-1', version: 3 }, m);
    await controller.archiveTemplate({ project_id: 'p1', id: 'tpl-1' }, m);
    expect(calls.publishTemplate[0].args).toEqual(['p1', 'tpl-1', 'u1', 3]);
    expect(calls.archiveTemplate[0].args).toEqual(['p1', 'tpl-1', 'u1']);
  });

  it('delegates listTemplateRevisions, getTemplateDownloadUrl and deleteTemplate', async () => {
    const { controller, calls } = makeController();
    const m = meta({ [GW_METADATA.PROJECT_ID]: 'p1' });
    await controller.listTemplateRevisions({ project_id: 'p1', id: 'tpl-1' }, m);
    await controller.getTemplateDownloadUrl(
      { project_id: 'p1', id: 'tpl-1', version: 2, ttl_sec: 120 },
      m,
    );
    await controller.deleteTemplate({ project_id: 'p1', id: 'tpl-1' }, m);
    expect(calls.listTemplateRevisions[0].args).toEqual(['p1', 'tpl-1']);
    expect(calls.getTemplateDownloadUrl[0].args).toEqual(['p1', 'tpl-1', 2, 120]);
    expect(calls.deleteTemplate[0].args).toEqual(['p1', 'tpl-1']);
  });
});

describe('DocumentsGrpcController document RPCs', () => {
  it('delegates getDocument and listVersions with visibility metadata', async () => {
    const { controller, calls } = makeController();
    const m = meta({
      [GW_METADATA.PROJECT_ID]: 'p1',
      [GW_METADATA.VISIBILITY_SCOPE]: serializeVisibilityScope(onlyOwnScope),
    });
    await controller.getDocument({ project_id: 'p1', group_id: 'g-1' }, m);
    await controller.listVersions({ project_id: 'p1', group_id: 'g-1' }, m);
    expect(calls.getDocument[0].args[0]).toBe('p1');
    expect(calls.getDocument[0].args[1]).toBe('g-1');
    expect(calls.getDocument[0].args[2]).toEqual(onlyOwnScope);
    expect(calls.listVersions[0].args[0]).toBe('p1');
    expect(calls.listVersions[0].args[1]).toBe('g-1');
    expect(calls.listVersions[0].args[2]).toEqual(onlyOwnScope);
  });

  it('delegates generateDocument with enabled modules from metadata', async () => {
    const { controller, calls } = makeController();
    const m = meta({
      [GW_METADATA.PROJECT_ID]: 'p1',
      [GW_METADATA.USER_ID]: 'u1',
      [GW_METADATA.ENABLED_MODULES]: JSON.stringify(['documents', 'orders']),
    });
    await controller.generateDocument(
      { project_id: 'p1', template_id: 't1', context_type: 'order', record_id: 'o1' } as never,
      m,
    );
    expect(calls.generateDocument[0].args[0]).toBe('p1');
    expect(calls.generateDocument[0].args[1]).toBe('u1');
    expect(calls.generateDocument[0].args[3]).toEqual(['documents', 'orders']);
  });

  it('delegates checkDrift and deleteDocument', async () => {
    const { controller, calls } = makeController();
    const m = meta({ [GW_METADATA.PROJECT_ID]: 'p1', [GW_METADATA.USER_ID]: 'u1' });
    await controller.checkDrift(
      { project_id: 'p1', group_id: 'g-1', source_hash: 'h1', changed_keys: ['a'] },
      m,
    );
    await controller.deleteDocument({ project_id: 'p1', group_id: 'g-1' }, m);
    expect(calls.checkDrift[0].args[0]).toBe('p1');
    expect(calls.checkDrift[0].args[1]).toBe('g-1');
    expect(calls.deleteDocument[0].args[0]).toBe('p1');
    expect(calls.deleteDocument[0].args[1]).toBe('g-1');
  });

  it('delegates regenerateDocument, uploadDocument and checkDriftBatch', async () => {
    const { controller, calls } = makeController();
    const m = meta({
      [GW_METADATA.PROJECT_ID]: 'p1',
      [GW_METADATA.USER_ID]: 'u1',
      [GW_METADATA.ENABLED_MODULES]: 'documents,deals',
    });
    await controller.regenerateDocument(
      { project_id: 'p1', group_id: 'g-1', expected_version: 2, values_json: '{}' },
      m,
    );
    await controller.uploadDocument(
      { project_id: 'p1', name: 'scan.pdf', context_type: 'none', bucket: 'docs', object_key: 'p1/x.pdf' },
      m,
    );
    await controller.checkDriftBatch({ project_id: 'p1', group_ids: ['g-1', 'g-2'] }, m);
    expect(calls.regenerateDocument[0].args[0]).toBe('p1');
    expect(calls.regenerateDocument[0].args[1]).toBe('g-1');
    expect(calls.uploadDocument[0].args[0]).toBe('p1');
    expect(calls.uploadDocument[0].args[1]).toBe('u1');
    expect(calls.checkDriftBatch[0].args[0]).toBe('p1');
    expect(calls.checkDriftBatch[0].args[1]).toEqual(['g-1', 'g-2']);
  });

  it('maps valid source_kind values onto listDocuments options', async () => {
    const { controller, calls } = makeController();
    await controller.listDocuments(
      { project_id: 'p1', source_kind: 'uploaded', page_index: 0, page_size: 25 },
      meta({ [GW_METADATA.PROJECT_ID]: 'p1' }),
    );
    expect((calls.listDocuments[0].args[1] as Record<string, unknown>).sourceKind).toBe('uploaded');
  });
});
