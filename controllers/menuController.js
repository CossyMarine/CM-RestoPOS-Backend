// controllers/menuController.js
import MenuItem from "../models/MenuItem.js";
import { cloudinary } from "../Config/cloudinary.js";
import { redisService } from "../routes/services/redis.service.js";

// @desc    Get all available menu items (pinned items always first)
// @route   GET /api/menu
// @access  Public
export const getMenu = async (req, res) => {
  try {
    const cachedMenu = await redisService.get("menu:all");
    if (cachedMenu) {
      return res.json(cachedMenu);
    }

   const items = await req.scope(MenuItem).find({ isAvailable: true }).sort({
      pinned: -1,
      pinOrder: 1,
      category: 1,
      name: 1,
    });

    await redisService.set("menu:all", items);
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
    const { name, description, price, category, imageUrl, imagePublicId } = req.body;

    if (!name || !price) {
      return res.status(400).json({ message: "Name and price are required" });
    }

    const item = await MenuItem.create({
      name,
      description:   description || "",
      price,
      category:       category || "main",
      imageUrl:       imageUrl || null,
      imagePublicId:  imagePublicId || null,
    });

    await redisService.del("menu:all");
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

    const existing = await MenuItem.findById(id);
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

    const item = await MenuItem.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (item) {
      await redisService.del("menu:all");
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
    const item = await MenuItem.findByIdAndDelete(id);

    if (!item) {
      return res.status(404).json({ message: "Menu item not found" });
    }

    await redisService.del("menu:all");

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

    const item = await MenuItem.findById(id);
    if (!item) return res.status(404).json({ message: "Menu item not found" });

    if (pinned) {
      const highestPinned = await MenuItem.findOne({ pinned: true }).sort({ pinOrder: -1 });
      item.pinOrder = highestPinned ? highestPinned.pinOrder + 1 : 0;
      item.pinned = true;
    } else {
      item.pinned = false;
      item.pinOrder = 0;
    }

    await item.save();
    await redisService.del("menu:all");
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
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ message: "orderedIds array is required" });
    }

    const ops = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, pinned: true },
        update: { $set: { pinOrder: index } },
      },
    }));
    await MenuItem.bulkWrite(ops);

    const items = await MenuItem.find({ isAvailable: true }).sort({
      pinned: -1,
      pinOrder: 1,
      category: 1,
      name: 1,
    });
    await redisService.del("menu:all");
    res.json(items);
  } catch (error) {
    console.error("Error reordering pinned menu:", error.message);
    res.status(500).json({ message: "Failed to reorder pinned items" });
  }
};
