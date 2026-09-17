'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Root dir is one level up from tests/
const ROOT = path.resolve(__dirname, '..');

// --- patch helpers for CommonJS require cache ---
function resolve(fromTestsRelative) {
  return path.join(ROOT, fromTestsRelative);
}

function patchModule(relFromRoot, overrideExports) {
  const abs = require.resolve(resolve(relFromRoot));
  if (!(abs in require.cache)) require(abs);
  const cached = require.cache[abs];
  const originalExports = { ...cached.exports };
  Object.assign(cached.exports, overrideExports);
  return () => {
    for (const k of Object.keys(cached.exports)) {
      if (!(k in originalExports)) delete cached.exports[k];
    }
    for (const k of Object.keys(originalExports)) {
      cached.exports[k] = originalExports[k];
    }
  };
}

function requireFresh(relFromRoot) {
  const abs = require.resolve(resolve(relFromRoot));
  delete require.cache[abs];
  return require(abs);
}

// --- fixtures ---
const APPROVED_CHANNEL = String(-1001112223334);
const UNAPPROVED_CHANNEL = String(-1009998887776);
const BOT_KEY_FIXTURE = '123456789';
const VIDEO_FILE_ID = 'FILEID_ABC';
const USER_CHAT = 9000000001;

function freshEnv() {
  process.env.BOT_TOKEN = `${BOT_KEY_FIXTURE}:AAFAKEFAKEFAKE`;
  process.env.MONGODB_URI = 'mongodb://localhost:27017/nope';
  process.env.API_ID = '123';
  process.env.API_HASH = 'abc';
  process.env.DB_NAME = 'testdb';
  delete process.env.CURRENT_BOT_KEY;
}

function fakeTelegramSpies() {
  const calls = { sendVideo: [], copyMessage: [], forwardMessage: [], sendMessage: [], editMessageCaption: [] };
  const telegram = {
    sendVideo: async (...args) => { calls.sendVideo.push(args); return { message_id: 1, video: { file_id: 'seeded_id' } }; },
    copyMessage: async (...args) => { calls.copyMessage.push(args); return { message_id: 2, video: { file_id: 'copy_seeded_id' } }; },
    forwardMessage: async (...args) => { calls.forwardMessage.push(args); return { message_id: 3, video: { file_id: 'forward_seeded_id' } }; },
    sendMessage: async (...args) => { calls.sendMessage.push(args); return { message_id: 4 }; },
    editMessageCaption: async (...args) => { calls.editMessageCaption.push(args); return true; },
  };
  return { telegram, calls };
}

// --- captions unit tests (no DB required for parse/allow) ---
test('captions: parseCaptionNumber returns integer for valid numeric text', () => {
  const { parseCaptionNumber, isAllowedManualCaption } = requireFresh('src/services/captions');
  assert.equal(parseCaptionNumber('42'), 42);
  assert.equal(parseCaptionNumber(' 100 '), 100);
  assert.equal(parseCaptionNumber('abc'), null);
  assert.equal(parseCaptionNumber(''), null);
  assert.equal(parseCaptionNumber(null), null);
  assert.equal(parseCaptionNumber('1.5'), null);
  assert.equal(isAllowedManualCaption(0), false);
  assert.equal(isAllowedManualCaption(1), true);
  assert.equal(isAllowedManualCaption(99999), true);
  assert.equal(isAllowedManualCaption(100000), false);
});

test('captions: allocateCaption prefers manual when free', async () => {
  freshEnv();
  const restoreCache = patchModule('src/cache', {});
  // Fake Video.findOne so manual 9999 = free, manual 42 = taken
  const findOneCalls = [];
  const restoreVideo = patchModule('src/models/Video', {
    findOne: (q) => { findOneCalls.push(q); return { select: () => ({ lean: async () => (q.caption_number === 42 ? { _id: 'x' } : null) }) }; },
  });
  const restoreCounter = patchModule('src/models/Counter', {});
  const { allocateCaption } = requireFresh('src/services/captions');
  assert.equal(await allocateCaption('9999'), 9999);
  assert.equal(await allocateCaption('42'), 1); // collision fallback to Counter
  restoreVideo();
  restoreCounter();
  restoreCache();
});

