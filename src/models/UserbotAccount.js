'use strict';

const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema(
  {
    number: { type: String, default: null },
    username: { type: String, default: null },
    userId: { type: String, default: null },
    session: { type: String, default: null },
  },
  { timestamps: true }
);

accountSchema.index({ number: 1 }, { sparse: true, unique: true });
accountSchema.index({ session: 1 }, { sparse: true });

module.exports = mongoose.model('UserbotAccount', accountSchema);
