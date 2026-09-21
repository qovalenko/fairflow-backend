import { ObjectId } from 'mongodb';
import type { Db, MongoClient } from 'mongodb';
import { Document, Packer, Paragraph } from 'docx';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { DocumentsService } from './documents.service';
import { DocxValidator } from './docx-validator';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';

/**
 * Documents integration spec (wave 2 — documents-flow).
 *
 * Self-skips via `describeMongoIntegration` unless TEST_MONGO_URL is set. Spins up a
 * throwaway `qa_infra_*` database and wires DocumentsService to REAL Mongo +
 * MongoOutboxStore. Object storage is an in-process Map store implementing the
 * S3Service surface (upload/get/delete/presign) — no MinIO/network IO, but the
 * domain code path is unchanged: template bytes are fetched, sanitized, rendered,
 * uploaded, and compensated on write failure (SEC-C-1).
 *
 * Covers the end-to-end chain:
 *   template upload → createTemplate → publishTemplate → generateDocument
 *   → checkDrift (gateway-supplied hash/values) → markDriftForRecord fan-out
 *   → S3 compensation when the outbox/Mongo write fails after upload.
 */

const BUCKET = 'fairflow-documents-test';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ALL_SCOPE = {
  mode: 'all' as const,
  level: 'all' as const,
  selfId: 'u-1',
  ownerIds: [] as string[],
  sharedRecordIds: [] as string[],
};

interface MongoAdapter {
  templates: () => ReturnType<Db['collection']>;
  templateRevisions: () => ReturnType<Db['collection']>;
  documentGroups: () => ReturnType<Db['collection']>;
  documentVersions: () => ReturnType<Db['collection']>;
  outbox: () => ReturnType<Db['collection']>;
  getClient: () => MongoClient;
}

/** In-process object store — same contract as S3Service for domain writes. */
class InMemoryObjectStore {
  private readonly objects = new Map<string, Buffer>();

  readonly bucketName = BUCKET;

  private key(bucket: string, objectKey: string): string {
    return `${bucket || this.bucketName}/${objectKey}`;
  }

  async uploadObject(
    objectKey: string,
    body: string | Buffer,
    _contentType: string,
  ): Promise<{ bucket: string }> {
    this.objects.set(this.key(this.bucketName, objectKey), Buffer.from(body));
    return { bucket: this.bucketName };
  }

  async deleteObject(bucket: string, objectKey: string): Promise<void> {
    if (!objectKey) return;
    this.objects.delete(this.key(bucket, objectKey));
  }

  async getObjectBuffer(bucket: string, objectKey: string): Promise<Buffer> {
    const buf = this.objects.get(this.key(bucket, objectKey));
    if (!buf) throw new Error(`object not found: ${objectKey}`);
    return buf;
  }

  async presignDownload(
    bucket: string,
    objectKey: string,
    ttlSec = 900,
  ): Promise<{ url: string; expiresAt: number }> {
    return {
      url: `memory://${bucket || this.bucketName}/${objectKey}`,
      expiresAt: Date.now() + ttlSec * 1000,
    };
  }

  hasObject(bucket: string, objectKey: string): boolean {
    return this.objects.has(this.key(bucket, objectKey));
  }

  listKeys(): string[] {
    return [...this.objects.keys()];
  }
}

/** Forces the next withOutbox call to fail (SEC-C-1 compensation probe). */
class FailNextOutboxStore extends MongoOutboxStore {
  private failNext = false;

  armFailure(): void {
    this.failNext = true;
  }

  async withOutbox<R>(
    work: Parameters<MongoOutboxStore['withOutbox']>[0],
  ): Promise<R> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mongo down');
    }
    return super.withOutbox(work) as Promise<R>;
  }
}

async function templateDocxBuffer(text: string): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: [new Paragraph(text)] }] });
  return Packer.toBuffer(doc);
}

function docxFullText(buf: Buffer): string {
  const doc = new Docxtemplater(new PizZip(buf), { paragraphLoop: true, linebreaks: true });
  return doc.getFullText();
}

