/**
 * Integration closure wave — group "docs" (#59, #60).
 *
 * #59: local documents → the box stand chat IsConversationMember before presign (SEC-C-3).
 * #60: the box stand orders → the box stand documents GetTemplate on order-type spec save.
 */
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ObjectId } from 'mongodb';
import {
  archiveBoxTestProjectViaControl,
  BoxMongoReader,
  createBoxTestProjectViaControl,
  createClosureDocumentsGrpcClient,
  createClosureOrdersGrpcClient,
  describeBoxIntegration,
  gatewayMetadataCtx,
  LOCAL_DOCUMENTS_GRPC_URL,
  resolveBoxActorUserId,
  startLocalDocumentsService,
  stopLocalDocumentsService,
  uniqueBoxName,
} from '@fairflow/testing';

jest.setTimeout(120_000);

describeBoxIntegration('group-docs the box stand (documents local for #59, peers for #60)', () => {
  let documentsLocal: ReturnType<typeof createClosureDocumentsGrpcClient>;
  let orders: ReturnType<typeof createClosureOrdersGrpcClient>;
  let mongo: BoxMongoReader;
  let actorUserId: string;
  let projectId: string;
  const mdCtx = () => gatewayMetadataCtx(projectId, actorUserId);

  beforeAll(async () => {
    await startLocalDocumentsService();
    actorUserId = await resolveBoxActorUserId();
    documentsLocal = createClosureDocumentsGrpcClient(LOCAL_DOCUMENTS_GRPC_URL);
    orders = createClosureOrdersGrpcClient();
    mongo = await BoxMongoReader.connect();
  }, 150_000);

  afterAll(async () => {
    documentsLocal.close();
    orders.close();
    await stopLocalDocumentsService();
    await mongo.close();
  });

  beforeEach(async () => {
    projectId = await createBoxTestProjectViaControl(
      ['deals', 'contacts', 'orders', 'documents', 'chat'],
      actorUserId,
    );
  });

  afterEach(async () => {
    if (projectId) await archiveBoxTestProjectViaControl(projectId, actorUserId).catch(() => undefined);
  });

  it('#59: documents calls chat IsConversationMember and denies non-member before presign', async () => {
    const groupId = new ObjectId();
    const versionId = new ObjectId();
    const conversationId = '000000000000000000000099';
    const now = Date.now();

    await mongo.db.collection('document_groups').insertOne({
      _id: groupId,
      id: groupId.toString(),
      projectId,
      name: 'chat-attach',
      createdAt: now,
      updatedAt: now,
    });
    await mongo.db.collection('document_versions').insertOne({
      _id: versionId,
      id: versionId.toString(),
      projectId,
      documentGroupId: groupId.toString(),
      contextType: 'chat',
      contextRecordId: conversationId,
      objectKey: `${projectId}/chat/${conversationId}/probe.docx`,
      bucket: 'fairflow-documents',
      version: 1,
      createdAt: now,
    });

    await expect(
      documentsLocal.getDownloadUrl(
        { project_id: projectId, version_id: versionId.toString(), ttl_sec: 600 },
        mdCtx(),
      ),
    ).rejects.toMatchObject({ code: GrpcStatus.NOT_FOUND });
  });

  it('#60: orders validates document template via documents GetTemplate on the box stand', async () => {
    const templateId = new ObjectId();
    const ghostId = new ObjectId();
    const now = Date.now();
    await mongo.db.collection('templates').insertOne({
      _id: templateId,
      projectId,
      name: uniqueBoxName('order-spec-tpl'),
      contextType: 'order',
      currentRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await mongo.db.collection('template_revisions').insertOne({
      projectId,
      templateId: templateId.toString(),
      version: 1,
      status: 'published',
      createdAt: now,
    });

    const minimalStages = [{ id: 's1', name: 'Start', order: 0, is_terminal: true }];
    const created = await orders.createOrderType(
      {
        project_id: projectId,
        spec: {
          name: uniqueBoxName('order-type'),
          stages: minimalStages,
          fields: [],
        },
      },
      mdCtx(),
    );
    const orderTypeId = String(created.id ?? created.order_type_id);

    await expect(
      orders.updateOrderType(
        {
          project_id: projectId,
          id: orderTypeId,
          spec: {
            name: String(created.name ?? 'order-type'),
            stages: minimalStages,
            fields: [],
            document_templates_json: JSON.stringify([{ templateId: ghostId.toString() }]),
          },
        },
        mdCtx(),
      ),
    ).rejects.toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT });

    const updated = await orders.updateOrderType(
      {
        project_id: projectId,
        id: orderTypeId,
        spec: {
          name: String(created.name ?? 'order-type'),
          stages: minimalStages,
          fields: [],
          document_templates_json: JSON.stringify([{ templateId: templateId.toString() }]),
        },
      },
      mdCtx(),
    );
    const revision = (updated.revision ?? updated.current_revision ?? updated) as Record<string, unknown>;
    const templates = JSON.parse(String(revision.document_templates_json ?? '[]')) as Array<{
      templateId?: string;
    }>;
    expect(templates.map((t) => t.templateId)).toContain(templateId.toString());
  });
});
