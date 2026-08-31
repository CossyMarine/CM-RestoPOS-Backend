// controllers/inventory/locations.js
import InventoryLocation from "../../models/InventoryLocation.js";

export const getLocations = async (req, res) => {
  try {
    const { businessId } = req;
    const locations = await InventoryLocation.find({ businessId }).sort({ name: 1 });
    res.json(locations);
  } catch (error) {
    console.error("Error fetching inventory locations:", error.message);
    res.status(500).json({ message: "Failed to fetch inventory locations" });
  }
};

export const createLocation = async (req, res) => {
  try {
    const { businessId } = req;
    const { name, code } = req.body;
    if (!name || !code) {
      return res.status(400).json({ message: "Name and code are required" });
    }

    const location = await InventoryLocation.create({
      businessId,
      name: name.trim(),
      code: code.trim().toUpperCase(),
    });

    res.status(201).json(location);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: "Location name or code already exists" });
    }
    console.error("Error creating inventory location:", error.message);
    res.status(500).json({ message: "Failed to create inventory location" });
  }
};

export const updateLocation = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const updates = {};

    if (req.body.name !== undefined) updates.name = req.body.name.trim();
    if (req.body.code !== undefined) updates.code = req.body.code.trim().toUpperCase();
    if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No valid update fields provided" });
    }

    const location = await InventoryLocation.findOneAndUpdate({ _id: id, businessId }, updates, {
      new: true,
      runValidators: true,
    });

    if (!location) return res.status(404).json({ message: "Inventory location not found" });
    res.json(location);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: "Location name or code already exists" });
    }
    console.error("Error updating inventory location:", error.message);
    res.status(500).json({ message: "Failed to update inventory location" });
  }
};

export const deleteLocation = async (req, res) => {
  try {
    const { businessId } = req;
    const { id } = req.params;
    const location = await InventoryLocation.findOneAndUpdate({ _id: id, businessId }, { isActive: false }, { new: true });

    if (!location) return res.status(404).json({ message: "Inventory location not found" });
    res.json({ message: "Location deactivated", location });
  } catch (error) {
    console.error("Error deactivating inventory location:", error.message);
    res.status(500).json({ message: "Failed to deactivate inventory location" });
  }
};
