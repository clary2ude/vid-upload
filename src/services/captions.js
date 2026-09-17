'use strict';

const Counter = require('../models/Counter');
const Video = require('../models/Video');
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

async function replyCaptionInChannel(bot, channelChatId, replyToMessageId, captionNumber) {
  try {
    await rateLimited(async () => {
      try {
        return await bot.telegram.sendMessage(channelChatId, String(captionNumber), {
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

module.exports = {
  ALLOWED_DIGIT_LEN,
  parseCaptionNumber,
  isAllowedManualCaption,
  getNextAutoCaption,
  allocateCaption,
  replyCaptionInChannel,
};
