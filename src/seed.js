'use strict';

require('dotenv').config({ override: true });
const connectDB = require('./db');
const Admin = require('./models/Admin');

async function seedSuperAdminFromEnv() {
  const superId = Number(process.env.SUPERADMIN || 0);
  if (!Number.isFinite(superId) || superId <= 0) {
    console.warn('[seed] SUPERADMIN env missing or invalid — skip seed.');
    return;
  }
  const existing = await Admin.findOne({ telegramId: superId });
  if (!existing) {
    await Admin.create({
      telegramId: superId,
      username: null,
      isSuperAdmin: true,
      addedBy: superId,
    });
    console.log(`[seed] Superadmin seeded: telegramId=${superId}`);
    return;
  }
  let changed = false;
  if (!existing.isSuperAdmin) {
    existing.isSuperAdmin = true;
    changed = true;
  }
  if (changed) {
    await existing.save();
    console.log(`[seed] Superadmin promoted: telegramId=${superId}`);
  } else {
    console.log(`[seed] Superadmin already in place: telegramId=${superId}`);
  }
}

async function seed() {
  await connectDB();
  await seedSuperAdminFromEnv();
  console.log('[seed] complete.');
  process.exit(0);
}

module.exports = { seedSuperAdminFromEnv };

if (require.main === module) {
  seed().catch((err) => {
    console.error('[seed] error:', err.message);
    process.exit(1);
  });
}
