'use strict';

const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true, unique: true },
    title: { type: String, default: null },
    username: { type: String, default: null },
    isApproved: { type: Boolean, default: false },
    addedBy: { type: Number, default: null },
    addedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

channelSchema.index({ isApproved: 1 });
channelSchema.index({ username: 1 }, { sparse: true });

module.exports = mongoose.model('UploadChannel', channelSchema);
