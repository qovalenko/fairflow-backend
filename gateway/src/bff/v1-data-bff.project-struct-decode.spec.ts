/**
 * GAP-STRUCT-PROJECT-READ (round 2 review): EVERY REST endpoint returning a
 * control `Project` payload must decode the Struct-typed fields
 * (`personal_settings`, `integration_settings`, `module_policies[].condition`).
 *
 * The FE seeds Settings/ModulesTab state from GET /v1/projects (and /auth/me)
 * and PATCHes that state back on a module toggle — a raw Struct wire shape
 * leaked from ANY of these endpoints gets double-encoded on save and corrupts
 * the stored module settings / ABAC conditions. GET/PATCH alone are not enough:
 * list, create and all lifecycle responses go through the same `mapProject`.
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { V1DataBffController } from './v1-data-bff.controller';
import { jsonToStruct } from './grpc-struct';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function build(project: Record<string, unknown>) {
  const outboundMeta = { build: () => ({}) } as never;
  const ctrl = new V1DataBffController(
    stubClient(project),
    stubClient(),
    stubClient(),
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

const SETTINGS = { minQueryChars: 4 };
const CONDITION = { op: 'eq', left: { ref: 'record.ownerId' }, right: { ref: 'user.id' } };

/** Project payload as the gateway gRPC client actually receives it after
 * control's mapProject Struct-encoding. */
const wireProject = () => ({
  id: 'p1',
  name: 'Alpha',
  status: 'active',
  effective_modules: ['deals', 'search'],
  module_configs: [
    {
      module_id: 'search',
      enabled: true,
      personal_settings: jsonToStruct(SETTINGS),
      integration_settings: jsonToStruct({}),
    },
  ],
  module_policies: [
    {
      id: 'r1',
      module_id: 'deals',
      effect: 'allow',
      subject: 'deals',
      action: 'read',
      resource: '*',
      condition: jsonToStruct(CONDITION),
    },
  ],
});

type DecodedProject = {
  module_configs?: Array<{ personal_settings?: unknown }>;
  module_policies?: Array<{ condition?: unknown }>;
};

function expectDecoded(project: DecodedProject) {
  expect(project.module_configs?.[0]?.personal_settings).toEqual(SETTINGS);
  expect(project.module_policies?.[0]?.condition).toEqual(CONDITION);
}

const req = { headers: {}, user: { userId: 'u1' }, __systemOrgId: 'org1' } as never;

describe('project Struct fields are decoded on every REST leg', () => {
  it('GET /v1/projects (list) decodes each project', async () => {
    const ctrl = build({ listMyProjects: jest.fn(() => of({ list: [wireProject()] })) });
    const res = (await ctrl.projects(req, 'u1', '', '')) as DecodedProject[];
    expectDecoded(res[0]);
  });

  it('GET /v1/projects (list) passes through template_id (FR-PSET-330)', async () => {
    const ctrl = build({
      listMyProjects: jest.fn(() => of({ list: [{ ...wireProject(), template_id: 'b2b-sales' }] })),
    });
    const res = (await ctrl.projects(req, 'u1', '', '')) as Array<{ template_id?: string }>;
    expect(res[0].template_id).toBe('b2b-sales');
  });

  it('POST /v1/projects (create) decodes the response', async () => {
    const ctrl = build({ createProject: jest.fn(() => of(wireProject())) });
    const res = (await ctrl.createProject(req, { name: 'Alpha' })) as DecodedProject;
    expectDecoded(res);
  });

  it('DELETE /v1/projects/:id (archive) decodes the response', async () => {
    const ctrl = build({ archiveProject: jest.fn(() => of(wireProject())) });
    const res = (await ctrl.archiveProject(req, 'p1')) as DecodedProject;
    expectDecoded(res);
  });

  it('POST /v1/projects/:id/unarchive decodes the response', async () => {
    const ctrl = build({ archiveProject: jest.fn(() => of(wireProject())) });
    const res = (await ctrl.unarchiveProject(req, 'p1')) as DecodedProject;
    expectDecoded(res);
  });

  it('POST /v1/projects/:id/request-deletion decodes the response', async () => {
    const ctrl = build({ requestProjectDeletion: jest.fn(() => of(wireProject())) });
    const res = (await ctrl.requestProjectDeletion(req, 'p1', {
      confirmName: 'Alpha',
    })) as DecodedProject;
    expectDecoded(res);
  });

  it('POST /v1/projects/:id/restore decodes the response', async () => {
    const ctrl = build({ restoreProject: jest.fn(() => of(wireProject())) });
    const res = (await ctrl.restoreProject(req, 'p1')) as DecodedProject;
    expectDecoded(res);
  });

  it('POST /v1/projects/:id/apply-template decodes the response', async () => {
    const ctrl = build({ applyTemplate: jest.fn(() => of(wireProject())) });
    const res = (await ctrl.applyTemplate(req, 'p1', { templateId: 't1' })) as DecodedProject;
    expectDecoded(res);
  });
});
