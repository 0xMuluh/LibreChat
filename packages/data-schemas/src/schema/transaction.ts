import mongoose, { Schema, Document, Types } from 'mongoose';
import type { TransactionImpacts } from '~/types/transaction';

// @ts-ignore
export interface ITransaction extends Document {
  user: Types.ObjectId;
  conversationId?: string;
  tokenType: 'prompt' | 'completion' | 'credits';
  model?: string;
  context?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  impacts?: TransactionImpacts;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

const impactRange = new Schema({ min: Number, max: Number }, { _id: false });

/** Set on completion transactions only; absent when no estimate was attempted */
const impactsSchema = new Schema<TransactionImpacts>(
  {
    energy: impactRange,
    gwp: impactRange,
    adpe: impactRange,
    pe: impactRange,
    wcf: impactRange,
    warnings: { type: [String], default: undefined },
    unmapped: Boolean,
  },
  { _id: false },
);

const transactionSchema: Schema<ITransaction> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    tokenType: {
      type: String,
      enum: ['prompt', 'completion', 'credits'],
      required: true,
    },
    model: {
      type: String,
      index: true,
    },
    context: {
      type: String,
    },
    valueKey: {
      type: String,
    },
    rate: Number,
    rawAmount: Number,
    tokenValue: Number,
    inputTokens: { type: Number },
    writeTokens: { type: Number },
    readTokens: { type: Number },
    messageId: { type: String },
    impacts: { type: impactsSchema },
    tenantId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

export default transactionSchema;
