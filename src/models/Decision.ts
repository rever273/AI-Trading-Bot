import mongoose from 'mongoose';

const decisionSchema = new mongoose.Schema(
    {
        signal: { type: String, required: true, enum: ['buy', 'sell'] },
        coin: { type: String, required: true },
        quantity: { type: Number },
        profit_target: { type: Number },
        stop_loss: { type: Number },
        leverage: { type: Number },
        risk_usd: { type: Number },
        risk_pct: { type: Number },
        confidence: { type: Number },
        invalidation_condition: { type: String },
    },
    {
        timestamps: true,
    },
);

export const DecisionModel = mongoose.model('Decision', decisionSchema);
