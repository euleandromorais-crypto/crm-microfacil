import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';

migrate()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end();
    process.exit(1);
  });
