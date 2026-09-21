import { jsonToStruct, structToJson } from './grpc-struct';
import {
  decodeGrpcModulePolicies,
  decodeGrpcProject,
  encodeGrpcModulePolicies,
} from './project-grpc.codec';

describe('project-grpc.codec', () => {
  const condition = { op: 'eq', left: { ref: 'record.ownerId' }, right: { ref: 'user.id' } };

  it('round-trips module_policies condition through encode/decode', () => {
    const encoded = encodeGrpcModulePolicies([
      {
        id: 'r1',
        module_id: 'deals',
        effect: 'allow',
        subject: 'deals',
        action: 'read',
        condition,
      },
    ]);
    const decoded = decodeGrpcModulePolicies(encoded);
    expect(decoded[0].condition).toEqual(condition);
  });

  it('decodes Struct wire personal_settings on full project payload', () => {
    const project = decodeGrpcProject({
      id: 'p1',
      module_configs: [
        {
          module_id: 'search',
          personal_settings: jsonToStruct({ minQueryChars: 4 }),
        },
      ],
      module_policies: [
        {
          id: 'r1',
          module_id: 'deals',
          condition: jsonToStruct(condition),
        },
      ],
    });
    expect(project.module_configs?.[0]?.personal_settings).toEqual({ minQueryChars: 4 });
    expect(project.module_policies?.[0]?.condition).toEqual(condition);
  });

  it('tolerates already-plain maps from older peers', () => {
    expect(structToJson({ minQueryChars: 2 })).toEqual({ minQueryChars: 2 });
  });
});
