const express = require("express");
const mongoose = require("mongoose");
const winston = require("winston");

// Models (copied from your code)
const TransactionType = {
  DEPOSIT: "deposit",
  WITHDRAWAL: "withdrawal",
  TRANSFER: "transfer",
  RECEIVE: "receive",
};

const TransactionStatus = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELED",
};

const transactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(TransactionType),
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: Object.values(TransactionStatus),
      default: TransactionStatus.PENDING,
    },
    reference: { type: String, required: true, unique: true },
    santimpayRefId: { type: String, unique: true, sparse: true },
    santimpayTxnId: { type: String, unique: true, sparse: true },
    description: String,
    metadata: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

const Transaction = mongoose.model("Transaction", transactionSchema);

const userSchema = new mongoose.Schema({
  phone: String,
  wallet: { type: Number, default: 0, min: 0 },
});

const User = mongoose.model("Users", userSchema);

// Logger setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// Express app
const app = express();
app.use(express.json());

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => logger.info("MongoDB connected on Render"))
  .catch((err) =>
    logger.error("MongoDB connection error", { error: err.message })
  );

// Webhook handlers (from your paymentService.js)
const handleDepositCallback = async (callbackData) => {
  const data = callbackData.data || callbackData;
  const { txnId, Status, amount, reason, msisdn, refId, thirdPartyId } =
    data || {};

  if (!txnId || !Status || !thirdPartyId) {
    logger.error("Missing required fields in callback data", {
      txnId,
      Status,
      thirdPartyId,
    });
    throw new Error(
      "Invalid callback data: missing txnId, Status, or thirdPartyId"
    );
  }

  logger.info("Processing deposit callback", { txnId, Status, thirdPartyId });

  let transaction = await Transaction.findOne({ santimpayTxnId: txnId });
  if (transaction) {
    logger.warn("Duplicate webhook call detected", {
      txnId,
      existingStatus: transaction.status,
    });
    return transaction;
  }

  const [userId] = thirdPartyId.split("-");
  const user = await User.findOne({
    $or: [{ _id: userId }, { phone: msisdn }],
  });
  if (!user) {
    logger.error("User not found for deposit callback", {
      userId,
      msisdn,
      txnId,
    });
    throw new Error("User not found");
  }

  const baseAmount = Math.floor(parseFloat(amount) || 0);

  transaction = new Transaction({
    userId: user._id,
    type: TransactionType.DEPOSIT,
    amount: baseAmount,
    status: Status.toUpperCase(),
    santimpayTxnId: txnId,
    santimpayRefId: refId,
    reference: `deposit-${txnId}-${Date.now()}`,
    description: `deposited ${baseAmount} birr`,
    metadata: data,
  });

  if (Status.toUpperCase() === "COMPLETED" && baseAmount > 0) {
    user.wallet = (user.wallet || 0) + baseAmount;
    await user.save({ validateBeforeSave: false });
    logger.info("Wallet updated for deposit", {
      userId: user._id,
      updatedWallet: user.wallet,
      depositAmount: baseAmount,
    });
  }

  await transaction.save();
  logger.info("Deposit transaction processed", {
    txnId,
    status: transaction.status,
    userId: user._id,
  });
  return transaction;
};

const handleWithdrawalCallback = async (callbackData) => {
  const data = callbackData.data || callbackData;
  const { txnId, Status, amount, reason, msisdn, refId, thirdPartyId } =
    data || {};

  if (!txnId || !Status || !thirdPartyId) {
    logger.error("Missing required fields in callback data", {
      txnId,
      Status,
      thirdPartyId,
    });
    throw new Error(
      "Invalid callback data: missing txnId, Status, or thirdPartyId"
    );
  }

  logger.info("Processing withdrawal callback", {
    txnId,
    Status,
    thirdPartyId,
  });

  let transaction = await Transaction.findOne({ santimpayTxnId: txnId });
  if (transaction) {
    logger.warn("Duplicate webhook call detected", {
      txnId,
      existingStatus: transaction.status,
    });
    return transaction;
  }

  const [userId] = thirdPartyId.split("-");
  const user = await User.findOne({
    $or: [{ _id: userId }, { phone: msisdn }],
  });
  if (!user) {
    logger.error("User not found for withdrawal callback", {
      userId,
      msisdn,
      txnId,
    });
    throw new Error("User not found");
  }

  const baseAmount = Math.floor(parseFloat(amount) || 0);

  transaction = new Transaction({
    userId: user._id,
    type: TransactionType.WITHDRAWAL,
    amount: baseAmount,
    status: Status.toUpperCase(),
    santimpayTxnId: txnId,
    santimpayRefId: refId,
    reference: `withdrawal-${txnId}-${Date.now()}`,
    description: reason || `withdrawn ${baseAmount} birr`,
    metadata: data,
  });

  if (Status.toUpperCase() === "COMPLETED" && baseAmount > 0) {
    if (user.wallet < baseAmount) {
      transaction.status = TransactionStatus.FAILED;
      await transaction.save();
      logger.error("Insufficient funds for withdrawal", {
        userId: user._id,
        amount: baseAmount,
      });
      throw new Error("Insufficient funds after withdrawal");
    }
    user.wallet -= baseAmount;
    await user.save();
    logger.info("Wallet updated for withdrawal", {
      userId: user._id,
      amount: baseAmount,
    });
  }

  await transaction.save();
  logger.info("Withdrawal transaction processed", {
    txnId,
    status: transaction.status,
    userId: user._id,
  });
  return transaction;
};

// Routes (from your callbackController.js)
app.post("/api/v1/callbacks/deposit-callback", async (req, res) => {
  logger.info("Webhook received", {
    headers: req.headers,
    body: req.body,
    ip: req.ip,
  });
  try {
    const transaction = await handleDepositCallback(req.body);
    res.status(200).json({
      success: true,
      transactionId: transaction._id,
      status: transaction.status,
    });
  } catch (error) {
    logger.error("Deposit callback error", {
      error: error.message,
      data: req.body,
    });
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post("/api/v1/callbacks/withdrawal-callback", async (req, res) => {
  logger.info("Webhook received", {
    headers: req.headers,
    body: req.body,
    ip: req.ip,
  });
  try {
    const transaction = await handleWithdrawalCallback(req.body);
    res.status(200).json({
      success: true,
      transactionId: transaction._id,
      status: transaction.status,
    });
  } catch (error) {
    logger.error("Withdrawal callback error", {
      error: error.message,
      data: req.body,
    });
    res.status(400).json({ success: false, error: error.message });
  }
});

// Health check to keep Render awake
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  logger.info(`Render webhook server running on port ${PORT}`)
);
