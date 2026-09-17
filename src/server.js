'use strict';

require('dotenv').config();

const express = require('express');
const connectDB = require('./db');
const Admin = require('./models/Admin');
const UploadChannel = require('./models/UploadChannel');
const { adminCache, channelCache } = require('./cache');
const { seedSuperAdminFromEnv } = require('./seed');

const PORT = Number(process.env.PORT || process.env.port || 3000);
const SELF_URL = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.stack || reason?.message || reason);
});

const app = express();
app.use(express.json());

let pingCount = 0;
let lastPingAt = null;
let lastSelfPingAt = null;
let lastSelfPingOk = false;

app.get('/ping', (req, res) => {
  pingCount += 1;
  lastPingAt = new Date();
  res.set('Cache-Control', 'no-store');
  res.status(200).send('hello world');
});

app.get('/', (_req, res) => res.redirect('/stats'));

app.get('/stats', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const mem = process.memoryUsage();
  res.status(200).json({
    ok: true,
    now: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    pingCount,
    lastPingAt: lastPingAt ? lastPingAt.toISOString() : null,
    lastSelfPingAt: lastSelfPingAt ? lastSelfPingAt.toISOString() : null,
    lastSelfPingOk,
    selfUrl: SELF_URL || null,
    adminCount: adminCache.getAll().length,
    approvedChannelCount: channelCache.countApproved(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
  });
});

app.use((err, _req, res, _next) => {
  console.error('[express error]', err?.stack || err?.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => console.log(`[http] server listening on port ${PORT}`));
server.on('error', (err) => {
  console.error('[http] server error:', err?.message || err);
});

let bot = null;

async function boot() {
  try {
    await connectDB();

    await seedSuperAdminFromEnv();

    const admins = await Admin.find().lean();
    adminCache.set(admins);
    console.log(`[boot] Admin cache loaded: ${admins.length} admin(s)`);

    const channels = await UploadChannel.find().lean();
    channelCache.set(channels);
    console.log(`[boot] Channel cache loaded: total=${channels.length}, approved=${channels.filter((c) => c.isApproved).length}`);

    bot = require('./bot');

    try {
      const me = await bot.telegram.getMe();
      console.log(`[boot] Bot getMe ok: @${me.username || 'n/a'} (${me.id})`);
    } catch (err) {
      console.error('[boot] getMe failed:', err?.stack || err?.message || err);
      process.exitCode = 1;
      throw err;
    }

    try {
      const hookInfo = await bot.telegram.getWebhookInfo();
      if (hookInfo && hookInfo.url) {
        console.log(`[boot] Stale webhook found: ${hookInfo.url} — dropping for long-poll`);
        await bot.telegram.deleteWebhook();
      }
    } catch (err) {
      console.warn('[boot] webhook cleanup skipped:', err?.message || err);
    }

    try {
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Start the bot' },
      ]);
      console.log('[boot] Bot commands registered.');
    } catch (err) {
      console.warn('[boot] setMyCommands failed:', err?.message || err);
    }

    process.once('SIGINT', () => { try { if (bot) bot.stop('SIGINT'); } catch {} process.exit(0); });
    process.once('SIGTERM', () => { try { if (bot) bot.stop('SIGTERM'); } catch {} process.exit(0); });

    bot.launch().catch((err) => {
      if (err && err.message !== 'Aborted') console.error('[bot.launch]', err?.stack || err?.message || err);
    });
    console.log('[boot] Bot long-poll launched, receiving updates.');

    if (SELF_URL) {
      const doSelfPing = async () => {
        try {
          const res = await fetch(`${SELF_URL}/ping`, { cache: 'no-store' });
          lastSelfPingAt = new Date();
          lastSelfPingOk = !!res.ok && res.status === 200;
          if (!lastSelfPingOk) console.warn(`[keepalive] self-ping non-200 (status=${res.status})`);
          else console.log(`[keepalive] self-ping ok @${SELF_URL}/ping`);
        } catch (err) {
          lastSelfPingAt = new Date();
          lastSelfPingOk = false;
          console.warn('[keepalive] self-ping failed:', err?.message || err);
        }
      };
      doSelfPing();
      setInterval(doSelfPing, KEEPALIVE_INTERVAL_MS);
    } else {
      console.warn('[keepalive] SELF_URL / RENDER_EXTERNAL_URL not set — skip self-ping');
    }
  } catch (err) {
    console.error('[boot error]', err?.stack || err?.message || err);
    if (SELF_URL) {
      console.warn('[boot] will retry boot in 15s while keeping HTTP server alive…');
      setTimeout(boot, 15 * 1000);
    }
  }
}

boot();
