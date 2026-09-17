'use strict';

const DEVICE_POOL = [
  { deviceModel: 'Samsung Galaxy S21', systemVersion: 'Android 12', appVersion: '9.3.3', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Samsung Galaxy S22 Ultra', systemVersion: 'Android 13', appVersion: '9.6.7', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Samsung Galaxy A52', systemVersion: 'Android 11', appVersion: '9.2.1', langCode: 'en', systemLangCode: 'en-GB' },
  { deviceModel: 'Xiaomi Redmi Note 11', systemVersion: 'Android 12', appVersion: '9.3.1', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Pixel 6', systemVersion: 'Android 13', appVersion: '9.5.4', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'iPhone 14 Pro', systemVersion: '16.2', appVersion: '9.6.0', langCode: 'en', systemLangCode: 'en-US' },
];

function randomFingerprint() {
  return DEVICE_POOL[Math.floor(Math.random() * DEVICE_POOL.length)];
}

module.exports = { randomFingerprint };
