'use strict';

const { Markup } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const UserbotAccount = require('../models/UserbotAccount');
const { sendCodeWithRetry } = require('../helpers/telegram');
const { randomFingerprint } = require('../helpers/fingerprint');

const userSessions = new Map();
const authClients = new Map();

function getSession(userId) { return userSessions.get(String(userId)); }
function setSession(userId, data) { userSessions.set(String(userId), data); }
function clearSession(userId) { userSessions.delete(String(userId)); }
function getAuthClient(adminId) { return authClients.get(String(adminId)) || null; }
function setAuthClient(adminId, client) { authClients.set(String(adminId), client); }
function clearAuthClient(adminId) { authClients.delete(String(adminId)); }

async function withTimeout(promise, ms, label = 'timeout') {
  let t = null;
  const race = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
    if (t && t.unref) t.unref();
  });
  try {
    return await Promise.race([promise, race]);
  } finally {
    if (t) clearTimeout(t);
  }
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('<< Cancel', 'back_to_main')]]);
}

async function beginLogin(ctx) {
  if (!ctx.state.isAdmin) return;
  setSession(ctx.from.id, { step: 'awaiting_number', data: {} });
  return ctx.reply(
    'Send the phone number (with country code):\nExample: +1234567890',
    cancelKeyboard()
  ).catch(() => {});
}

async function handleCancel(ctx) {
  const userId = String(ctx.from?.id || '');
  const client = userId ? getAuthClient(userId) : null;
  clearSession(ctx.from?.id);
  if (userId) clearAuthClient(userId);
  try { if (client) await client.disconnect().catch(() => {}); } catch {}
  try { await ctx.answerCbQuery().catch(() => {}); } catch {}
  try {
    await ctx.editMessageText('Canceled.').catch(async () => {
      await ctx.reply('Canceled.').catch(() => {});
    });
  } catch {}
}

async function handlePhoneNumber(ctx, session) {
  const phone = String(ctx.message?.text || '').trim();
  const userId = String(ctx.from?.id || '');

  if (!/^\+?\d{6,20}$/.test(phone.replace(/[\s-]/g, ''))) {
    return ctx.reply('Invalid phone number. Use +CCXXXXXXXX format.', cancelKeyboard()).catch(() => {});
  }

  if (userId && getAuthClient(userId)) {
    return ctx.reply('Still sending verification code, wait...', cancelKeyboard()).catch(() => {});
  }
  const existing = await UserbotAccount.findOne({ number: phone }).select('_id session').lean().catch(() => null);
  if (existing?.session) {
    clearSession(ctx.from.id);
    return ctx.reply('This number already has a saved session in DB.', cancelKeyboard()).catch(() => {});
  }

  await ctx.reply('Sending verification code...').catch(() => {});

  const fp = randomFingerprint();
  let client = new TelegramClient(new StringSession(''), Number(process.env.API_ID), process.env.API_HASH, {
    useWSS: false,
    autoReconnect: true,
    timeout: 30000,
    requestRetries: 3,
    connectionRetries: 5,
    deviceModel: fp.deviceModel,
    systemVersion: fp.systemVersion,
    appVersion: fp.appVersion,
    langCode: fp.langCode,
    systemLangCode: fp.systemLangCode,
  });
  if (userId) setAuthClient(userId, client);

  try {
    await withTimeout(client.connect(), 45_000, 'login_connect_timeout');
    const result = await withTimeout(sendCodeWithRetry(client, phone), 60_000, 'login_send_code_timeout');
    if (!result.success) throw new Error(result.error || 'failed');
    if (result.client && result.client !== client) {
      try { await client.disconnect().catch(() => {}); } catch {}
      client = result.client;
      if (userId) setAuthClient(userId, client);
    }
    session.data = { ...session.data, phoneNumber: phone, phoneCodeHash: result.phoneCodeHash };
    session.step = 'awaiting_code';
    setSession(ctx.from.id, session);
    return ctx.reply('Code sent. Enter verification code:', cancelKeyboard()).catch(() => {});
  } catch (err) {
    clearSession(ctx.from.id);
    if (userId) clearAuthClient(userId);
    try { await client?.disconnect?.().catch(() => {}); } catch {}
    return ctx.reply(`Login failed: ${String(err.message || err)}`, cancelKeyboard()).catch(() => {});
  }
}

