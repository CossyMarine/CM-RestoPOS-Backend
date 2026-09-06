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
export const setPaymentConfig = async (req, res) => {
  try {
    const { shortcode, consumerKey, consumerSecret, passkey, environment, enabled } = req.body;

    const config = await PaymentConfig.upsertForBusiness(req.businessId, req.params.provider, {
      shortcode,
      consumerKey,
      consumerSecret,
      passkey,
      environment,
      enabled,
    });

    res.json({ message: "Payment config saved", config });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};