// --- delivery end-to-end with stubs via monkey-patched module cache ---
test('delivery: hot path sendVideo called with cached file_id when bot_file_ids[BOT_KEY] present', async () => {
  freshEnv();
  const { telegram, calls } = fakeTelegramSpies();
  const row = {
    _id: 'R1',
    caption_number: 7,
    source: { channel_id: APPROVED_CHANNEL, message_id: 11 },
    bot_file_ids: { [BOT_KEY_FIXTURE]: VIDEO_FILE_ID },
  };
  const restoreChannelCache = patchModule('src/cache', {
    channelCache: {
      countApproved: () => 1,
      isApproved: (id) => id === APPROVED_CHANNEL,
    },
  });
  const restoreRateLimit = patchModule('src/queue/rateLimit', {
    rateLimited: async (fn) => await fn(),
    queryCache: { get: () => undefined, set: () => {} },
  });
  const restoreVideo = patchModule('src/models/Video', {
    findOne: () => ({ lean: async () => row }),
    findOneAndUpdate: () => ({ lean: async () => null }),
  });
  const restoreUA = patchModule('src/models/UserbotAccount', {
    findOne: () => ({ select: () => ({ limit: () => ({ lean: async () => null }) }) }),
  });
  const { deliverVideoForQuery, BOT_KEY } = requireFresh('src/services/delivery');
  assert.equal(BOT_KEY, BOT_KEY_FIXTURE);
  const result = await deliverVideoForQuery(telegram, USER_CHAT, '7');
  restoreChannelCache();
  restoreRateLimit();
  restoreVideo();
  restoreUA();
  assert.equal(result.delivered, true, 'delivered=true via hot path');
  assert.equal(result.via, 'hot_sendVideo');
  assert.equal(calls.sendVideo.length, 1, 'exactly one sendVideo call');
  assert.deepEqual(calls.sendVideo[0].slice(0, 2), [USER_CHAT, VIDEO_FILE_ID]);
  const extra = calls.sendVideo[0][2] || {};
  assert.equal(extra.supports_streaming, true);
  assert.equal(calls.copyMessage.length, 0, 'copyMessage NOT called on hot path');
  assert.equal(calls.forwardMessage.length, 0, 'forwardMessage NOT called on hot path');
});

test('delivery: cold copyMessage (then forward fallback) on missing hot file_id, and seeds file_id back', async () => {
  freshEnv();
  const { telegram, calls } = fakeTelegramSpies();
  const row = {
    _id: 'R2',
    caption_number: 8,
    source: { channel_id: APPROVED_CHANNEL, message_id: 22 },
    bot_file_ids: {},
  };
  let lastUpdate = null;
  const restoreChannelCache = patchModule('src/cache', {
    channelCache: {
      countApproved: () => 1,
      isApproved: (id) => id === APPROVED_CHANNEL,
    },
  });
  const restoreRateLimit = patchModule('src/queue/rateLimit', {
    rateLimited: async (fn) => await fn(),
    queryCache: { get: () => undefined, set: () => {} },
  });
  const restoreVideo = patchModule('src/models/Video', {
    findOne: () => ({ lean: async () => row }),
    findOneAndUpdate: (q, set) => { lastUpdate = { q, set }; return { lean: async () => ({ ...row, ...set.$set, caption_number: row.caption_number }) }; },
  });
  const restoreUA = patchModule('src/models/UserbotAccount', {
    findOne: () => ({ select: () => ({ limit: () => ({ lean: async () => null }) }) }),
  });
  const { deliverVideoForQuery } = requireFresh('src/services/delivery');
  const result = await deliverVideoForQuery(telegram, USER_CHAT, '8');
  restoreChannelCache();
  restoreRateLimit();
  restoreVideo();
  restoreUA();
  assert.equal(result.delivered, true);
  assert.equal(result.via, 'cold_copy_forward');
  assert.equal(calls.copyMessage.length, 1);
  assert.deepEqual(calls.copyMessage[0].slice(0, 3), [USER_CHAT, APPROVED_CHANNEL, 22]);
  assert.equal(calls.forwardMessage.length, 0);
  assert.ok(lastUpdate && lastUpdate.set && lastUpdate.set.$set, 'findOneAndUpdate should be called to seed file_id');
  const seeded = lastUpdate.set.$set[`bot_file_ids.${BOT_KEY_FIXTURE}`];
  assert.equal(seeded, 'copy_seeded_id', 'DB updated with bot-key-specific file_id from cold copy reply');
});

