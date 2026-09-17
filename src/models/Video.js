'use strict';

const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema(
  {
    caption_number: { type: Number, required: true, unique: true },
    mtproto: {
      type: new mongoose.Schema(
        {
          type: { type: String, required: true, enum: ['document', 'photo'] },
          id: { type: String, required: true },
          access_hash: { type: String, required: true },
          file_reference: { type: String, default: '' },
          dc_id: { type: Number, default: 0 },
        },
        { _id: false }
      ),
      default: null,
    },
    file_unique_id: { type: String, default: null, sparse: true, unique: true },
    source: {
      type: new mongoose.Schema(
        {
          channel_id: { type: String, required: true },
          message_id: { type: Number, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    metadata: {
      type: new mongoose.Schema(
        {
          kind: { type: String, enum: ['video', 'photo'], default: 'video' },
          mime_type: { type: String, default: '' },
          file_name: { type: String, default: '' },
          file_size: { type: Number, default: 0 },
          uploaded_at: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
      default: () => ({}),
    },
    bot_file_ids: { type: mongoose.Schema.Types.Mixed, default: {} },
    last_seen_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

videoSchema.index({ 'mtproto.id': 1 }, { unique: true, sparse: true });
videoSchema.index({ 'source.channel_id': 1, 'source.message_id': 1 }, { unique: true });
videoSchema.index({ 'metadata.uploaded_at': -1 });

module.exports = mongoose.model('Video', videoSchema);
