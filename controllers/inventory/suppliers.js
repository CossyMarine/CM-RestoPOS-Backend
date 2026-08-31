// controllers/inventory/suppliers.js
import Supplier from "../../models/Supplier.js";
import InventoryReceiving from "../../models/InventoryReceiving.js";

export const createSupplier = async (req, res) => {
  try {
    const { businessId } = req;
    const { name, phone, email, address, contactPerson, note } = req.body;

    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (!normalizedName) {
      return res.status(400).json({ message: "Name is required" });
    }

    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    const existingSupplier = await Supplier.findOne({ businessId, name: { $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }, isActive: true });
    if (existingSupplier) {
      return res.status(400).json({ message: "Supplier name already exists" });
    }

    const supplier = await Supplier.create({
      businessId,
      name: normalizedName,
      phone: phone || "",
      email: normalizedEmail,
      address: address || "",
      contactPerson: contactPerson || "",
      note: note || "",
      isActive: true,
    });

    res.status(201).json(supplier);
  } catch (error) {
    console.error("Error creating supplier:", error.message);
    res.status(500).json({ message: "Failed to create supplier" });
  }
};

export const getSuppliers = async (req, res) => {
  try {
    const { businessId } = req;
    const filter = { businessId, ...(req.query.includeInactive === "true" ? {} : { isActive: true }) };
    const suppliers = await Supplier.find(filter).sort({ name: 1 });
    res.json(suppliers);
  } catch (error) {
    console.error("Error fetching suppliers:", error.message);
    res.status(500).json({ message: "Failed to fetch suppliers" });
  }
};

export const getSupplierById = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const supplier = await Supplier.findOne({ _id: id, businessId });
    if (!supplier) return res.status(404).json({ message: "Supplier not found" });
    res.json(supplier);
  } catch (error) {
    console.error("Error fetching supplier:", error.message);
    res.status(500).json({ message: "Failed to fetch supplier" });
  }
};

export const updateSupplier = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const supplier = await Supplier.findOne({ _id: id, businessId });
    if (!supplier) return res.status(404).json({ message: "Supplier not found" });

    const allowedFields = ["name", "phone", "email", "address", "contactPerson", "note", "isActive"];
    const updates = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (updates.name !== undefined) {
      const normalizedName = updates.name.trim();
      if (!normalizedName) {
        return res.status(400).json({ message: "Name is required" });
      }
      updates.name = normalizedName;
      const duplicate = await Supplier.findOne({
        _id: { $ne: id },
        businessId,
        name: { $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
        isActive: true,
      });
      if (duplicate) {
        return res.status(400).json({ message: "Supplier name already exists" });
      }
    }

    if (updates.email !== undefined && typeof updates.email === "string") {
      updates.email = updates.email.trim().toLowerCase();
    }

    Object.assign(supplier, updates);
    await supplier.save();

    res.json(supplier);
  } catch (error) {
    console.error("Error updating supplier:", error.message);
    res.status(500).json({ message: "Failed to update supplier" });
  }
};

export const deleteSupplier = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const supplier = await Supplier.findOne({ _id: id, businessId });
    if (!supplier) return res.status(404).json({ message: "Supplier not found" });

    supplier.isActive = false;
    await supplier.save();

    res.json({ message: "Supplier deactivated", supplier });
  } catch (error) {
    console.error("Error deactivating supplier:", error.message);
    res.status(500).json({ message: "Failed to deactivate supplier" });
  }
};

export const getSupplierReceivings = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const supplier = await Supplier.findOne({ _id: id, businessId });
    if (!supplier) return res.status(404).json({ message: "Supplier not found" });

    const receivings = await InventoryReceiving.find({ supplier: id, businessId })
      .populate({ path: "location", select: "name code" })
      .populate({ path: "items.inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate({ path: "items.unit", select: "name abbreviation" })
      .populate("receivedBy", "fullName")
      .sort({ createdAt: -1 });

    res.json(receivings);
  } catch (error) {
    console.error("Error fetching supplier receiving history:", error.message);
    res.status(500).json({ message: "Failed to fetch supplier receiving history" });
  }
};
