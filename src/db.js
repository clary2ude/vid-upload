'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

async function connectDB() {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        dbName: process.env.DB_NAME || 'pboxupload',
      });
      console.log(`[DB] MongoDB connected → DB: ${mongoose.connection.db.databaseName}`);
      return;
    } catch (err) {
      const delay = Math.min(5000 * attempt, 30000);
      console.error(`[DB] Connection failed (attempt ${attempt}), retrying in ${delay / 1000}s: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = connectDB;
