import { Metadata } from '@grpc/grpc-js';
import { GW_METADATA } from '@fairflow/shared';
import { ChatGrpcController } from './chat.grpc.controller';
import { ChatService } from './chat.service';

describe('DEORG cleanup — chat hierarchy channels', () => {
  it('ListHierarchyChannels ignores overview body and returns empty project scope', async () => {
    const chat = { listHierarchyChannels: jest.fn().mockResolvedValue({ channels: [] }) };
    const ctrl = new ChatGrpcController(chat as unknown as ChatService);
    const md = new Metadata();
    md.set(GW_METADATA.USER_ID, 'u1');
    md.set(GW_METADATA.PROJECT_ID, 'p1');
    await ctrl.listHierarchyChannels({ overview_project_ids: ['p-attacker'] }, md);
    expect(chat.listHierarchyChannels).toHaveBeenCalledWith(expect.anything(), []);
  });
});
