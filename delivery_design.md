# Delivery Pipeline Design — PboxTv Media Gateway

## Scope

This document describes how videos / photos / arbitrary files are delivered to end users
after being ingested from admin-controlled source channels (upload channels).
The goal is speed-first delivery under the constraint that **Bot API `file_id` strings are
bot-scoped** (a file_id produced by bot A cannot be reused by bot B, even for the same
uploaded file). The pipeline is therefore three-tiered, with each tier running only when
the previous tier fails:

```
query(n)  ->  hot_send_* (cached per-bot file_id)
           ->  cold_copy_forward (re-seeds per-bot file_id)
           ->  userbot_direct (Plan 4/5 GramJS MTProto fallback, session-gated)
```

Source code lives in [delivery.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/delivery.js).
Supporting modules:

- [captions.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/captions.js) — caption classifier + auto-allocation.
- [pruneStale.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/pruneStale.js) — periodic GramJS sweep for dead channel messages.
- [Video.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/models/Video.js) — persisted row shape + indexes.
- [bot.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/bot.js) — channel-post ingest, Clear Storage delete worker.

---

## 1. BOT_KEY — per-bot scoping for stored file_ids

Bot API `file_id` strings are opaque, bot-scoped identifiers. Two different bots cannot
share one even for the exact same uploaded file. To support swapping `.env` `BOT_TOKEN`
without losing cached hot-path delivery (after a one-time reseed), every Video row stores
a per-bot slot under `bot_file_ids[BOT_KEY]`.

`BOT_KEY` is derived at require-time from `.env`:

```js
// delivery.js:10
const BOT_KEY = String(process.env.CURRENT_BOT_KEY || (process.env.BOT_TOKEN || '').split(':')[0] || 'default').trim();
```

Default behaviour: token `123456:ABCdef...` → key `'123456'` (the numeric part before the
colon). To keep a stable key across bot swaps (or if you re-issue a token for the same
bot), override by setting `CURRENT_BOT_KEY` in `.env`.

Ingested media populates `bot_file_ids[BOT_KEY]` directly from the incoming
`msg.video.file_id` / `msg.document.file_id` / largest `msg.photo[*].file_id`. Cold-path
reseeding on the first delivery fills the same slot.

---

## 2. Three-tier delivery pipeline

### 2.1 Tier 1 — hot send (cached per-bot file_id)

