'use strict';

require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const authMiddleware = require('./middleware/auth');
const { adminCache } = require('./cache');
const Admin = require('./models/Admin');
const UploadChannel = require('./models/UploadChannel');
const Video = require('./models/Video');
const {
  mainMenuKeyboard,
  backMainKeyboard,
  adminMainKeyboard,
  adminsInlineKeyboard,
  adminActionsKeyboard,
  adminDeleteConfirmKeyboard,
  channelsInlineKeyboard,
  channelActionsKeyboard,
  channelDeleteConfirmKeyboard,
  cancelInlineKeyboard,
  uploaderIntroKeyboard,
} = require('./keyboards/menu');
const {
  syncChannelCache,
  upsertChannelFromChat,
  setApproved,
  deleteById,
  updateTitle,
  sameChannel,
  normalizeChannelId,
  isDeliveryEligible,
} = require('./services/channels');
const { allocateCaption, replyCaptionInChannel, parseCaptionNumber, handleCaptionCollision } = require('./services/captions');
const { deliverVideoForQuery, findVideoByCaption, BOT_KEY } = require('./services/delivery');
const UserbotAccount = require('./models/UserbotAccount');
const {
  beginLogin,
  handleCancel,
  handleTextMessage: uploaderHandleText,
  listLoggedInAccounts,
} = require('./bot/uploaderLogin');

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: false },
  handlerTimeout: 90_000,
});

bot.use(session());
bot.use(authMiddleware);

bot.catch((err, ctx) => {
  const tag = ctx && ctx.updateType ? `[bot.catch update=${ctx.updateType}]` : '[bot.catch]';
  console.error(tag, err?.stack || err?.message || err);
  try {
    if (ctx && ctx.callbackQuery) ctx.answerCbQuery().catch(() => {});
  } catch {}
});

const PENDING = {};

function resetPending(userId) {
  if (!userId) return;
  delete PENDING[Number(userId)];
}
function setPending(userId, state) {
  if (!userId) return;
  PENDING[Number(userId)] = state;
}
function getPending(userId) {
  if (!userId) return null;
  return PENDING[Number(userId)] || null;
}

async function editOrReply(ctx, text, extra = {}) {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { disable_web_page_preview: true, ...extra });
      return;
    }
  } catch (err) {
    console.error('[editOrReply edit error:', err?.message || err);
  }
  try {
    await ctx.reply(text, { disable_web_page_preview: true, ...extra });
  } catch (err) {
    console.error('[editOrReply reply error:', err?.message || err);
    try { await ctx.reply(text).catch(() => {}); } catch {}
  }
}

function answerCb(ctx) {
  ctx.answerCbQuery().catch(() => {});
}

// -------- Userbot fallback status (silent for plans 4/5, never surfaced to users) --------
// (handled inside delivery service)

// -------- Main start / menu --------
bot.start(async (ctx) => {
  try {
    const isAdmin = ctx.state.isAdmin;
    if (isAdmin) {
      await ctx.reply('Welcome to PboxTv\n\nChoose an option below.', mainMenuKeyboard(true));
      return;
    }
    await ctx.reply('Welcome to PboxTv\n\nType the video number (e.g. 42) and I\'ll send it to you instantly.');
  } catch (err) {
    console.error('[start] error:', err?.message || err);
  }
});

bot.action('back_main', async (ctx) => {
  answerCb(ctx);
  resetPending(ctx.from?.id);
  return editOrReply(ctx, 'Choose an option below.', mainMenuKeyboard(ctx.state.isAdmin));
});

bot.action('menu_uploader', async (ctx) => {
  answerCb(ctx);
  const isAdmin = ctx.state.isAdmin;
  if (!isAdmin) {
    return editOrReply(
      ctx,
      'Type the video number you\'re looking for (e.g. 123).',
      backMainKeyboard()
    );
  }
  let hasAnySession = false;
  try {
    hasAnySession = (await UserbotAccount.countDocuments({ session: { $ne: null, $exists: true } }).lean().catch(() => 0)) > 0;
  } catch {}
  const lines = [
    '⬆️ Uploader',
    '',
    'Post videos to approved channels, or add a GramJS userbot session below to enable Plan 4/5 fallback delivery.',
    '',
    '1. Post a video to any approved channel.',
    '2. If you write a numeric caption (1-5 digits, no letters), it becomes the video number.',
    '3. If no caption is present, I auto-assign the next incrementing number and reply to the post in the channel with it.',
    '',
    'After that, any user can send that number to the bot and receive the video instantly.',
  ];
  return editOrReply(ctx, lines.join('\n'), uploaderIntroKeyboard(hasAnySession));
});

