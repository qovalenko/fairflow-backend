/**
 * TODO-449 — `PUT /projects/:id/modules/:moduleId/settings` must not RMW the full
 * project via `getProject` + `updateProject` (lost concurrent module saves), and
 * must speak the Struct wire format (a plain map serializes to an EMPTY Struct —
 * see control/src/grpc/module-settings-struct.spec.ts).
 */
import { of } from 'rxjs';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { CommonBffController } from './common-bff.controller';
import { jsonToStruct } from './grpc-struct';

function stubClient(service: Record<string, unknown> = {}): ClientGrpcProxy {
  return { getService: () => service } as unknown as ClientGrpcProxy;
}

function makeController(project: Record<string, unknown>) {
  const ctrl = new CommonBffController(
    stubClient(),
    stubClient(),
    stubClient(),
    stubClient(project),
    { build: () => ({}) } as never,
    { publishBadge: jest.fn(), subscribe: jest.fn() } as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

describe('CommonBffController module settings (TODO-449)', () => {
  it('PUT calls SetModulePersonalSettings with Struct-encoded settings, no full-project RMW', async () => {
    const setModulePersonalSettings = jest.fn((_r: unknown, _m?: unknown) =>
      of({ personal_settings: jsonToStruct({ minQueryChars: 5 }) }),
    );
    const updateProject = jest.fn();
    const getProject = jest.fn();
    const ctrl = makeController({ setModulePersonalSettings, getProject, updateProject });

    const req = { user: { userId: 'u1' }, headers: {} } as never;
    const res = await ctrl.putModuleSettings(req, 'p1', 'search', {
      minQueryChars: 5,
    });

    expect(setModulePersonalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'p1',
        module_id: 'search',
        // Wire format, NOT the plain map — the serializer drops a plain map.
        personal_settings: jsonToStruct({ minQueryChars: 5 }),
        actor_user_id: 'u1',
      }),
      expect.anything(),
    );
    expect(getProject).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
    // Echo is decoded back to the plain map for the FE.
    expect(res).toEqual({ minQueryChars: 5 });
  });

  it('GET reads via GetModulePersonalSettings and decodes the Struct', async () => {
    const getModulePersonalSettings = jest.fn((_r: unknown, _m?: unknown) =>
      of({ personal_settings: jsonToStruct({ minQueryChars: 4, indexableTypes: ['contact'] }) }),
    );
    const getProject = jest.fn();
    const ctrl = makeController({ getModulePersonalSettings, getProject });

    const req = { user: { userId: 'u1' }, headers: {} } as never;
    const res = await ctrl.getModuleSettings(req, 'p1', 'search');

    expect(getModulePersonalSettings).toHaveBeenCalledWith(
      { project_id: 'p1', module_id: 'search' },
      expect.anything(),
    );
    expect(getProject).not.toHaveBeenCalled();
    expect(res).toEqual({ minQueryChars: 4, indexableTypes: ['contact'] });
  });
});
