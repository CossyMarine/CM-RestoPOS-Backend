// controllers/paymentConfigController.js
import PaymentConfig from "../models/PaymentConfig.js";

// @desc    Get this business's M-Pesa config (credentials never returned)
// @route   GET /api/payment-config/:provider
export const getPaymentConfig = async (req, res) => {
  try {
    const config = await req.scope(PaymentConfig).findOne({ provider: req.params.provider });
    if (!config) return res.status(404).json({ message: "No config for this provider yet" });
    res.json({ config }); // toJSON transform strips secrets automatically
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Create/update this business's M-Pesa config
// @route   PUT /api/payment-config/:provider
// controllers/paymentConfigController.js

export const setPaymentConfig = async (req, res) => {
  try {
    const { shortcode, shortcodeType, consumerKey, consumerSecret, passkey, environment, enabled } = req.body;

    if (environment && !["sandbox", "production"].includes(environment)) {
      return res.status(400).json({ message: "environment must be 'sandbox' or 'production'" });
    }
    if (shortcodeType && !["till", "paybill"].includes(shortcodeType)) {
      return res.status(400).json({ message: "shortcodeType must be 'till' or 'paybill'" });
    }

    const config = await PaymentConfig.upsertForBusiness(req.businessId, "mpesa", {
      shortcode,
      shortcodeType,
      consumerKey,
      consumerSecret,
      passkey,
      environment,
      enabled,
    });

    res.json({ message: "Payment config saved", config });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Server error", error: error.message });
  }
};