bot.action('uploader_add_account', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  return beginLogin(ctx);
});

bot.action('uploader_list_accounts', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const chatId = ctx.chat?.id || ctx.from?.id;
  if (!chatId) return;
  return listLoggedInAccounts(bot, chatId);
});

bot.action('back_to_main', async (ctx) => {
  await handleCancel(ctx);
  answerCb(ctx);
  resetPending(ctx.from?.id);
  return editOrReply(ctx, '👋 Choose an option below.', mainMenuKeyboard(ctx.state.isAdmin));
});

// -------- Admin panel main routing --------
bot.action('menu_admin', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const channels = await UploadChannel.find().lean().catch(() => []);
  return editOrReply(
    ctx,
    `⚙️ Admin Panel\n\n📺 Channels tracked: ${channels.length}\n✅ Approved for delivery: ${channels.filter((c) => c.isApproved).length}\n👥 Admins: ${adminCache.getAll().length}`,
    adminMainKeyboard()
  );
});

bot.action('admin_back', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const channels = await UploadChannel.find().lean().catch(() => []);
  return editOrReply(
    ctx,
    `⚙️ Admin Panel\n\n📺 Channels tracked: ${channels.length}\n✅ Approved for delivery: ${channels.filter((c) => c.isApproved).length}`,
    adminMainKeyboard()
  );
});

// -------- Admin CRUD --------
bot.action('admin_admins', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const admins = await Admin.find().sort({ createdAt: 1 }).lean().catch(() => []);
  return editOrReply(ctx, '👥 Admins List', adminsInlineKeyboard(admins, ctx.from?.id));
});

bot.action(/^admin_view:(.+)$/, async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const id = ctx.match[1];
  const a = await Admin.findById(id).lean().catch(() => null);
  if (!a) return editOrReply(ctx, 'Admin not found.', backMainKeyboard());
  const isSelf =
    String(a.telegramId) === String(ctx.from?.id) ||
    (a.username && ctx.from?.username && String(a.username).toLowerCase() === `@${String(ctx.from.username)}`.toLowerCase());
  const lines = [
    '🛡 Admin Details',
    '',
    `ID: ${a.telegramId || 'Not set'}`,
    `Username: ${a.username || 'Not set'}`,
    `Super Admin: ${a.isSuperAdmin ? '✅ Yes' : '❌ No'}`,
    `Added: ${a.createdAt ? a.createdAt.toDateString() : '-'}`,
  ];
  return editOrReply(ctx, lines.join('\n'), adminActionsKeyboard(id, isSelf, !!ctx.state.isSuperAdmin));
});

bot.action('admin_add', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  setPending(ctx.from?.id, { type: 'admin_add', step: 1 });
  return editOrReply(
    ctx,
    '➕ Add Admin\n\nStep 1/2: Send @username or numeric Telegram ID.',
    cancelInlineKeyboard('admin_cancel')
  );
});

bot.action(/^admin_delete_confirm:(.+)$/, async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isSuperAdmin) {
    try { await ctx.answerCbQuery('⛔ Only superadmins remove admins.', true); } catch {}
    return;
  }
  const id = ctx.match[1];
  return editOrReply(
    ctx,
    '⚠️ Remove this admin permanently?',
    { ...adminDeleteConfirmKeyboard(id) }
  );
});

bot.action(/^admin_delete:(.+)$/, async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isSuperAdmin) return;
  const id = ctx.match[1];
  try {
    const doc = await Admin.findByIdAndDelete(id);
    if (doc) {
      const all = await Admin.find().lean();
      adminCache.set(all);
    }
    return editOrReply(ctx, '✅ Admin removed.', { ...backMainKeyboard() });
  } catch (err) {
    console.error('[admin_delete] error:', err.message);
    return editOrReply(ctx, '❌ Failed to remove admin.', { ...backMainKeyboard() });
  }
});

