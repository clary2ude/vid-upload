'use strict';

const { LRUCache } = require('lru-cache');
const Video = require('../models/Video');
const UserbotAccount = require('../models/UserbotAccount');
const { channelCache } = require('../cache');
const { queryCache, rateLimited } = require('../queue/rateLimit');
const { parseCaptionNumber } = require('./captions');

const BOT_KEY = String(process.env.CURRENT_BOT_KEY || (process.env.BOT_TOKEN || '').split(':')[0] || 'default').trim();

const pendingPromiseCache = new LRUCache({ max: 1000, ttl: 60 * 1000 });

function resolveChatPeer(bot, chatId) {
  return chatId;
}

async function findVideoByCaption(captionNumber) {
  if (captionNumber == null) return null;
  const n = Number(captionNumber);
  if (!Number.isSafeInteger(n)) return null;

  const cacheKey = `vid:${n}`;
  const cached = queryCache.get(cacheKey);
  if (cached) return cached;

  const pending = pendingPromiseCache.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const row = await Video.findOne({ caption_number: n }).lean();
      if (row) queryCache.set(cacheKey, row);
      return row || null;
    } catch (err) {
      console.error('[delivery] findVideoByCaption DB error:', err.message);
      return null;
    } finally {
      pendingPromiseCache.delete(cacheKey);
    }
  })();
  pendingPromiseCache.set(cacheKey, promise);
  return promise;
}

async function hasActiveUserbot() {
  try {
    const row = await UserbotAccount.findOne({ session: { $ne: null, $exists: true } })
      .select('_id')
      .limit(1)
      .lean();
    return !!row;
  } catch (err) {
    console.error('[delivery] hasActiveUserbot error:', err.message);
    return false;
  }
}

async function hotSendVideo(bot, chatId, row) {
  try {
    const botKey = BOT_KEY;
    const fid = row && row.bot_file_ids ? row.bot_file_ids[botKey] : null;
    if (!fid) return { ok: false, reason: 'no_file_id' };

    return await rateLimited(async () => {
      try {
        const msg = await bot.telegram.sendVideo(chatId, fid, { supports_streaming: true });
        return { ok: true, via: 'hot_sendVideo', message: msg };
      } catch (err) {
        return { ok: false, reason: 'sendVideo_failed', error: err };
      }
    });
  } catch (err) {
    return { ok: false, reason: 'rate_limit_wrap_error', error: err };
  }
}

async function coldForwardAndSeed(bot, chatId, row) {
  try {
    if (!row || !row.source || !row.source.channel_id || !row.source.message_id) {
      return { ok: false, reason: 'missing_source' };
    }
    if (!channelCache.isApproved(String(row.source.channel_id))) {
      return { ok: false, reason: 'channel_unapproved' };
    }

    const msg = await rateLimited(async () => {
      try {
        return await bot.telegram.copyMessage(chatId, row.source.channel_id, row.source.message_id, {
          disable_notification: true,
        });
      } catch (forwardErr) {
        // fall back to forwardMessage if copy fails
        try {
          return await bot.telegram.forwardMessage(chatId, row.source.channel_id, row.source.message_id, {
            disable_notification: true,
          });
        } catch (err) {
          return null;
        }
      }
    });

    if (!msg) return { ok: false, reason: 'copy_or_forward_failed' };

    const extracted = msg && msg.video ? msg.video.file_id : null;
    if (extracted) {
      try {
        const botKey = BOT_KEY;
        const updated = await Video.findOneAndUpdate(
          { _id: row._id },
          { $set: { [`bot_file_ids.${botKey}`]: extracted, last_seen_at: new Date() } },
          { new: true }
        ).lean();
        if (updated) queryCache.set(`vid:${Number(updated.caption_number)}`, updated);
      } catch (err) {
        console.error('[delivery] cold seed file_id error:', err.message);
      }
    }

    return { ok: true, via: 'cold_copy_forward', delivered: !!msg };
  } catch (err) {
    console.error('[delivery] coldForwardAndSeed error:', err.message);
    return { ok: false, reason: 'cold_error', error: err };
  }
}

async function userbotDirectFallback(row, chatId) {
  try {
    // Plan 4 / 5 require logged-in userbot session in DB.
    // If missing, fail silently per requirements.
    const ok = await hasActiveUserbot();
    if (!ok) {
      console.warn('[delivery] userbot fallback skipped: no userbot session in DB (plan 4/5 silent).');
      return { ok: false, reason: 'no_userbot_session' };
    }
    // userbot engine hook reserved for future gramjs worker; silent no-op for now.
    return { ok: false, reason: 'userbot_engine_stub' };
  } catch (err) {
    console.error('[delivery] userbotDirectFallback error:', err.message);
    return { ok: false, reason: 'userbot_error', error: err };
  }
}

async function deliverVideoForQuery(bot, chatId, userText) {
  try {
    if (!userText) return { delivered: false, reason: 'no_input' };
    const n = parseCaptionNumber(userText);
    if (n == null || n <= 0) return { delivered: false, reason: 'bad_input' };

    if (channelCache.countApproved() === 0) {
      // silent on user-facing path per requirement
      return { delivered: false, reason: 'no_approved_channels_silent' };
    }

    const row = await findVideoByCaption(n);
    if (!row) return { delivered: false, reason: 'not_found' };

    if (row.source && row.source.channel_id && !channelCache.isApproved(String(row.source.channel_id))) {
      // silently refuse to deliver from unapproved/removed channels
      return { delivered: false, reason: 'video_channel_unapproved_silent' };
    }

    let res = await hotSendVideo(bot, chatId, row);
    if (res && res.ok) return { delivered: true, via: res.via };

    res = await coldForwardAndSeed(bot, chatId, row);
    if (res && res.ok) return { delivered: true, via: res.via };

    res = await userbotDirectFallback(row, chatId);
    if (res && res.ok) return { delivered: true, via: 'userbot_direct' };

    return { delivered: false, reason: 'all_paths_exhausted' };
  } catch (err) {
    console.error('[delivery] deliverVideoForQuery error:', err?.stack || err?.message || err);
    return { delivered: false, reason: 'internal_error' };
  }
}

module.exports = {
  BOT_KEY,
  findVideoByCaption,
  hotSendVideo,
  coldForwardAndSeed,
  userbotDirectFallback,
  deliverVideoForQuery,
  hasActiveUserbot,
};