async function saveNewAccount(ctx, phoneNumber, client) {
  clearSession(ctx.from.id);
  let me = null;
  let sessionString = '';
  try {
    me = await client.getMe();
    sessionString = client.session.save();
  } catch (err) {
    throw new Error(`Account read failed: ${String(err.message || err)}`);
  } finally {
    try { await client.disconnect().catch(() => {}); } catch {}
    const userId = String(ctx.from?.id || '');
    if (userId) clearAuthClient(userId);
  }
  const prior = await UserbotAccount.findOne({
    $or: [{ number: phoneNumber }, me?.username ? { username: me.username } : { _id: null }],
  }).select('_id').lean().catch(() => null);
  if (prior) {
    await UserbotAccount.updateOne(
      { _id: prior._id },
      {
        $set: {
          number: phoneNumber,
          username: me?.username || null,
          userId: me?.id != null ? String(me.id) : null,
          session: sessionString,
        },
      }
    ).catch(() => {});
  } else {
    await UserbotAccount.create({
      number: phoneNumber,
      username: me?.username || null,
      userId: me?.id != null ? String(me.id) : null,
      session: sessionString,
    }).catch(() => {});
  }
  const lines = [
    'Userbot session saved. GramJS features (plan 4/5) now available.',
    me?.username ? `Username: @${me.username}` : null,
    `Phone: ${phoneNumber}`,
  ].filter(Boolean);
  return ctx.reply(lines.join('\n')).catch(() => {});
}

async function handleVerificationCode(ctx, session) {
  const code = String(ctx.message?.text || '').trim();
  const { phoneNumber, phoneCodeHash } = session.data;
  const userId = String(ctx.from?.id || '');
  const client = userId ? getAuthClient(userId) : null;
  if (!client) { clearSession(ctx.from.id); return ctx.reply('Session expired. Start again.', cancelKeyboard()).catch(() => {}); }
  await ctx.reply('Logging in...').catch(() => {});
  try {
    if (!client.connected) await withTimeout(client.connect(), 45_000, 'login_connect_timeout');
    await client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code }));
    await saveNewAccount(ctx, phoneNumber, client);
  } catch (err) {
    const codeMsg = String(err.code === 401 ? (err.errorMessage || '') : '');
    if (codeMsg === 'SESSION_PASSWORD_NEEDED') {
      session.step = 'awaiting_password';
      setSession(ctx.from.id, session);
      return ctx.reply('2FA enabled. Send password:', cancelKeyboard()).catch(() => {});
    }
    clearSession(ctx.from.id);
    if (userId) clearAuthClient(userId);
    try { await client?.disconnect?.().catch(() => {}); } catch {}
    return ctx.reply(`Login failed: ${String(err.message || err)}`, cancelKeyboard()).catch(() => {});
  }
}

async function handlePassword(ctx, session) {
  const password = String(ctx.message?.text || '');
  const { phoneNumber } = session.data;
  const userId = String(ctx.from?.id || '');
  const client = userId ? getAuthClient(userId) : null;
  if (!client) { clearSession(ctx.from.id); return ctx.reply('Session expired. Start again.', cancelKeyboard()).catch(() => {}); }
  await ctx.reply('Verifying password...').catch(() => {});
  try {
    if (!client.connected) await withTimeout(client.connect(), 45_000, 'login_connect_timeout');
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    const { computeCheck } = await import('telegram/Password.js');
    const passwordHash = await computeCheck(passwordInfo, password);
    await client.invoke(new Api.auth.CheckPassword({ password: passwordHash }));
    await saveNewAccount(ctx, phoneNumber, client);
  } catch (err) {
    if (String(err.errorMessage || '').includes('PASSWORD_HASH_INVALID')) {
      return ctx.reply('Wrong password. Try again:', cancelKeyboard()).catch(() => {});
    }
    clearSession(ctx.from.id);
    if (userId) clearAuthClient(userId);
    try { await client?.disconnect?.().catch(() => {}); } catch {}
    return ctx.reply(`Login failed: ${String(err.message || err)}`, cancelKeyboard()).catch(() => {});
  }
}

async function handleTextMessage(ctx) {
  const session = getSession(ctx.from?.id);
  if (!session) return false;
  if (session.step === 'awaiting_number') { await handlePhoneNumber(ctx, session); return true; }
  if (session.step === 'awaiting_code') { await handleVerificationCode(ctx, session); return true; }
  if (session.step === 'awaiting_password') { await handlePassword(ctx, session); return true; }
  return false;
}

async function listLoggedInAccounts(bot, chatId) {
  try {
    const rows = await UserbotAccount.find({ session: { $ne: null, $exists: true } })
      .sort({ createdAt: -1 })
      .select('number username')
      .lean();
    if (!rows.length) return bot.telegram.sendMessage(chatId, 'No userbot accounts logged in yet.').catch(() => {});
    const lines = ['Saved userbot sessions:'];
    for (const a of rows) {
      lines.push(`  - ${a.number}${a.username ? ` @${a.username}` : ''}`);
    }
    return bot.telegram.sendMessage(chatId, lines.join('\n')).catch(() => {});
  } catch (err) {
    console.error('[uploader] list accounts error:', err.message);
  }
}

module.exports = {
  beginLogin,
  handleCancel,
  handleTextMessage,
  listLoggedInAccounts,
};