bot.action('admin_cancel', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  resetPending(ctx.from?.id);
  const admins = await Admin.find().sort({ createdAt: 1 }).lean().catch(() => []);
  return editOrReply(ctx, '👥 Admins List', adminsInlineKeyboard(admins, ctx.from?.id));
});

// -------- Upload Channel CRUD --------
bot.on('my_chat_member', async (ctx, next) => {
  try {
    const u = ctx.myChatMember;
    if (!u || !u.chat || (u.chat.type !== 'channel' && u.chat.type !== 'supergroup')) return next();
    const addedBy = ctx.from?.id || null;
    const c = u.chat;
    await upsertChannelFromChat(c, addedBy);
    await syncChannelCache();
    if (ctx.state && ctx.state.isAdmin) {
      try {
        await ctx
          .reply(
            `📺 Channel tracked automatically:\n\nTitle: ${c.title || ''}\nID: ${c.id}\nUsername: ${c.username ? '@' + c.username : 'None'}\n\nGo to Admin Panel → Upload Channels to approve it.`
          )
          .catch(() => {});
      } catch {}
    }
    return next();
  } catch (err) {
    console.error('[my_chat_member] error:', err.message);
    return next();
  }
});

bot.action('admin_channels', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const list = await UploadChannel.find().sort({ createdAt: -1 }).lean().catch(() => []);
  return editOrReply(ctx, '📺 Upload Channels\n\n✅ = approved for media delivery\n❌ = tracked but blocked\n\nApprove to make its videos deliverable to end users.', channelsInlineKeyboard(list));
});

bot.action(/^channel_view:(.+)$/, async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const id = ctx.match[1];
  const c = await UploadChannel.findById(id).lean().catch(() => null);
  if (!c) return editOrReply(ctx, 'Channel not found.', backMainKeyboard());
  const lines = [
    '📺 Channel Details',
    '',
    `Title: ${c.title || 'Not set'}`,
    `ID: ${c.channelId}`,
    `Username: ${c.username || 'None'}`,
    `Approved: ${c.isApproved ? '✅ Yes' : '❌ No (deselected)'}`,
    `Added: ${c.createdAt ? c.createdAt.toDateString() : '-'}`,
  ];
  return editOrReply(ctx, lines.join('\n'), channelActionsKeyboard(id));
});

bot.action('channel_add', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  setPending(ctx.from?.id, { type: 'channel_add', step: 1 });
  return editOrReply(
    ctx,
    '➕ Add Channel\n\nStep 1/1: Send numeric channel id (e.g. -1001234567890) or @username.\n\nTip: just add the bot to the channel and it auto-registers too.',
    cancelInlineKeyboard('channel_cancel')
  );
});

bot.action(/^channel_toggle:(.+)$/, async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const id = ctx.match[1];
  const current = await UploadChannel.findById(id).lean().catch(() => null);
  if (!current) return editOrReply(ctx, 'Channel not found.', { ...backMainKeyboard() });
  await setApproved(id, !current.isApproved);
  const refreshed = await UploadChannel.findById(id).lean().catch(() => current);
  const lines = [
    '📺 Channel updated:',
    '',
    `Title: ${refreshed?.title || ''}`,
    `Approved: ${refreshed?.isApproved ? '✅ Approve' : '❌ Deselected (disabled)'}`,
  ];
  return editOrReply(ctx, lines.join('\n'), { ...channelActionsKeyboard(id) });
});

bot.action(/^channel_edit_title:(.+)$/, async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const id = ctx.match[1];
  setPending(ctx.from?.id, { type: 'channel_edit_title', channelId: id });
  return editOrReply(
    ctx,
    '✏️ Send the new display title for this channel (max 200 chars).',
    { ...cancelInlineKeyboard('channel_cancel') }
  );
});

