import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ensureDefaults } from '../db/defaults.js';
import { migrate } from '../db/migrate.js';
import { pool, queryOne } from '../db/pool.js';

/**
 * Instalação inicial: aplica migrations, cria configurações padrão e o primeiro administrador.
 * Uso não interativo: npm run setup -- --name "Fulano" --email admin@empresa.com --password "Senha123"
 */
function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : process.env[`ADMIN_${name.toUpperCase()}`];
}

async function main() {
  await migrate();
  await ensureDefaults();
  console.log('Configurações padrão verificadas (funil, motivos de perda, automações-base).');
  const admin = await queryOne(`SELECT email FROM users WHERE role='admin' AND active LIMIT 1`);
  if (admin && !process.argv.includes('--force-admin')) {
    console.log(`Administrador já existe (${admin.email}). Nada mais a fazer.`);
    return;
  }
  let name = arg('name');
  let email = arg('email');
  let password = arg('password');
  if (!name || !email || !password) {
    const rl = createInterface({ input: stdin, output: stdout });
    name = name || (await rl.question('Nome do administrador: '));
    email = email || (await rl.question('E-mail do administrador: '));
    password = password || (await rl.question('Senha (mín. 8, letras e números): '));
    rl.close();
  }
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Nome/e-mail inválidos');
  if (!password || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error('Senha fraca: use ao menos 8 caracteres com letras e números');
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, active) VALUES ($1,$2,$3,'admin',true)
     ON CONFLICT ((lower(email))) DO UPDATE SET role='admin', active=true, password_hash=EXCLUDED.password_hash`,
    [name.trim(), email.trim().toLowerCase(), await bcrypt.hash(password, 12)],
  );
  console.log(`Administrador ${email} criado. Acesse o sistema e altere a senha se necessário.`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Falha na instalação:', err.message);
    await pool.end();
    process.exit(1);
  });
