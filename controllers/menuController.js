// controllers/menuController.js
import MenuItem from "../models/MenuItem.js";
import { cloudinary } from "../Config/cloudinary.js";
import { redisService } from "../routes/services/redis.service.js";

// @desc    Get all available menu items (pinned items always first)
// @route   GET /api/menu?businessId=<id>
// @access  Public
//
// This route has NO auth middleware in front of it (see routes/menuRoutes.js),
// so there is no req.businessId / req.scope here — the customer's device
// (having scanned a table QR code, same as registerCustomer/checkAvailability)
// must tell us which business's menu it wants via ?businessId=.
//
// NOTE: the cache key below is now namespaced per business. It previously
// was a single global "menu:all" key — meaning whichever business's menu
// got cached first would have been served to every other business's
// customers until the cache expired. Flagging this in case a hardcoded
// "menu:all" key is referenced anywhere else (e.g. cache invalidation on
// item create/update/delete, all of which now also need the businessId
// suffix — see redisService.del calls below).
export const getMenu = async (req, res) => {
  try {
    const { businessId } = req.query;
    if (!businessId) {
      return res.status(400).json({ message: "Missing business — scan the table QR code again" });
    }

    const cacheKey = `menu:${businessId}`;
    const cachedMenu = await redisService.get(cacheKey);
    if (cachedMenu) {
      return res.json(cachedMenu);
    }

    const items = await MenuItem.find({ isAvailable: true, businessId }).sort({
      pinned: -1,
      pinOrder: 1,
      category: 1,
      name: 1,
    });

    await redisService.set(cacheKey, items);
    return res.json(items);
  } catch (error) {
    console.error("Error fetching menu:", error.message);
    res.status(500).json({ message: "Failed to fetch menu" });
  }
};

// @desc    Upload a menu item image to Cloudinary (gallery/device upload)
// @route   POST /api/menu/upload-image
// @access  Protected — admin, manager, waiter, accountant
export const uploadMenuImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    res.json({
      message:  "Image uploaded",
      url:      req.file.path,      // Cloudinary secure URL
      publicId: req.file.filename,  // Cloudinary public_id (for later deletion)
    });
  } catch (error) {
    console.error("Error uploading menu image:", error.message);
    res.status(500).json({ message: "Image upload failed" });
  }
};

// @desc    Create a menu item
// @route   POST /api/menu
// @access  Protected — admin, manager, waiter, accountant
export const createMenuItem = async (req, res) => {
  try {
    const { businessId } = req;
    const { name, description, price, category, imageUrl, imagePublicId } = req.body;

    if (!name || !price) {
      return res.status(400).json({ message: "Name and price are required" });
    }

    const item = await MenuItem.create({
      businessId,
      name,
      description:   description || "",
      price,
      category:       category || "main",
      imageUrl:       imageUrl || null,
      imagePublicId:  imagePublicId || null,
    });

    await redisService.del(`menu:${businessId}`);
    res.status(201).json(item);
  } catch (error) {
    console.error("Error creating menu item:", error.message);
    res.status(500).json({ message: "Failed to create menu item" });
  }
};

// @desc    Update a menu item
// @route   PUT /api/menu/:id
// @access  Protected — admin, manager, waiter, accountant
export const updateMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { businessId } = req;
    const allowed = [
      "name",
      "description",
      "price",
      "category",
      "imageUrl",
      "imagePublicId",
      "isAvailable",
    ];
    const updates = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    const existing = await MenuItem.findOne({ _id: id, businessId });
    if (!existing) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    if (
      updates.imagePublicId !== undefined &&
      existing.imagePublicId &&
      existing.imagePublicId !== updates.imagePublicId
    ) {
      await cloudinary.uploader.destroy(existing.imagePublicId).catch(() => {});
    }

    const item = await MenuItem.findOneAndUpdate({ _id: id, businessId }, updates, {
      new: true,
      runValidators: true,
    });

    if (item) {
      await redisService.del(`menu:${businessId}`);
    }
    res.json(item);
  } catch (error) {
    console.error("Error updating menu item:", error.message);
    res.status(500).json({ message: "Failed to update menu item" });
  }
};

// @desc    Delete a menu item
// @route   DELETE /api/menu/:id
// @access  Protected — admin, manager, waiter, accountant
export const deleteMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { businessId } = req;
    const item = await MenuItem.findOneAndDelete({ _id: id, businessId });

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    await redisService.del(`menu:${businessId}`);

    if (item.imagePublicId) {
      await cloudinary.uploader.destroy(item.imagePublicId).catch(() => {});
    }

    res.json({ message: "Menu item deleted" });
  } catch (error) {
    console.error("Error deleting menu item:", error.message);
    res.status(500).json({ message: "Failed to delete menu item" });
  }
};

// @desc    Pin or unpin a menu item — pinned items float to the top for staff
// @route   PATCH /api/menu/:id/pin
// @access  Protected — admin, manager, waiter, accountant
export const togglePinMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { pinned } = req.body;
    const { businessId } = req;

    const item = await MenuItem.findOne({ _id: id, businessId });
    if (!item) return res.status(404).json({ message: "Menu item not found" });

    if (pinned) {
      const highestPinned = await MenuItem.findOne({ businessId, pinned: true }).sort({ pinOrder: -1 });
      item.pinOrder = highestPinned ? highestPinned.pinOrder + 1 : 0;
      item.pinned = true;
    } else {
      item.pinned = false;
      item.pinOrder = 0;
    }

    await item.save();
    await redisService.del(`menu:${businessId}`);
    res.json(item);
  } catch (error) {
    console.error("Error toggling pin:", error.message);
    res.status(500).json({ message: "Failed to update pin status" });
  }
};

// @desc    Persist a new drag-and-drop order for pinned items
// @route   PUT /api/menu/reorder-pinned
// @access  Protected — admin, manager, waiter, accountant
export const reorderPinnedMenu = async (req, res) => {
  try {
    const { businessId } = req;
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ message: "orderedIds array is required" });
    }

    // bulkWrite isn't covered by TenantGuard at all (it's not in the plugin's
    // guardedOps list), so businessId has to go in each op's filter by hand —
    // there's no guard here to catch a missing one.
    const ops = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, pinned: true, businessId },
        update: { $set: { pinOrder: index } },
      },
    }));
    await MenuItem.bulkWrite(ops);

    const items = await MenuItem.find({ isAvailable: true, businessId }).sort({
      pinned: -1,
      pinOrder: 1,
      category: 1,
      name: 1,
    });
    await redisService.del(`menu:${businessId}`);
    res.json(items);
  } catch (error) {
    console.error("Error reordering pinned menu:", error.message);
    res.status(500).json({ message: "Failed to reorder pinned items" });
  }
};