bot.action(/^channel_delete_confirm:(.+)$/, async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const id = ctx.match[1];
  return editOrReply(
    ctx,
    '⚠️ Delete channel PERMANENTLY from DB?\n\n(Use Approve/Toggle if you just want to deselect temporarily.)',
    { ...channelDeleteConfirmKeyboard(id) }
  );
});

bot.action(/^channel_delete:(.+)$/, async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  const id = ctx.match[1];
  const ok = await deleteById(id);
  return editOrReply(
    ctx,
    ok ? '✅ Channel deleted permanently from DB.' : '❌ Failed to delete.',
    { ...backMainKeyboard() }
  );
});

bot.action('channel_cancel', async (ctx) => {
  answerCb(ctx);
  if (!ctx.state.isAdmin) return;
  resetPending(ctx.from?.id);
  const list = await UploadChannel.find().sort({ createdAt: -1 }).lean().catch(() => []);
  return editOrReply(ctx, '📺 Upload Channels', channelsInlineKeyboard(list));
});

// -------- Channel post ingest (Bot API side) + auto-caption reply --------
bot.on(['channel_post', 'edited_channel_post'], async (ctx, next) => {
  try {
    const msg = ctx.channelPost || ctx.editedChannelPost;
    if (!msg) return next();
    if (msg.chat && (msg.chat.type === 'channel' || msg.chat.type === 'supergroup')) {
      await upsertChannelFromChat(msg.chat, ctx.from?.id || null);
    }

    // Accept any media type we can deliver: video, document (any file), photo.
    const media =
      msg.video ||
      (msg.document ? msg.document : null) ||
      (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0
        ? msg.photo[msg.photo.length - 1]
        : null) ||
      null;
    if (!media) return next();
    let mediaKind = 'document';
    if (msg.video) mediaKind = 'video';
    else if (msg.photo && msg.photo.length > 0) mediaKind = 'photo';
    else if (msg.document) mediaKind = 'document';

    const chatId = msg.chat && msg.chat.id != null ? String(msg.chat.id) : null;
    const messageId = msg.message_id;
    if (!chatId || !messageId) return next();

    const approved = isDeliveryEligible(chatId);
    // Always write DB row so admins see content pending approval
    const rawCaption = msg.caption || null;
    const manualN = parseCaptionNumber(rawCaption);

    // Detect manual-caption collision explicitly BEFORE allocateCaption so we can fire the reply chain.
    let manualCollision = false;
    if (manualN != null) {
      try {
        const colliding = await Video.findOne({ caption_number: manualN }).select('_id source').lean().catch(() => null);
        if (colliding) {
          const sameSource =
            colliding.source &&
            String(colliding.source.channel_id) === String(chatId) &&
            Number(colliding.source.message_id) === Number(messageId);
          if (!sameSource) manualCollision = true;
        }
      } catch (err) {
        console.error('[ingest] collision probe error:', err.message);
      }
    }

    // Allocate: if collision detected, force auto-assign by passing null manualText so we get a fresh unique number.
    const caption = await allocateCaption(manualCollision ? null : rawCaption).catch(async (err) => {
      console.error('[ingest] caption allocate error:', err.message);
      const v = await Video.find().sort({ caption_number: -1 }).limit(1).select('caption_number').lean().catch(() => null);
      return v && v[0] ? Number(v[0].caption_number) + 1 : 1;
    });

    // Check if row already exists by (channel, message_id) or file_unique_id
    const fileUniqueId = media?.file_unique_id || null;
    const existing = await Video.findOne({
      $or: [
        { 'source.channel_id': chatId, 'source.message_id': Number(messageId) },
        fileUniqueId ? { file_unique_id: fileUniqueId } : { _id: null },
      ],
    })
      .lean()
      .catch(() => null);

    if (existing) {
      const patch = {};
      let ranCollisionChain = false;

      if (manualN != null && Number(existing.caption_number) !== Number(manualN)) {
        const collision = await Video.findOne({ caption_number: manualN, _id: { $ne: existing._id } }).select('_id').lean().catch(() => null);
        if (!collision) {
          patch.caption_number = manualN;
        } else {
          patch.caption_number = Number(caption);
          // Always reply the notice to the admin on collision, regardless of approval status.
          if (chatId && messageId) {
            try {
              await handleCaptionCollision(ctx.telegram, chatId, Number(messageId), manualN, Number(caption));
              ranCollisionChain = true;
            } catch (err) {
              console.error('[ingest] existing-row collision chain error:', err.message);
            }
          }
        }
      } else if (manualCollision && !ranCollisionChain) {
        if (Number(existing.caption_number) !== Number(caption)) {
          patch.caption_number = Number(caption);
        }
        if (chatId && messageId) {
          try {
            await handleCaptionCollision(ctx.telegram, chatId, Number(messageId), manualN, Number(caption));
            ranCollisionChain = true;
          } catch (err) {
            console.error('[ingest] existing-row collision chain (b) error:', err.message);
          }
        }
      }

      if (!existing.file_unique_id && fileUniqueId) patch.file_unique_id = fileUniqueId;
      patch.last_seen_at = new Date();
      if (Object.keys(patch).length) {
        try { await Video.updateOne({ _id: existing._id }, { $set: patch }); } catch (err) { console.error('[ingest] update error:', err.message); }
      }
      return next();
    }

    const botSlot = { [BOT_KEY]: media?.file_id || null };
    const row = {
      caption_number: caption,
      source: { channel_id: chatId, message_id: Number(messageId) },
      metadata: {
        kind: mediaKind,
        mime_type: media?.mime_type || '',
        file_name: media?.file_name || '',
        file_size: Number(media?.file_size || 0),
        uploaded_at: msg.date ? new Date(msg.date * 1000) : new Date(),
      },
      bot_file_ids: media?.file_id ? botSlot : {},
      file_unique_id: fileUniqueId,
      mtproto: null,
      last_seen_at: new Date(),
    };

    try {
      await Video.create(row);
    } catch (err) {
      if (err && err.code === 11000) {
        try {
          const prior = await Video.findOne({ 'source.channel_id': chatId, 'source.message_id': Number(messageId) }).lean();
          if (prior) return next();
        } catch {}
      }
      console.error('[ingest] write error:', err.message);
      return next();
    }

    // Always reply collision notice (unapproved channels too — admin needs to see what happened).
    if (manualCollision && chatId && messageId) {
      try {
        await handleCaptionCollision(ctx.telegram, chatId, Number(messageId), manualN, Number(caption));
      } catch (err) {
        console.error('[ingest] new-row collision chain error:', err.message);
      }
    } else if (manualN == null && approved) {
      // If the admin didn't put a numeric caption, reply with the generated one in the channel.
      await replyCaptionInChannel(ctx.telegram, chatId, Number(messageId), caption);
    }
    return next();
  } catch (err) {
    console.error('[channel_post ingest] error:', err?.stack || err?.message || err);
    return next();
  }
});

