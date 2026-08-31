// controllers/inventory/batches.js
import InventoryBatch from "../../models/InventoryBatch.js";
import InventoryStock from "../../models/InventoryStock.js";
import { requireInventoryIds, requireObjectId } from "./helpers.js";

export const getBatches = async (req, res) => {
  try {
    const { businessId } = req;
    const { item, location, supplier, status, expiringBefore } = req.query;
    requireInventoryIds(req.query, [["item", "inventory item"], ["location", "location"], ["supplier", "supplier"]]);
    const filter = { businessId };
    if (item) filter.inventoryItem = item;
    if (location) filter.location = location;
    if (supplier) filter.supplier = supplier;
    if (status) filter.status = status;
    if (expiringBefore) {
      const date = new Date(expiringBefore);
      if (Number.isNaN(date.getTime())) throw new Error("Invalid expiry date");
      filter.expiryDate = { $lte: date };
    }
    const batches = await InventoryBatch.find(filter)
      .populate("inventoryItem", "name unit")
      .populate("location", "name code")
      .populate("supplier", "name")
      .sort({ expiryDate: 1, createdAt: 1 });
    res.json(batches);
  } catch (error) {
    if (error.message.startsWith("Invalid ")) return res.status(400).json({ message: error.message });
    res.status(500).json({ message: "Failed to fetch batches" });
  }
};

export const getBatchById = async (req, res) => {
  try {
    const { businessId } = req;
    requireObjectId(req.params.id, "batch");
    const batch = await InventoryBatch.findOne({ _id: req.params.id, businessId })
      .populate({ path: "inventoryItem", populate: { path: "unit", select: "name abbreviation" } })
      .populate("location", "name code").populate("supplier", "name")
      .populate("receiving").populate("production");
    if (!batch) return res.status(404).json({ message: "Batch not found" });
    res.json(batch);
  } catch (error) {
    if (error.message.startsWith("Invalid ")) return res.status(400).json({ message: error.message });
    res.status(500).json({ message: "Failed to fetch batch" });
  }
};

export const getExpiringBatches = async (req, res) => {
  try {
    const { businessId } = req;
    const days = Math.max(0, Number(req.query.days ?? 30));
    if (!Number.isFinite(days)) return res.status(400).json({ message: "days must be a number" });
    const now = new Date();
    const until = new Date(now.getTime() + days * 86400000);
    const batches = await InventoryBatch.find({ businessId, quantity: { $gt: 0 }, status: { $ne: "cancelled" }, expiryDate: { $lte: until } })
      .populate("inventoryItem", "name").populate("location", "name code").sort({ expiryDate: 1 });
    res.json({ now, until, batches });
  } catch (error) { res.status(500).json({ message: "Failed to fetch expiring batches" }); }
};

export const getInventoryIntegrity = async (req, res) => {
  try {
    const { businessId } = req;
    const stocks = await InventoryStock.find({ businessId }).populate("item", "name").populate("location", "name code");
    const issues = [];
    const rows = [];
    for (const stock of stocks) {
      const batches = await InventoryBatch.find({ businessId, inventoryItem: stock.item._id, location: stock.location._id, status: { $ne: "cancelled" } }).select("quantity");
      const batchQuantity = batches.reduce((sum, batch) => sum + Number(batch.quantity), 0);
      const unbatchedQuantity = stock.unbatchedQuantity === undefined || stock.unbatchedQuantity === null ? null : Number(stock.unbatchedQuantity);
      const expected = unbatchedQuantity === null ? null : batchQuantity + unbatchedQuantity;
      const variance = expected === null ? null : Number(stock.quantity) - expected;
      const row = { item: stock.item, location: stock.location, quantity: stock.quantity, batchQuantity, unbatchedQuantity, variance };
      rows.push(row);
      if (unbatchedQuantity === null || Math.abs(variance) > 0.000001) issues.push(row);
    }
    res.json({ healthy: issues.length === 0, issues, rows });
  } catch (error) { res.status(500).json({ message: "Failed to build inventory integrity report" }); }
};
