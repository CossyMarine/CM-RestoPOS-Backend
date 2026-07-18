// controllers/menuController.js
import MenuItem from "../models/MenuItem.js";
import { cloudinary } from "../config/cloudinary.js";

// @desc    Get all available menu items
// @route   GET /api/menu
// @access  Public
export const getMenu = async (req, res) => {
  try {
    const items = await MenuItem.find({ isAvailable: true }).sort({
      category: 1,
      name: 1,
    });
    res.json(items);
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

    // If the image is being replaced, delete the old Cloudinary asset
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

    if (item.imagePublicId) {
      await cloudinary.uploader.destroy(item.imagePublicId).catch(() => {});
    }

    res.json({ message: "Menu item deleted" });
  } catch (error) {
    console.error("Error deleting menu item:", error.message);
    res.status(500).json({ message: "Failed to delete menu item" });
  }
};