// -------- Pending text input handlers (admin CRUD, channel CRUD) --------
bot.on('text', async (ctx, next) => {
  try {
    const txt = (ctx.message && ctx.message.text) ? String(ctx.message.text).trim() : '';
    if (!txt) return next();

    // Uploader GramJS login capture FIRST (phone/code/2FA input before any other flow)
    const loginHandled = await uploaderHandleText(ctx);
    if (loginHandled) return;

    // Media query by end users first (runs for ALL users, admin or otherwise if it's a number)
    if (/^-?\d+$/.test(txt)) {
      try {
        const uid = ctx.from?.id;
        const chatId = ctx.chat?.id;
        const chatType = ctx.chat?.type;
        const isPrivate = chatType === 'private';
        const userMsgId = ctx.message?.message_id || ctx.callbackQuery?.message?.message_id || null;
        if (chatId) {
          const res = await deliverVideoForQuery(ctx.telegram, chatId, txt, userMsgId || undefined);
          // Silence explicitly on: no_approved_channels_silent, video_channel_unapproved_silent, bad_input
          // not_found -> reply in private chats with "No media with that number❌"
          const SILENT = new Set([
            'no_approved_channels_silent',
            'video_channel_unapproved_silent',
            'bad_input',
          ]);
          if (res.delivered) return;
          if (res.reason && SILENT.has(res.reason)) return;
          if (isPrivate && res.reason === 'not_found' && userMsgId) {
            try {
              await ctx.reply('No media with that number❌', { reply_to_message_id: userMsgId });
            } catch (err) {
              console.error('[text not_found reply error]:', err.message);
            }
            return;
          }
        }
      } catch (err) {
        console.error('[text media query] error:', err.message);
      }
    }

    if (!ctx.state.isAdmin) return next();
    const uid = ctx.from?.id;
    const p = getPending(uid);
    if (!p) return next();

    if (p.type === 'admin_add') {
      if (p.step === 1) {
        const raw = txt.replace(/^@/, '');
        const isNumeric = /^\d+$/.test(raw);
        const step = {
          type: 'admin_add',
          step: 2,
          telegramId: isNumeric ? Number(raw) : null,
          username: isNumeric ? null : (txt.startsWith('@') ? txt : `@${txt}`),
        };
        setPending(uid, step);
        await ctx.reply('Step 2/2: Super Admin? Reply yes or no.', cancelInlineKeyboard('admin_cancel'));
        return;
      }
      if (p.step === 2) {
        const isSuper = /^y(es)?$/i.test(txt);
        try {
          const payload = { isSuperAdmin: !!isSuper, addedBy: Number(uid) || null };
          if (p.telegramId) payload.telegramId = Number(p.telegramId);
          if (p.username) payload.username = String(p.username);
          const doc = await Admin.create(payload);
          adminCache.add(doc.toObject());
          await ctx.reply(
            `✅ Admin added:\n${doc.username || 'ID:' + doc.telegramId}\n${isSuper ? '👑 Super Admin' : '🛡 Admin'}`
          );
        } catch (err) {
          console.error('[admin_add create] error:', err.message);
          await ctx.reply(`❌ Failed: ${err.message || err}`);
        } finally {
          resetPending(uid);
        }
        return;
      }
    }

    if (p.type === 'channel_add') {
      try {
        const raw = txt;
        const idForm = /^-?\d+$/.test(raw) ? raw : null;
        const userForm = /^@/.test(raw) ? raw : /^[a-zA-Z0-9_]{5,}$/.test(raw) ? `@${raw}` : null;
        const channelId = idForm || userForm || null;
        if (!channelId) {
          await ctx.reply('❌ Expected numeric channel ID or @username. Try again.', cancelInlineKeyboard('channel_cancel'));
          return;
        }
        // Save raw entry; title auto-populates if bot is a member later via my_chat_member
        const existing = await UploadChannel.findOne({
          $or: [{ channelId: normalizeChannelId(channelId) }, userForm ? { username: userForm.toLowerCase() } : { _id: null }],
        }).lean();
        if (existing) {
          await ctx.reply(`ℹ️ Channel already tracked: ${existing.title || existing.channelId}`);
        } else {
          await UploadChannel.create({
            channelId: normalizeChannelId(channelId),
            title: null,
            username: userForm ? userForm.toLowerCase() : null,
            isApproved: false,
            addedBy: Number(uid) || null,
          });
          await syncChannelCache();
          await ctx.reply('✅ Channel added in deselected state. Approve it in Channel view to enable delivery.');
        }
      } catch (err) {
        console.error('[channel_add] create error:', err.message);
        await ctx.reply(`❌ Failed: ${err.message || err}`);
      } finally {
        resetPending(uid);
      }
      return;
    }

    if (p.type === 'channel_edit_title') {
      try {
        const newTitle = String(txt).slice(0, 200) || 'Untitled';
        const ok = await updateTitle(p.channelId, newTitle);
        await ctx.reply(ok ? `✅ Title updated → ${ok.title || newTitle}` : '❌ Failed to update title.');
      } catch (err) {
        console.error('[channel_edit_title] error:', err.message);
        await ctx.reply(`❌ Failed: ${err.message || err}`);
      } finally {
        resetPending(uid);
      }
      return;
    }

    return next();
  } catch (err) {
    console.error('[text admin flow] error:', err?.stack || err?.message || err);
    return next();
  }
});

module.exports = bot;
