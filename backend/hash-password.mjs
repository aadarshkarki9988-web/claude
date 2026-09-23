// Generates the ADMIN_PASSWORD_HASH value for the Worker secret.
// Usage:  node hash-password.mjs <password>
// Then:   npx wrangler secret put ADMIN_PASSWORD_HASH   (paste the printed string)
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('Usage: node hash-password.mjs <password>');
  process.exit(1);
}
const iterations = 100000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
console.log(`pbkdf2-sha256$${iterations}$${salt.toString('hex')}$${hash.toString('hex')}`);