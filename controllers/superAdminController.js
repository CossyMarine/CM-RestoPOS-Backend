import Business from "../models/Business.js";
import User from "../models/User.js";
import AdminSettings from "../models/AdminSettings.js";
import bcrypt from "bcryptjs";
import { seedDefaultInventoryLocations } from "../models/InventoryLocation.js";
// AFTER
import EtimsConfig from "../models/EtimsConfig.js";
import { getProviderAdapter } from "../utils/etimsProviders/index.js";
import { EtimsConfigurationError } from "../utils/etimsErrors.js";
import { reconcileEtimsSubmissions } from "../utils/etimsReconciliation.js";

// @desc    Read-only eTIMS reconciliation snapshot for ONE explicitly chosen
//          business — never all businesses at once, and never a business
//          inferred from the superadmin's own account (superadmins have no
//          businessId of their own). businessId comes from the URL param,
//          validated against Business first — same pattern as
//          configureBusinessEtims below.
// @route   GET /api/superadmin/businesses/:id/etims-reconciliation
export const getBusinessEtimsReconciliation = async (req, res) => {
  try {
    const businessId = req.params.id;
    const business = await Business.findById(businessId);
    if (!business) return res.status(404).json({ message: "Business not found" });

    const report = await reconcileEtimsSubmissions(businessId);
    res.json(report);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Configure a business's eTIMS provider — for onboarding or
export const configureBusinessEtims = async (req, res) => {
  try {
    const businessId = req.params.id;
    const business = await Business.findById(businessId);
    if (!business) return res.status(404).json({ message: "Business not found" });

    const { provider, deviceInfo, credentials, environment, enabled, status, statusMessage } = req.body;

    if (!provider || typeof provider !== "string") {
      return res.status(400).json({ message: "provider is required" });
    }

    try {
      getProviderAdapter(provider.trim().toLowerCase());
    } catch (err) {
      if (err instanceof EtimsConfigurationError) {
        return res.status(400).json({ message: err.message });
      }
      throw err;
    }

    if (environment && !["sandbox", "production"].includes(environment)) {
      return res.status(400).json({ message: "environment must be 'sandbox' or 'production'" });
    }

    const config = await EtimsConfig.upsertForBusiness(businessId, provider, {
      deviceInfo,
      credentials,
      environment,
      enabled,
      status,
      statusMessage,
    });

    res.json({ message: "eTIMS configuration saved for business", config });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message:
          "Another eTIMS provider configuration is already enabled for this business. Disable it before enabling this one.",
      });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
// @desc    Create a new tenant business
// @route   POST /api/superadmin/businesses
export const createBusiness = async (req, res) => {
  try {
    const { name, phone, email, kraPin, plan } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Business name is required" });
    }

    const business = await Business.create({
      name,
      phone,
      email,
      kraPin,
      plan: plan || "trial",
      status: "active",
      subscriptionStatus: "trialing",
      subscriptionStart: new Date(),
    });

    await seedDefaultInventoryLocations(business._id);

    res.status(201).json({ business });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    List all businesses on the platform
// @route   GET /api/superadmin/businesses
export const listBusinesses = async (req, res) => {
  try {
    const businesses = await Business.find({ _bypassTenantGuard: true }).sort({ createdAt: -1 });
    res.json({ businesses });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Activate or deactivate a business
// @route   PATCH /api/superadmin/businesses/:id/status
export const toggleBusinessStatus = async (req, res) => {
  try {
    const { status } = req.body; // "active" | "suspended" | "closed"
    if (!["active", "suspended", "pending", "closed"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const business = await Business.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!business) return res.status(404).json({ message: "Business not found" });

    res.json({ business });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Create the first admin account for a business
// @route   POST /api/superadmin/businesses/:id/admin
export const createBusinessAdmin = async (req, res) => {
  try {
    const { fullName, method, contact, password } = req.body;
    const businessId = req.params.id;

    if (!fullName || !method || !contact || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (!["email", "phone"].includes(method)) {
      return res.status(400).json({ message: "Choose email or phone" });
    }

    const business = await Business.findById(businessId);
    if (!business) return res.status(404).json({ message: "Business not found" });

    const cleanContact = method === "email" ? contact.toLowerCase().trim() : contact.trim();

    const existing = await User.findOne({ [method]: cleanContact, businessId });
    if (existing) {
      return res.status(400).json({ message: "A user with that email/phone already exists for this business" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const admin = await User.create({
      fullName: fullName.trim(),
      password: hashedPassword,
      isAdmin: true,
      businessId,
      [method]: cleanContact,
    });

    res.status(201).json({
      message: "Business admin created",
      admin: { id: admin._id, fullName: admin.fullName, email: admin.email, phone: admin.phone },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Configure a business's payment/tax settings — used during
//          onboarding, before that business's own admin has ever logged in
// @route   PATCH /api/superadmin/businesses/:id/settings
export const configureBusinessSettings = async (req, res) => {
  try {
    const businessId = req.params.id;
    const business = await Business.findById(businessId);
    if (!business) return res.status(404).json({ message: "Business not found" });

    const { tillNumber, tillName, tax } = req.body;

    const settings = await AdminSettings.getSettings(businessId);
    if (tillNumber !== undefined) settings.tillNumber = tillNumber;
    if (tillName !== undefined) settings.tillName = tillName;
    if (tax && typeof tax === "object") {
      const current = settings.tax.toObject ? settings.tax.toObject() : settings.tax;
      settings.tax = { ...current, ...tax };
    }
    await settings.save();

    res.json({ message: "Settings configured", settings });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Platform-level snapshot (business count, active vs suspended, etc.)
// @route   GET /api/superadmin/overview
export const getPlatformOverview = async (req, res) => {
  try {
    const [total, active, suspended, trialing] = await Promise.all([
      Business.countDocuments({ _bypassTenantGuard: true }),
      Business.countDocuments({ status: "active", _bypassTenantGuard: true }),
      Business.countDocuments({ status: "suspended", _bypassTenantGuard: true }),
      Business.countDocuments({ subscriptionStatus: "trialing", _bypassTenantGuard: true }),
    ]);
    res.json({ totalBusinesses: total, active, suspended, trialing });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};