'use strict';

const Video = require('../models/Video');
const UserbotAccount = require('../models/UserbotAccount');
const { queryCache } = require('../queue/rateLimit');

let _timer = null;
let _running = false;
let _stopped = false;

async function fetchSessionAccount() {
  try {
    const row = await UserbotAccount.findOne({
      session: { $ne: null, $exists: true },
    })
      .select('session number userId username')
      .lean();
    return row || null;
  } catch (err) {
    console.error('[pruneStale] fetch session error:', err.message);
    return null;
  }
}

async function safeClientDisconnect(client) {
  try {
    if (client && typeof client.disconnect === 'function') await client.disconnect();
  } catch {
    // ignore
  }
}

function buildPeer(client, channelIdStr) {
  if (!channelIdStr) return null;
  const id = Number(channelIdStr);
  if (!Number.isSafeInteger(id)) return null;
  try {
    if (client && typeof client.getInputPeer === 'function') {
      const p = client.getInputPeer(id);
      if (p) return p;
    }
  } catch {}
  if (id < 0) {
    const abs = String(Math.abs(id));
    const stripped = abs.startsWith('100') ? -1 * Number(abs.slice(3)) : -id;
    if (Number.isSafeInteger(stripped) && client && typeof client.getInputPeer === 'function') {
      try { const p = client.getInputPeer(stripped); if (p) return p; } catch {}
    }
  }
  return null;
}

async function runPrunePass() {
  if (_running) return;
  _running = true;
  try {
    const account = await fetchSessionAccount();
    if (!account || !account.session) return;
    const apiId = parseInt(process.env.API_ID || '0', 10) || 0;
    const apiHash = String(process.env.API_HASH || '');
    if (!apiId || !apiHash) {
      try { console.error('[pruneStale] missing api_id/hash env, skip.'); } catch {}
      return;
    }
    let client = null;
    try {
      const { TelegramClient } = require('telegram');
      const { StringSession } = require('telegram/sessions');
      client = new TelegramClient(new StringSession(account.session), apiId, apiHash, {
        connectionRetries: 1,
      });
      try {
        await client.connect({ timeout: 15000 });
      } catch (err) {
        try { console.error('[pruneStale] connect failed:', err.message); } catch {}
        return;
      }
      let authorized = false;
      try { authorized = !!(await client.getMe()); } catch { authorized = false; }
      if (!authorized) {
        try { console.error('[pruneStale] userbot not authorized.'); } catch {}
        return;
      }

      const api = require('telegram/tl/api');
      let cursor = null;
      const perPage = 100;
      let totalDeleted = 0;
      let totalSeen = 0;
      let peerResolveFails = 0;

      while (true) {
        const q = {
          'source.channel_id': { $exists: true, $ne: null },
          'source.message_id': { $exists: true, $ne: null },
        };
        if (cursor) q._id = { $gt: cursor };
        const batch = await Video.find(q)
          .sort({ _id: 1 })
          .limit(perPage)
          .select('_id source caption_number')
          .lean()
          .catch(() => []);
        if (!batch || !batch.length) break;
        totalSeen += batch.length;

        const byChannel = new Map();
        for (const r of batch) {
          const k = String(r.source.channel_id);
          const arr = byChannel.get(k) || [];
          arr.push(r);
          byChannel.set(k, arr);
        }

        for (const [channelId, rows] of byChannel.entries()) {
          try {
            const peer = buildPeer(client, channelId);
            if (!peer) { peerResolveFails += 1; continue; }
            const ids = rows.map((r) => Number(r.source.message_id)).filter((x) => Number.isSafeInteger(x) && x > 0);
            if (!ids.length) continue;
            let messages = [];
            try {
              const resp = await client.invoke(
                new api.channels.GetMessages({
                  channel: peer,
                  id: ids.map((i) => new api.InputMessageID({ id: i })),
                })
              );
              messages = (resp && Array.isArray(resp.messages)) ? resp.messages : [];
            } catch (err) {
              try { console.error(`[pruneStale] channels.getMessages for ${channelId} failed:`, err.message); } catch {}
              continue;
            }
            const alive = new Set();
            for (const m of messages) {
              if (!m) continue;
              const cn = (m.className || (m.constructor && m.constructor.name) || '').toString();
              if (/Empty$/i.test(cn)) continue;
              if (typeof m.id === 'number') alive.add(m.id);
            }
            const deadRows = rows.filter((r) => !alive.has(Number(r.source.message_id)));
            if (!deadRows.length) continue;
            const deadRowIds = deadRows.map((r) => r._id);
            try {
              const dr = await Video.deleteMany({ _id: { $in: deadRowIds } });
              const n = Number(dr && dr.deletedCount) || 0;
              for (const r of deadRows) {
                try { queryCache.delete(`vid:${Number(r.caption_number)}`); } catch {}
              }
              totalDeleted += n;
            } catch (dbErr) {
              try { console.error('[pruneStale] dead row delete error:', dbErr.message); } catch {}
            }
          } catch (loopErr) {
            try { console.error(`[pruneStale] channel ${channelId} loop error:`, loopErr.message); } catch {}
          }
        }

        cursor = batch[batch.length - 1]._id;
        if (batch.length < perPage) break;
      }

      try {
        console.log(`[pruneStale] pass done. seen=${totalSeen} deleted=${totalDeleted} dead. peerFail=${peerResolveFails}.`);
      } catch {}
    } finally {
      safeClientDisconnect(client);
    }
  } catch (err) {
    try { console.error('[pruneStale] top-level pass error:', err.message); } catch {}
  } finally {
    _running = false;
  }
}

function startPruneLoop({ intervalMs = 20 * 60 * 1000 } = {}) {
  stopPruneLoop();
  _stopped = false;
  const firstTimer = setTimeout(async () => {
    try { await runPrunePass(); } catch {}
    if (_stopped) return;
    _timer = setInterval(async () => {
      try { await runPrunePass(); } catch {}
    }, intervalMs);
    if (_timer && typeof _timer.unref === 'function') _timer.unref();
  }, 5000);
  if (typeof firstTimer.unref === 'function') firstTimer.unref();
}

function stopPruneLoop() {
  _stopped = true;
  if (_timer) {
    try { clearInterval(_timer); } catch {}
    _timer = null;
  }
}

module.exports = {
  startPruneLoop,
  stopPruneLoop,
  runPrunePass,
};
