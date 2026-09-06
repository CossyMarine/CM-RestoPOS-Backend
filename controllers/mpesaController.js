// controllers/mpesaController.js
import PaymentConfig from "../models/PaymentConfig.js";
import MpesaTransaction from "../models/MpesaTransaction.js";
import Receipt from "../models/Receipt.js";
import { scopeModel } from "../utils/scopedModel.js";
import { initiateStkPush } from "../utils/mpesaClient.js";

export const stkPush = async (req, res) => {
  try {
    const { phoneNumber, amount, receiptId, accountReference, transactionDesc } = req.body;

    if (!phoneNumber || !amount) {
      return res.status(400).json({ message: "phoneNumber and amount are required" });
    }

    const config = await req
      .scope(PaymentConfig)
      .findOne({ provider: "mpesa" })
      .select("+consumerKey +consumerSecret +passkey");

    if (!config || !config.enabled) {
      return res.status(400).json({ message: "M-Pesa isn't configured for this business" });
    }

    const { consumerKey, consumerSecret, passkey } = config.getDecryptedCredentials();

    // No businessId in the callback URL anymore — it carries no tenant
    // authority. The callback derives ownership from the stored transaction.
    const callbackUrl = `${process.env.MPESA_CALLBACK_BASE_URL}/api/mpesa/callback`;

    const result = await initiateStkPush({
      shortcode: config.shortcode,
      consumerKey,
      consumerSecret,
      passkey,
      environment: config.environment,
      phoneNumber,
      amount,
      accountReference: accountReference || "POS Payment",
      transactionDesc,
      callbackUrl,
    });

    const transaction = await req.scope(MpesaTransaction).create({
      receiptId: receiptId || undefined,
      merchantRequestId: result.MerchantRequestID,
      checkoutRequestId: result.CheckoutRequestID,
      phoneNumber,
      amount,
      status: "pending",
    });

    res.status(201).json({
      message: "STK push sent — waiting for customer to complete on their phone",
      checkoutRequestId: transaction.checkoutRequestId,
      transactionId: transaction._id,
    });
  } catch (error) {
    const daraja = error.response?.data;
    res.status(500).json({
      message: "Failed to initiate M-Pesa payment",
      error: daraja?.errorMessage || error.message,
    });
  }
};

// @desc    Safaricom's callback — reports the outcome of an STK push
// @route   POST /api/mpesa/callback
// PUBLIC route, no businessId in the path or in req at all.
// The ONLY trustworthy source of "which business does this belong to" is
// the MpesaTransaction row we ourselves created during stkPush — never the
// caller, never the URL, never anything in the callback body.
// @desc    Safaricom's callback — reports the outcome of an STK push
// @route   POST /api/mpesa/callback
export const stkCallback = async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Received" });

  try {
    const stkCallback = req.body?.Body?.Callback;
    if (!stkCallback) return;

    const { CheckoutRequestID, ResultCode, CallbackMetadata } = stkCallback;
    if (!CheckoutRequestID) return;

    let update;
    if (ResultCode === 0) {
      const items = CallbackMetadata?.Item || [];
      const receiptNumber = items.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
      const amountPaid = items.find((i) => i.Name === "Amount")?.Value;

      update = {
        status: "success",
        completedAt: new Date(),
        mpesaReceiptNumber: receiptNumber,
      };

      // Sanity check happens against the pre-update doc below, since we
      // need `amountPaid` in scope either way — see the mismatch warning
      // after the findOneAndUpdate call.
      var _amountPaid = amountPaid;
    } else {
      const status = ResultCode === 1032 ? "cancelled" : "failed";
      update = { status, completedAt: new Date() };
    }

    // Steps 1 + 4 combined: find pending transaction AND update it in one
    // atomic operation. The { status: "pending" } filter is what makes this
    // safe against duplicate callback delivery — if a previous callback
    // already flipped this row out of "pending", this query matches zero
    // documents instead of racing a separate read-then-write.
    const transaction = await MpesaTransaction.findOneAndUpdate(
      { checkoutRequestId: CheckoutRequestID, status: "pending", _bypassTenantGuard: true },
      { $set: update },
      { new: true }
    );

    if (!transaction) {
      console.warn(`M-Pesa callback ignored — unknown or already-processed checkoutRequestId: ${CheckoutRequestID}`);
      return;
    }

    if (_amountPaid !== undefined && Number(_amountPaid) !== transaction.amount) {
      console.warn(
        `M-Pesa amount mismatch on ${CheckoutRequestID}: expected ${transaction.amount}, got ${_amountPaid}`
      );
    }

    // Step 2: businessId, derived from the transaction document itself —
    // never from the caller or the request.
    const businessId = transaction.businessId;

    // Step 5: update the receipt, scoped to that same businessId.
    if (transaction.receiptId) {
      const scopedReceipt = scopeModel(Receipt, businessId);
      await scopedReceipt.findOneAndUpdate(
        { _id: transaction.receiptId },
        {
          paymentStatus: transaction.status === "success" ? "paid" : "failed",
          mpesaReceiptNumber: transaction.mpesaReceiptNumber,
        }
      );
    }
  } catch (error) {
    console.error("M-Pesa callback processing error:", error.message);
  }
};