test('delivery: copy fails, falls back to forwardMessage', async () => {
  freshEnv();
  const { telegram, calls } = fakeTelegramSpies();
  // Force copyMessage to throw, so cold path uses forwardMessage fallback. Track call manually via spy array.
  telegram.copyMessage = async (...args) => { calls.copyMessage.push(args); throw new Error('copy failed'); };
  const row = {
    _id: 'R3', caption_number: 9,
    source: { channel_id: APPROVED_CHANNEL, message_id: 33 },
    bot_file_ids: {},
  };
  const restoreChannelCache = patchModule('src/cache', {
    channelCache: { countApproved: () => 1, isApproved: (id) => id === APPROVED_CHANNEL },
  });
  const restoreRateLimit = patchModule('src/queue/rateLimit', {
    rateLimited: async (fn) => await fn(),
    queryCache: { get: () => undefined, set: () => {} },
  });
  const restoreVideo = patchModule('src/models/Video', {
    findOne: () => ({ lean: async () => row }),
    findOneAndUpdate: () => ({ lean: async () => null }),
  });
  const restoreUA = patchModule('src/models/UserbotAccount', {
    findOne: () => ({ select: () => ({ limit: () => ({ lean: async () => null }) }) }),
  });
  const { deliverVideoForQuery } = requireFresh('src/services/delivery');
  const result = await deliverVideoForQuery(telegram, USER_CHAT, '9');
  restoreChannelCache();
  restoreRateLimit();
  restoreVideo();
  restoreUA();
  assert.equal(result.delivered, true);
  assert.equal(calls.copyMessage.length, 1, 'copy attempted');
  assert.equal(calls.forwardMessage.length, 1, 'forward fallback triggered');
});

test('delivery: silent gate: no approved channels returns no_approved_channels_silent', async () => {
  freshEnv();
  const { telegram, calls } = fakeTelegramSpies();
  const restoreChannelCache = patchModule('src/cache', {
    channelCache: { countApproved: () => 0, isApproved: () => false },
  });
  const restoreRateLimit = patchModule('src/queue/rateLimit', {
    rateLimited: async (fn) => await fn(),
    queryCache: { get: () => undefined, set: () => {} },
  });
  const restoreVideo = patchModule('src/models/Video', { findOne: () => ({ lean: async () => null }) });
  const restoreUA = patchModule('src/models/UserbotAccount', {
    findOne: () => ({ select: () => ({ limit: () => ({ lean: async () => null }) }) }),
  });
  const { deliverVideoForQuery } = requireFresh('src/services/delivery');
  const result = await deliverVideoForQuery(telegram, USER_CHAT, '99');
  restoreChannelCache();
  restoreRateLimit();
  restoreVideo();
  restoreUA();
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'no_approved_channels_silent');
  assert.equal(calls.sendVideo.length, 0);
  assert.equal(calls.copyMessage.length, 0);
});

