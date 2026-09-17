'use strict';

const Admin = require('../models/Admin');
const UploadChannel = require('../models/UploadChannel');
const { adminCache, channelCache } = require('../cache');

module.exports = async (ctx, next) => {
  try {
    if (!ctx.from) return next();
    const { id, username } = ctx.from;

    if (adminCache.getAll().length === 0) {
      try {
        const all = await Admin.find().lean();
        adminCache.set(all);
      } catch (err) {
        console.error('[auth] admin cache reload error:', err.message);
      }
    }

    if (channelCache.getAll().length === 0) {
      try {
        const all = await UploadChannel.find().lean();
        channelCache.set(all);
      } catch (err) {
        console.error('[auth] channel cache reload error:', err.message);
      }
    }

    ctx.state.isAdmin = adminCache.isAdmin(id, username);
    ctx.state.isSuperAdmin = adminCache.isSuperAdmin(id, username);

    if (ctx.state.isAdmin && username) {
      try {
        const doc = await Admin.findOne({ username: `@${username}`, telegramId: null });
        if (doc) {
          doc.telegramId = id;
          await doc.save();
          const all = await Admin.find().lean();
          adminCache.set(all);
        }
      } catch (err) {
        console.error('[auth] admin backfill error:', err.message);
      }
    }

    return next();
  } catch (err) {
    console.error('[auth] middleware fatal error:', err.message);
    return next();
  }
};
