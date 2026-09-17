'use strict';

const Counter = require('../models/Counter');
const Video = require('../models/Video');
const UserbotAccount = require('../models/UserbotAccount');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { rateLimited } = require('../queue/rateLimit');

const ALLOWED_DIGIT_LEN = [1, 2, 3, 4, 5];

function parseCaptionNumber(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function isAllowedManualCaption(n) {
  if (n == null || Number.isNaN(n)) return false;
  if (n <= 0) return false;
  const digits = String(Math.abs(n)).length;
  return ALLOWED_DIGIT_LEN.includes(digits);
}

async function getNextAutoCaption() {
  try {
    const updated = await Counter.findOneAndUpdate(
      { name: 'video_caption_seq' },
      { $inc: { value: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    const base = updated ? Number(updated.value) : 1;
    if (!Number.isSafeInteger(base) || base < 1) return 1;
    return base;
  } catch (err) {
    console.error('[captions] getNextAutoCaption error:', err.message);
    try {
      const max = await Video.find().sort({ caption_number: -1 }).limit(1).select('caption_number').lean();
      const top = max && max[0] ? Number(max[0].caption_number) : 0;
      return Number.isSafeInteger(top) ? top + 1 : 1;
    } catch (err2) {
      console.error('[captions] fallback seq error:', err2.message);
      return 1;
    }
  }
}

async function allocateCaption(manualText) {
  const manualN = parseCaptionNumber(manualText);
  if (manualN != null && isAllowedManualCaption(manualN)) {
    try {
      const exists = await Video.findOne({ caption_number: manualN }).select('_id').lean();
      if (!exists) return manualN;
    } catch (err) {
      console.error('[captions] manual collision check error:', err.message);
    }
  }

  for (let i = 0; i < 25; i += 1) {
    const n = await getNextAutoCaption();
    if (!Number.isSafeInteger(n) || n <= 0) continue;
    const exists = await Video.findOne({ caption_number: n }).select('_id').lean();
    if (!exists) return n;
  }

  const start = Date.now();
  while (true) {
    const probe = Math.floor(1_000_000 + Math.random() * 9_000_000);
    const exists = await Video.findOne({ caption_number: probe }).select('_id').lean();
    if (!exists) return probe;
    if (Date.now() - start > 2500) {
      throw new Error('exhausted caption allocator');
    }
  }
}

async function replyCaptionInChannel(telegram, channelChatId, replyToMessageId, captionNumber) {
  try {
    await rateLimited(async () => {
      try {
        return await telegram.sendMessage(channelChatId, String(captionNumber), {
          reply_to_message_id: replyToMessageId,
          disable_web_page_preview: true,
          disable_notification: true,
        });
      } catch (err) {
        // silently skip reply failures
        console.error('[captions] channel reply error:', err.message);
        return null;
      }
    });
  } catch (err) {
    console.error('[captions] rate limited reply error:', err.message);
  }
}

async function tryBotEditCaption(telegram, channelChatId, messageId, newCaption) {
  try {
    return await rateLimited(async () => {
      try {
        const res = await telegram.editMessageCaption(channelChatId, messageId, {
          caption: String(newCaption),
        });
        return !!res;
      } catch (err) {
        console.error('[captions] bot edit caption error:', err.message);
        return false;
      }
    });
  } catch (err) {
    console.error('[captions] bot edit caption rate wrap error:', err.message);
    return false;
  }
}

async function tryUserbotEditCaption(channelChatId, messageId, newCaption) {
  let client = null;
  try {
    const account = await UserbotAccount.findOne({ session: { $ne: null, $exists: true } })
      .select('session')
      .limit(1)
      .lean();
    if (!account || !account.session) return false;

    client = new TelegramClient(
      new StringSession(account.session),
      Number(process.env.API_ID),
      process.env.API_HASH,
      { useWSS: false, autoReconnect: true, timeout: 30000, requestRetries: 3, connectionRetries: 3 }
    );
    await client.connect();
    let peer;
    const raw = String(channelChatId).replace(/^-100/, '');
    if (/^\d+$/.test(raw)) peer = new Api.InputPeerChannel({ channelId: Number(raw), accessHash: 0n });
    else peer = String(channelChatId);
    await client.invoke(
      new Api.messages.EditMessage({
        peer,
        id: Number(messageId),
        message: String(newCaption),
      })
    );
    return true;
  } catch (err) {
    console.error('[captions] userbot edit caption error:', err.message);
    return false;
  } finally {
    try { if (client) await client.disconnect().catch(() => {}); } catch {}
  }
}

async function replyCollisionNotice(telegram, channelChatId, replyToMessageId, newCaption) {
  try {
    await rateLimited(async () => {
      try {
        return await telegram.sendMessage(
          channelChatId,
          `Number already exists❌\nVideo number changed to ${newCaption}✅`,
          {
            reply_to_message_id: replyToMessageId,
            disable_web_page_preview: true,
            disable_notification: true,
          }
        );
      } catch (err) {
        console.error('[captions] collision reply error:', err.message);
        return null;
      }
    });
  } catch (err) {
    console.error('[captions] collision reply rate wrap error:', err.message);
  }
}

async function handleCaptionCollision(telegram, channelChatId, messageId, oldCaption, newCaption) {
  const edited = await tryBotEditCaption(telegram, channelChatId, messageId, newCaption);
  if (edited) return { edited: true, via: 'bot' };
  const ubEdited = await tryUserbotEditCaption(channelChatId, messageId, newCaption);
  if (ubEdited) return { edited: true, via: 'userbot' };
  await replyCollisionNotice(telegram, channelChatId, messageId, newCaption);
  return { edited: false, via: 'reply_fallback' };
}

module.exports = {
  ALLOWED_DIGIT_LEN,
  parseCaptionNumber,
  isAllowedManualCaption,
  getNextAutoCaption,
  allocateCaption,
  replyCaptionInChannel,
  tryBotEditCaption,
  tryUserbotEditCaption,
  replyCollisionNotice,
  handleCaptionCollision,
};
