'use strict';

// In-memory caches (auth-only, never on hot paths never touch DB
let admins = [];
let approvedChannelIds = new Set();
let approvedChannelRows = [];

const adminCache = {
  set(list) {
    admins = list || [];
  },
  getAll() {
    return admins;
  },
  isAdmin(telegramId, username) {
    return admins.some((a) => {
      if (telegramId != null && a.telegramId != null && Number(a.telegramId) === Number(telegramId)) return true;
      if (username && a.username) {
        const norm = (x) => String(x || '').toLowerCase().replace(/^@/, '');
        return norm(a.username) === norm(username);
      }
      return false;
    });
  },
  isSuperAdmin(telegramId, username) {
    return admins.some((a) => {
      if (!a.isSuperAdmin) return false;
      if (telegramId != null && a.telegramId != null && Number(a.telegramId) === Number(telegramId)) return true;
      if (username && a.username) {
        const norm = (x) => String(x || '').toLowerCase().replace(/^@/, '');
        return norm(a.username) === norm(username);
      }
      return false;
    });
  },
  add(admin) {
    if (admin) admins.push(admin);
  },
  removeById(telegramId) {
    const id = Number(telegramId);
    admins = admins.filter((a) => Number(a.telegramId) !== id);
  },
  removeByUsername(username) {
    const norm = (x) => String(x || '').toLowerCase().replace(/^@/, '');
    const t = norm(username);
    admins = admins.filter((a) => !a.username || norm(a.username) !== t);
  },
};

const channelCache = {
  set(list) {
    approvedChannelRows = list || [];
    approvedChannelIds = new Set(
      (list || []).filter((c) => c && c.isApproved && c.channelId).map((c) => String(c.channelId))
    );
  },
  getAll() {
    return approvedChannelRows;
  },
  isApproved(channelId) {
    return approvedChannelIds.has(String(channelId));
  },
  countApproved() {
    return approvedChannelIds.size;
  },
};

module.exports = { adminCache, channelCache };
