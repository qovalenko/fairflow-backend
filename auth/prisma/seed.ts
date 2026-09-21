import { seedPostgres } from '../../scripts/postgres-seed';

void seedPostgres().catch((e) => {
  console.error(e);
  process.exit(1);
});