jest.setTimeout(30_000);

describeMongoIntegration('documents integration (real Mongo + in-memory storage)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;
  let mongo: MongoAdapter;
  let storage: InMemoryObjectStore;
  let outbox: MongoOutboxStore;
  let service: DocumentsService;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('documents');
    client = eph.client;
    db = eph.db;
    close = eph.close;
    mongo = {
      templates: () => db.collection('templates'),
      templateRevisions: () => db.collection('template_revisions'),
      documentGroups: () => db.collection('document_groups'),
      documentVersions: () => db.collection('document_versions'),
      outbox: () => db.collection('event_outbox'),
      getClient: () => client,
    };
    storage = new InMemoryObjectStore();
    outbox = new MongoOutboxStore(mongo as never);
    service = new DocumentsService(
      mongo as never,
      storage as never,
      outbox,
      new DocxValidator(),
    );
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  async function outboxRoutingKeys(projectId: string): Promise<string[]> {
    const rows = await mongo.outbox().find({ projectId }).sort({ createdAt: 1 }).toArray();
    return rows.map((r) => String((r as { routingKey?: string }).routingKey ?? ''));
  }

  /** Seed a template DOCX in storage, register it, and publish revision 1. */
  async function seedPublishedTemplate(
    projectId: string,
    contextType: 'contact' | 'deal' | 'company' | 'order',
    placeholderText: string,
  ): Promise<{ templateId: string; objectKey: string }> {
    const objectKey = `${projectId}/templates/contract.docx`;
    await storage.uploadObject(objectKey, await templateDocxBuffer(placeholderText), DOCX_MIME);

    const tpl = await service.createTemplate(projectId, 'u-1', {
      name: 'Договор',
      context_type: contextType,
      bucket: BUCKET,
      object_key: objectKey,
    });
    await service.publishTemplate(projectId, tpl.id, 'u-1');
    return { templateId: tpl.id, objectKey };
  }

  it('runs template → publish → generate with real Mongo, storage, and outbox rows', async () => {
    const projectId = id('proj');
    const recordId = id('contact');
    const { templateId } = await seedPublishedTemplate(
      projectId,
      'contact',
      'Клиент {{contact.name}} телефон {{contact.phone}}',
    );

    const published = await mongo.templates().findOne({ projectId });
    expect(published?.status).toBe('published');
    expect(published?.currentRevision).toBe(1);

    const revision = await mongo.templateRevisions().findOne({ projectId, templateId, version: 1 });
    expect(revision?.declaredVariables).toEqual(['contact.name', 'contact.phone']);

    const values = { 'contact.name': 'ООО Ромашка', 'contact.phone': '+7-495-000-00-00' };
    const generated = await service.generateDocument(projectId, 'u-1', {
      template_id: templateId,
      context_type: 'contact',
      record_id: recordId,
      values_json: JSON.stringify(values),
      source_hash: 'sha256:initial',
    });

    expect(generated.group?.group_id).toBeTruthy();
    expect(generated.version?.version).toBe(1);
    expect(generated.version?.object_key).toContain(`${projectId}/documents/contact/${recordId}/`);

    const renderedKey = generated.version!.object_key!;
    expect(storage.hasObject(BUCKET, renderedKey)).toBe(true);
    const renderedText = docxFullText(await storage.getObjectBuffer(BUCKET, renderedKey));
    expect(renderedText).toContain('ООО Ромашка');
    expect(renderedText).toContain('+7-495-000-00-00');

    const storedGroup = await mongo.documentGroups().findOne({ projectId });
    expect(storedGroup?.driftStale).toBe(false);
    const storedVersion = await mongo.documentVersions().findOne({ projectId });
    expect(storedVersion?.valuesSnapshot).toEqual(values);
    expect(storedVersion?.sourceHash).toBe('sha256:initial');

    const keys = await outboxRoutingKeys(projectId);
    expect(keys).toContain('document.template_published');
    expect(keys).toContain('document.generated');
  });

  it('checkDrift compares gateway hash/values against the persisted version snapshot', async () => {
    const projectId = id('proj');
    const recordId = id('deal');
    const { templateId } = await seedPublishedTemplate(
      projectId,
      'deal',
      'Сделка {{deal.name}} сумма {{deal.amount}}',
    );

    const gen = await service.generateDocument(projectId, 'u-1', {
      template_id: templateId,
      context_type: 'deal',
      record_id: recordId,
      values_json: JSON.stringify({ 'deal.name': 'Alpha', 'deal.amount': '100' }),
      source_hash: 'sha256:old',
    });
    const groupId = gen.group!.group_id;

    const noDrift = await service.checkDrift(
      projectId,
      groupId,
      {
        sourceHash: 'sha256:old',
        sourceAvailable: true,
        currentValuesJson: JSON.stringify({ 'deal.name': 'Alpha', 'deal.amount': '100' }),
      },
      ALL_SCOPE,
    );
    expect(noDrift.has_drift).toBe(false);

    const drift = await service.checkDrift(
      projectId,
      groupId,
      {
        sourceHash: 'sha256:new',
        sourceAvailable: true,
        currentValuesJson: JSON.stringify({ 'deal.name': 'Alpha', 'deal.amount': '200' }),
      },
      ALL_SCOPE,
    );
    expect(drift.has_drift).toBe(true);
    expect(drift.changed_keys).toEqual(['deal.amount']);
    expect(drift.changed_values).toEqual([
      { key: 'deal.amount', old_value: '100', new_value: '200' },
    ]);
  });

  it('markDriftForRecord flags groups and emits document.drift_detected via outbox', async () => {
    const projectId = id('proj');
    const recordId = id('company');
    const { templateId } = await seedPublishedTemplate(
      projectId,
      'company',
      'Компания {{company.name}}',
    );

    const gen = await service.generateDocument(projectId, 'u-1', {
      template_id: templateId,
      context_type: 'company',
      record_id: recordId,
      values_json: JSON.stringify({ 'company.name': 'Acme' }),
      source_hash: 'sha256:company-v1',
    });
    const groupId = gen.group!.group_id;

    const flagged = await service.markDriftForRecord(projectId, 'company', recordId);
    expect(flagged).toBe(1);

    const group = await mongo.documentGroups().findOne({ _id: new ObjectId(groupId), projectId });
    expect(group?.driftStale).toBe(true);

    const keys = await outboxRoutingKeys(projectId);
    expect(keys).toContain('document.drift_detected');

    const batch = await service.checkDriftBatch(projectId, [groupId], ALL_SCOPE);
    expect(batch.items).toEqual([
      {
        group_id: groupId,
        drift: { has_drift: true, changed_keys: [], source_available: true },
      },
    ]);
  });

  it('compensates storage when Mongo/outbox write fails after generate upload (SEC-C-1)', async () => {
    const projectId = id('proj');
    const recordId = id('contact');
    const { templateId } = await seedPublishedTemplate(projectId, 'contact', 'Hello {{contact.name}}');

    const failingOutbox = new FailNextOutboxStore(mongo as never);
    failingOutbox.armFailure();
    const failingService = new DocumentsService(
      mongo as never,
      storage as never,
      failingOutbox,
      new DocxValidator(),
    );

    const beforeKeys = storage.listKeys().length;

    await expect(
      failingService.generateDocument(projectId, 'u-1', {
        template_id: templateId,
        context_type: 'contact',
        record_id: recordId,
        values_json: JSON.stringify({ 'contact.name': 'X' }),
      }),
    ).rejects.toThrow('mongo down');

    expect(await mongo.documentGroups().countDocuments({ projectId, contextRecordId: recordId })).toBe(0);
    expect(await mongo.documentVersions().countDocuments({ projectId, contextRecordId: recordId })).toBe(0);
    // Uploaded artifact must be removed — net new keys should not remain.
    expect(storage.listKeys().length).toBe(beforeKeys);
  });
});