`hotSendMedia` in [delivery.js:59-88](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/delivery.js#L59-L88)
dispatches based on `row.metadata.kind`:

```js
const fid = row.bot_file_ids[botKey];
if (!fid) return { ok: false, reason: 'no_file_id' };
// ...
if (kind === 'photo')        msg = await telegram.sendPhoto(chatId, fid, baseExtra);
else if (kind === 'document') msg = await telegram.sendDocument(chatId, fid, extra);
else                          msg = await telegram.sendVideo(chatId, fid, extra);
```

Media kind is populated by the channel-post ingest listener in [bot.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/bot.js)
from whichever of `msg.video | msg.document | largest(msg.photo[])` was non-empty at
ingest time. Each call is routed through the 28/s drain-timer rate limiter in
[rateLimit.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/queue/rateLimit.js)
to stay under Telegram's 30/s global Bot API limit.

`reply_to_message_id` is threaded through `baseExtra` so the delivered media is a direct
reply to the user's typed number (verified by unit tests in the reply-capture spies).

### 2.2 Tier 2 — cold copyMessage + forwardMessage fallback with reseeding

`coldForwardAndSeed` in [delivery.js:120-172](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/delivery.js#L120-L172)
runs whenever the hot path has no file_id for the current bot. It uses the durable
(channel_id, message_id) pair stored on the Video row:

```js
// 1st attempt — copyMessage keeps original caption / timestamp invisible to target.
const msg = await telegram.copyMessage(chatId, row.source.channel_id, row.source.message_id, extra);
// 2nd attempt — forwardMessage if copy fails (forwards show "forwarded from" header).
if (copy failed) msg = await telegram.forwardMessage(chatId, row.source.channel_id, row.source.message_id, extra);

// On success -> seed the returned file_id back into bot_file_ids[BOT_KEY]
if (msg && msg.video) {
  await Video.findOneAndUpdate(
    { _id: row._id },
    { $set: { [`bot_file_ids.${botKey}`]: msg.video.file_id, last_seen_at: new Date() } },
    { new: true }
  );
}
```

This is the crucial **reseeding step** when swapping bots: the new bot has zero cached
file_ids after restart, so every caption runs through this path **once** per (row, bot)
pair. After that the row's updated `bot_file_ids[NEW_BOT_KEY]` puts it back on the hot
path.

Cold path additionally gates on `channelCache.isApproved(source.channel_id)` — removing
a channel from the approved list (UI `❌` toggle) silently kills delivery even if a hot
file_id is still cached.

### 2.3 Tier 3 — GramJS MTProto direct delivery (Plan 4/5)

`userbotDirectFallback` in [delivery.js:174-189](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/delivery.js#L174-L189)
is intentionally decoupled from the bot token:

```js
const ok = await hasActiveUserbot();  // UserbotAccount.session != null
if (!ok) return { ok: false, reason: 'no_userbot_session' };
return { ok: false, reason: 'userbot_engine_stub' };
```

The userbot path uses `InputMediaDocument / InputPhoto (id, access_hash, file_reference)`
under GramJS, which are **observer-portable**: a userbot subscriber of the source channel
can materialise any media in that channel by `(id, access_hash)` regardless of which bot
the file was ingested through. Plan 4 delivers directly to the user chat; Plan 5 is
reserved for a refresh of `file_reference` when it ages out (handled silently, no UI
error ever visible to end users per requirements).

The stub `userbot_engine_stub` preserves the pipeline shape; a real GramJS worker can be
spliced in without touching the hot/cold layers above.

---

## 3. Silent gates — when delivery produces zero visible output

`deliverVideoForQuery` in [delivery.js:191-224](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/delivery.js#L191-L224)
returns specific sentinel reasons. The upstream call site in [bot.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/bot.js)
maps them to UI behaviour:

| reason                              | when                                                 | end-user UI (private chat) | group/channel UI |
|-------------------------------------|------------------------------------------------------|----------------------------|------------------|
| `no_approved_channels_silent`       | `channelCache.countApproved() === 0` (no ✅ channels) | silent                     | silent           |
| `video_channel_unapproved_silent`   | media's own source channel is deselected             | silent                     | silent           |
| `not_found`                         | caption number not in DB                             | **replies** `No media with that number❌` (reply-to msg id) | silent |
| `bad_input`                         | caption `<= 0` / non-integer                         | silent                     | silent           |
| `all_paths_exhausted`               | hot + cold + userbot all failed                      | silent (stale rows auto-deleted lazily) | silent |

Unit tests cover each gate with a dedicated spy case in
[test-delivery-captions.test.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/tests/test-delivery-captions.test.js).

---

## 4. Stale / dead-row cleanup (two strategies)

Admin manually deleting a post from the source channel, or Clear Storage wiping a batch,
leaves behind a Video row whose `(channel_id, message_id)` resolves to "message not
found". Two complementary detectors remove those orphan rows:

### 4.1 Lazy delete on cold-path 400 "message not found"

`copyForwardErrorLooksLikeDeadMessage` + `lazyDeleteIfDead` in
[delivery.js:90-118](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/delivery.js#L90-L118):

```js
function copyForwardErrorLooksLikeDeadMessage(err) {
  const d = String(err?.description || err?.message || '').toLowerCase();
  return d.includes('to copy not found')
      || d.includes('message to forward not found')
      || d.includes('message_id_invalid')
      || d.includes('message not found')
      || d.includes('channel_private')
      || (d.includes('bad request') && d.includes('message') && d.includes('not found'));
}
// -> if yes: Video.deleteOne({ _id: row._id }) + queryCache invalidation.
```

Generic 5xx / transport / throttling errors do NOT match — we never wipe rows during
Telegram outages. The lazy path guarantees a dead caption returns to `not_found` the
second time a user types it instead of thrashing the cold path forever.

### 4.2 Periodic 20-min GramJS sweep (covers never-queried rows)

`runPrunePass` / `startPruneLoop` in [pruneStale.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/pruneStale.js)
is scheduled in [server.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/server.js)
after cache preload (5 s delay → first pass, then every 20 min). It uses the first saved
`UserbotAccount.session` to connect via GramJS, paginates all Video rows 100/page, groups
them by source channel, and probes each batch with MTProto `channels.GetMessages`:

```js
const res = await client.invoke(new api.channels.GetMessages({
  channel: resolvedInputPeer,
  id: ids.map(i => new api.InputMessageID({ id: i })),
}));
const alive = new Set();
for (const m of res.messages) if (!String(m.className).endsWith('Empty')) alive.push(m.id);
// rows whose id is missing from alive -> Video.deleteMany({ _id: { $in: deadRowIds } })
```

No userbot session in DB → early return, zero console/UI noise. All errors during the
pass (peer resolution, channel probe, DB delete) are swallowed with `console.error`
only per the silent-failure UI rule.

---

## 5. Clear Storage menu — delete channel messages, keep rows

`🧹 Clear Storage` main-menu button opens a `Yes/No` confirm screen.
`Yes` worker in [bot.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/bot.js):

1. Fetch first `UserbotAccount` with `session != null` → silent skip if none.
2. `new TelegramClient(new StringSession(account.session), apiId, apiHash)` + `getMe()`.
3. Paginate all Video rows, group per `(source.channel_id, [message_id...])`.
4. Per chunk → `client.invoke(new api.channels.DeleteMessages({ channel: peer, id: InputMessageID[] }))`.
5. UI always replies with exactly `Storage cleared.` + main menu, regardless of errors.

**Important distinction vs stale cleanup:**
- Clear Storage deletes **actual channel posts** via userbot; Video rows are kept.
- Lazy delete + pruneStale delete **Video rows**; channel posts stay untouched.
- After Clear Storage, the lazy detector on the next user query cleans up each newly-orphan
  row automatically (dead message 400 → `Video.deleteOne`).

---

## 6. Bot-swap playbook (what happens when you change BOT_TOKEN)

Based on the pipeline above, swapping `.env` `BOT_TOKEN` to a different bot token behaves
as follows:

1. **Tier 1 (hot) — dead on every legacy row.** `BOT_KEY` changes so `bot_file_ids[new key]`
   is empty. Hot path returns `no_file_id` → fall through.
2. **Tier 2 (cold) — succeeds once per legacy row and reseeds `bot_file_ids[NEW_BOT_KEY]`.**
   Precondition: the NEW bot must be a member/admin of **every source upload channel**, or
   else `channel_private` / `forbidden` kills cold delivery. First user query → media is
   delivered via `copyMessage`, returned `Message.video.file_id` (etc.) is written to the
   new slot, cached row is refreshed. Same caption queried again later → straight to hot.
3. **Tier 3 (userbot) — 100 % unaffected.** The GramJS StringSession is tied to a user
   account, not a bot token. Previously saved sessions continue to work.
4. **Newly ingested media.** Ingest listener sees files directly on the NEW bot's
   `msg.video/document/photo[]` → writes `bot_file_ids[NEW_BOT_KEY]` immediately.
   Hot path works from day zero for new uploads.
5. **Clear Storage + pruneStale.** Both use GramJS sessions, unaffected by the swap.
6. **Stale rows.** Lazy detector fires as before if any old row's source message was
   deleted between the swap and the first user query.

Recommended cut-over checklist (not implemented as code; ops runbook):

- [ ] Add the NEW bot as admin to every ✅ approved upload channel (channel_private guard).
- [ ] Keep `CURRENT_BOT_KEY` unset unless you intentionally want to share cached file_ids
      across rotations (only safe for same bot → new token, not different bots).
- [ ] Update `.env`, restart.
- [ ] Optional one-time preseed: iterate all Video rows and run `copyMessage` to a throwaway
      private chat with the NEW bot once, so real users never pay the cold-path latency.
- [ ] Verify a sample caption via private chat.

---

## 7. Persisted row shape (Video model)

All delivery tiers are row-shaped. See [Video.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/models/Video.js).

```js
{
  _id: ObjectId,
  caption_number: Number,           // 1..99999, globally unique (indexed unique)
  source: {
    channel_id: Number,             // -100XXXX (bot format), matches my_chat_member listener
    message_id: Number,             // Telegram channel_post.message_id (unique per channel)
  },                                // index unique on (source.channel_id, source.message_id)
  metadata: {
    kind:   'video' | 'photo' | 'document',   // selects hot send method
    mime_type: String,
    file_name: String,
    file_size: Number,
    uploaded_at: Date,
  },
  bot_file_ids: {                   // sparse map, BOT_KEY -> Bot API file_id for that bot
    [BOT_KEY_1]: 'BQACAg...',
    [BOT_KEY_2]: 'BQACAg...',      // populated on cold path or ingest-time
  },
  file_unique_id: String,          // Telegram cross-bot stable id, SPARSE unique index
  mtproto: { id, access_hash, file_reference },  // reserved for Plan 4/5
  last_seen_at: Date,
}
```

Indexes:

- `{ caption_number: 1 }` — unique.
- `{ (source.channel_id, source.message_id) }` — unique compound.
- `{ file_unique_id: 1 }` — **sparse** unique (only rows with a non-null unique id are indexed;
  this avoids the E11000 null-dup explosion for uploads that don't carry one).
- `{ mtproto.id: 1 }` — sparse unique.

---

## 8. Caption allocation + channel reply texts

Caption number assignment + replies live in
[captions.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/services/captions.js)
with the call sites split in [bot.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Pbox/src/bot.js)
for each case:

| case                                       | reply text                                                         | HTML bold |
|--------------------------------------------|--------------------------------------------------------------------|-----------|
| Admin posts file with **no caption**       | `<b>{n}</b>` plain number — `replyCaptionInChannel`               | yes       |
| Admin posts with **invalid / ≤0 / >5 dig** | `Invalid number❌\nChanged to <b>{n}</b>` — `replyInvalidCaptionChanged` | yes (n)   |
| Admin posts with **duplicate taken n**     | `Number already exists❌\nMedia number changed to {n}✅` — `replyCollisionNotice` (via `handleCaptionCollision`) | yes (n)   |

All three use `parse_mode: 'HTML'`; only the integer portion is wrapped in `<b>…</b>` so
no escaping is needed (caption numbers are digits only).
