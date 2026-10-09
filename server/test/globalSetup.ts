import pg from 'pg';

/** Recria o banco de testes do zero a cada execução */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
}
