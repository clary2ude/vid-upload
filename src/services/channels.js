'use strict';

const UploadChannel = require('../models/UploadChannel');
const { channelCache } = require('../cache');

function normalizeChannelId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^@/.test(s)) return s.toLowerCase();
  if (/^-?\d+$/.test(s)) return s;
  return s;
}

function normalizeChatIdForCompare(chatId) {
  const s = String(chatId || '').trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return s;
  return s.toLowerCase();
}

function sameChannel(a, b) {
  return normalizeChatIdForCompare(a) === normalizeChatIdForCompare(b);
}

async function syncChannelCache() {
  try {
    const all = await UploadChannel.find().lean();
    channelCache.set(all);
    return all;
  } catch (err) {
    console.error('[channels] sync cache error:', err.message);
    return [];
  }
}

async function upsertChannelFromChat(chat, addedByUserId) {
  try {
    if (!chat || !chat.id) return null;
    const id = normalizeChannelId(chat.id);
    if (!id) return null;

    const existing = await UploadChannel.findOne({
      $or: [
        { channelId: id },
        chat.username ? { username: normalizeChannelId(chat.username) } : { _id: null },
      ],
    });

    let doc;
    if (existing) {
      let changed = false;
      if (chat.title && existing.title !== chat.title) {
        existing.title = chat.title;
        changed = true;
      }
      if (chat.username && existing.username !== normalizeChannelId(chat.username)) {
        existing.username = normalizeChannelId(chat.username);
        changed = true;
      }
      if (changed) doc = await existing.save();
      else doc = existing;
    } else {
      doc = await UploadChannel.create({
        channelId: id,
        title: chat.title || null,
        username: chat.username ? normalizeChannelId(chat.username) : null,
        isApproved: false,
        addedBy: addedByUserId || null,
      });
    }

    await syncChannelCache();
    return doc.toObject ? doc.toObject() : doc;
  } catch (err) {
    console.error('[channels] upsertFromChat error:', err.message);
    return null;
  }
}

async function setApproved(channelDocId, isApproved) {
  try {
    const doc = await UploadChannel.findByIdAndUpdate(
      channelDocId,
      { $set: { isApproved: !!isApproved } },
      { new: true }
    ).lean();
    await syncChannelCache();
    return doc;
  } catch (err) {
    console.error('[channels] setApproved error:', err.message);
    return null;
  }
}

async function deleteById(channelDocId) {
  try {
    await UploadChannel.findByIdAndDelete(channelDocId);
    await syncChannelCache();
    return true;
  } catch (err) {
    console.error('[channels] deleteById error:', err.message);
    return false;
  }
}

async function updateTitle(channelDocId, title) {
  try {
    const doc = await UploadChannel.findByIdAndUpdate(
      channelDocId,
      { $set: { title: String(title || '').slice(0, 200) } },
      { new: true }
    ).lean();
    await syncChannelCache();
    return doc;
  } catch (err) {
    console.error('[channels] updateTitle error:', err.message);
    return null;
  }
}

async function getApprovedChannelIdsSet() {
  if (channelCache.countApproved() > 0) return channelCache;
  await syncChannelCache();
  return channelCache;
}

function isDeliveryEligible(channelId) {
  const cache = channelCache;
  if (cache.countApproved() === 0) return false;
  return cache.isApproved(channelId);
}

module.exports = {
  normalizeChannelId,
  normalizeChatIdForCompare,
  sameChannel,
  syncChannelCache,
  upsertChannelFromChat,
  setApproved,
  deleteById,
  updateTitle,
  getApprovedChannelIdsSet,
  isDeliveryEligible,
};
