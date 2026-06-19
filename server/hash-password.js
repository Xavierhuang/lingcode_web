'use strict';
/**
 * Usage (from website/server): node hash-password.js 'your-long-password'
 * Put output in .env as ADMIN_PASSWORD_HASH=...
 */
const bcrypt = require('bcrypt');
const p = process.argv[2];
if (!p) {
  console.error('Usage: node hash-password.js <password>');
  process.exit(1);
}
console.log(bcrypt.hashSync(p, 12));