test('delivery: video from UNAPPROVED channel => video_channel_unapproved_silent even if hot file_id exists', async () => {
  freshEnv();
  const { telegram, calls } = fakeTelegramSpies();
  const row = {
    _id: 'R4', caption_number: 10,
    source: { channel_id: UNAPPROVED_CHANNEL, message_id: 44 },
    bot_file_ids: { [BOT_KEY_FIXTURE]: VIDEO_FILE_ID },
  };
  const restoreChannelCache = patchModule('src/cache', {
    channelCache: { countApproved: () => 1, isApproved: (id) => id === APPROVED_CHANNEL },
  });
  const restoreRateLimit = patchModule('src/queue/rateLimit', {
    rateLimited: async (fn) => await fn(),
    queryCache: { get: () => undefined, set: () => {} },
  });
  const restoreVideo = patchModule('src/models/Video', { findOne: () => ({ lean: async () => row }) });
  const restoreUA = patchModule('src/models/UserbotAccount', {
    findOne: () => ({ select: () => ({ limit: () => ({ lean: async () => null }) }) }),
  });
  const { deliverVideoForQuery } = requireFresh('src/services/delivery');
  const result = await deliverVideoForQuery(telegram, USER_CHAT, '10');
  restoreChannelCache();
  restoreRateLimit();
  restoreVideo();
  restoreUA();
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'video_channel_unapproved_silent');
  assert.equal(calls.sendVideo.length, 0, 'hot path skipped for unapproved source');
});

test('delivery: bad input non-positive or parse fail => bad_input/not_found', async () => {
  freshEnv();
  const { telegram } = fakeTelegramSpies();
  const restoreChannelCache = patchModule('src/cache', {
    channelCache: { countApproved: () => 1, isApproved: () => true },
  });
  const restoreRateLimit = patchModule('src/queue/rateLimit', {
    rateLimited: async (fn) => await fn(),
    queryCache: { get: () => undefined, set: () => {} },
  });
  const restoreVideo = patchModule('src/models/Video', { findOne: () => ({ lean: async () => null }) });
  const restoreUA = patchModule('src/models/UserbotAccount', {
    findOne: () => ({ select: () => ({ limit: () => ({ lean: async () => null }) }) }),
  });
  const { deliverVideoForQuery } = requireFresh('src/services/delivery');
  const r1 = await deliverVideoForQuery(telegram, USER_CHAT, '0');
  assert.equal(r1.reason, 'bad_input');
  const r2 = await deliverVideoForQuery(telegram, USER_CHAT, '-5');
  assert.equal(r2.reason, 'bad_input');
  const r3 = await deliverVideoForQuery(telegram, USER_CHAT, '123456');
  assert.equal(r3.reason, 'not_found', 'not in DB => not_found');
  restoreChannelCache();
  restoreRateLimit();
  restoreVideo();
  restoreUA();
});

test('captions: replyCaptionInChannel calls telegram.sendMessage with reply_to_message_id + new params', async () => {
  freshEnv();
  const { telegram, calls } = fakeTelegramSpies();
  const restoreCache = patchModule('src/cache', {});
  const restoreVideo = patchModule('src/models/Video', { findOne: () => ({ select: () => ({ lean: async () => null }) }) });
  const restoreCounter = patchModule('src/models/Counter', {});
  const restoreRateLimit = patchModule('src/queue/rateLimit', { rateLimited: async (fn) => await fn(), queryCache: { get: () => undefined, set: () => {} } });
  const { replyCaptionInChannel, handleCaptionCollision } = requireFresh('src/services/captions');
  await replyCaptionInChannel(telegram, APPROVED_CHANNEL, 1234, 5678);
  assert.equal(calls.sendMessage.length, 1);
  const [chatId, text, extra] = calls.sendMessage[0];
  assert.equal(chatId, APPROVED_CHANNEL);
  assert.equal(text, '5678');
  assert.equal(extra.reply_to_message_id, 1234);
  assert.equal(extra.disable_web_page_preview, true);
  assert.equal(extra.disable_notification, true);
  // handleCaptionCollision only replies now (no edits): verify exact text.
  await handleCaptionCollision(telegram, APPROVED_CHANNEL, 999, 1, 555);
  const lastMsg = calls.sendMessage[calls.sendMessage.length - 1];
  assert.equal(lastMsg[1], 'Number already exists❌\nVideo number changed to 555✅');
  assert.equal(lastMsg[2].reply_to_message_id, 999);
  restoreRateLimit();
  restoreCounter();
  restoreVideo();
  restoreCache();
});
