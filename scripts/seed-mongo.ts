/**
 * Same as contact/scripts/seed-mongo.ts — run from services root:
 * npm run db:seed:mongo
 */
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { MongoClient } from 'mongodb';

const servicesRoot = path.resolve(__dirname, '..');
loadEnv({ path: path.join(servicesRoot, '.fairflow-dev.env') });
loadEnv({ path: path.join(servicesRoot, '.env') });

const PROJECT_ID = process.env.DEV_PROJECT_ID?.trim();
const MONGODB_URI = process.env.MONGODB_URI?.trim();

const contacts = [
  { firstName: 'Иван', lastName: 'Петров', email: 'ivan@example.com', phone: '+7 999 111-22-33', position: 'Директор' },
  { firstName: 'Мария', lastName: 'Сидорова', email: 'maria@example.com', phone: '+7 999 222-33-44', position: 'Менеджер' },
  { firstName: 'Алексей', lastName: 'Козлов', email: 'alex@example.com', phone: '+7 999 333-44-55', position: 'Бухгалтер' },
];

const companies = [
  { name: 'ООО Ромашка', inn: '7707123456', legalAddress: 'г. Москва, ул. Примерная, 1', email: 'info@romashka.ru' },
  { name: 'ИП Иванов', inn: '770798765432', legalAddress: 'г. Москва, ул. Тестовая, 2', email: 'ip@example.com' },
];

async function main() {
  if (!PROJECT_ID) {
    console.error('DEV_PROJECT_ID is required. Run npm run db:provision first or set DEV_PROJECT_ID.');
    process.exit(1);
  }
  if (!MONGODB_URI) {
    console.error('MONGODB_URI is required.');
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();
  const now = new Date();

  const contactsCol = db.collection('contacts');
  for (const c of contacts) {
    await contactsCol.insertOne({
      projectId: PROJECT_ID,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      position: c.position,
      companyIds: [],
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  console.log('Inserted', contacts.length, 'contacts for project', PROJECT_ID);

  const companiesCol = db.collection('companies');
  for (const c of companies) {
    await companiesCol.insertOne({
      projectId: PROJECT_ID,
      name: c.name,
      inn: c.inn,
      legalAddress: c.legalAddress,
      email: c.email,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  console.log('Inserted', companies.length, 'companies for project', PROJECT_ID);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
