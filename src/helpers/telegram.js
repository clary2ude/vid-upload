'use strict';

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { randomFingerprint } = require('./fingerprint');

function getDCAddress(dcId) {
  const map = {
    1: '149.154.175.53',
    2: '149.154.167.51',
    3: '149.154.175.100',
    4: '149.154.167.91',
    5: '91.108.56.133',
  };
  return map[dcId] || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendCodeWithRetry(client, phone, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber: phone,
          apiId: Number(process.env.API_ID),
          apiHash: process.env.API_HASH,
          settings: new Api.CodeSettings({
            allowFlashcall: true,
            currentNumber: true,
            allowAppHash: true,
            allowMissedCall: true,
          }),
        })
      );
      return { success: true, phoneCodeHash: result.phoneCodeHash };
    } catch (error) {
      const msg = String(error.message || error.errorMessage || '');
      if (msg.startsWith('PHONE_MIGRATE_')) {
        try {
          const dcId = Number(msg.split('_').pop());
          await client.disconnect().catch(() => {});
          await sleep(2000);
          const fp = randomFingerprint();
          const newClient = new TelegramClient(new StringSession(''), Number(process.env.API_ID), process.env.API_HASH, {
            useWSS: false,
            autoReconnect: true,
            timeout: 30000,
            requestRetries: 3,
            connectionRetries: 5,
            retryDelay: 1000,
            initialServerAddress: getDCAddress(dcId),
            deviceModel: fp.deviceModel,
            systemVersion: fp.systemVersion,
            appVersion: fp.appVersion,
            langCode: fp.langCode,
            systemLangCode: fp.systemLangCode,
          });
          await newClient.connect();
          const result = await newClient.invoke(
            new Api.auth.SendCode({
              phoneNumber: phone,
              apiId: Number(process.env.API_ID),
              apiHash: process.env.API_HASH,
              settings: new Api.CodeSettings({
                allowFlashcall: true, currentNumber: true, allowAppHash: true, allowMissedCall: true,
              }),
            })
          );
          return { success: true, phoneCodeHash: result.phoneCodeHash, client: newClient };
        } catch (migErr) {
          if (attempt === maxRetries) return { success: false, error: String(migErr.message || migErr) };
        }
      } else if (attempt === maxRetries) {
        return { success: false, error: String(error.message || error) };
      }
      await sleep(2000 * attempt);
    }
  }
  return { success: false, error: 'Max retries exceeded' };
}

module.exports = { sendCodeWithRetry, sleep, getDCAddress };
