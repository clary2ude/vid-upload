'use strict';

const { Markup } = require('telegraf');

function mainMenuKeyboard(isAdmin) {
  const rows = [
    [Markup.button.callback('⬆️ Uploader', 'menu_uploader')],
  ];
  if (isAdmin) {
    rows.push([Markup.button.callback('⚙️ Admin Panel', 'menu_admin')]);
  }
  return Markup.inlineKeyboard(rows);
}

function backMainKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_main')]]);
}

function adminMainKeyboard(hasChannels) {
  const rows = [
    [Markup.button.callback('👥 Admins', 'admin_admins')],
    [Markup.button.callback('📺 Upload Channels', 'admin_channels')],
  ];
  rows.push([Markup.button.callback('« Back', 'back_main')]);
  return Markup.inlineKeyboard(rows);
}

function adminsInlineKeyboard(admins, currentUserId) {
  const rows = admins.map((a) => {
    const crown = a.isSuperAdmin ? '👑' : '🛡';
    let label;
    if (a.username) label = `${crown} ${a.username}`;
    else if (a.telegramId) label = `${crown} ID:${a.telegramId}`;
    else label = `${crown} (unsaved)`;
    const id = String(a._id);
    return [Markup.button.callback(label, `admin_view:${id}`)];
  });
  rows.push([Markup.button.callback('➕ Add Admin', 'admin_add')]);
  rows.push([Markup.button.callback('« Back to Admin', 'admin_back')]);
  return Markup.inlineKeyboard(rows);
}

function adminActionsKeyboard(adminId, isSelf, isSuper) {
  const rows = [];
  if (!isSelf && !isSuper) {
    rows.push([Markup.button.callback('🗑 Remove Admin', `admin_delete_confirm:${adminId}`)]);
  } else if (!isSelf && isSuper) {
    // only superadmin removal handled only by super
  }
  rows.push([Markup.button.callback('« Back', 'admin_admins')]);
  return Markup.inlineKeyboard(rows);
}

function adminDeleteConfirmKeyboard(adminId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Remove', `admin_delete:${adminId}`)],
    [Markup.button.callback('✖ Cancel', `admin_admins`)],
  ]);
}

function channelsInlineKeyboard(channels) {
  const rows = channels.map((c) => {
    const mark = c.isApproved ? '✅' : '❌';
    const name = c.title || c.username || `ID:${c.channelId}`;
    return [Markup.button.callback(`${mark} ${name}`, `channel_view:${c._id}`)];
  });
  rows.push([Markup.button.callback('➕ Add Channel', 'channel_add')]);
  rows.push([Markup.button.callback('« Back to Admin', 'admin_back')]);
  return Markup.inlineKeyboard(rows);
}

function channelActionsKeyboard(channelId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Approve / Toggle', `channel_toggle:${channelId}`)],
    [Markup.button.callback('✏ Rename Title', `channel_edit_title:${channelId}`)],
    [Markup.button.callback('🗑 Delete from DB', `channel_delete_confirm:${channelId}`)],
    [Markup.button.callback('« Back to Channels', 'admin_channels')],
  ]);
}

function channelDeleteConfirmKeyboard(channelId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Delete Permanently', `channel_delete:${channelId}`)],
    [Markup.button.callback('✖ Cancel', `admin_channels`)],
  ]);
}

function cancelInlineKeyboard(actionLabel = 'cancel') {
  return Markup.inlineKeyboard([[Markup.button.callback('✖ Cancel', actionLabel)]]);
}

function uploaderIntroKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔢 How to Upload', 'uploader_howto')],
    [Markup.button.callback('« Back', 'back_main')],
  ]);
}

module.exports = {
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
};
