import {
  getWaiterManagementList,
  getWaiterDetail,
  dropWaiter,
  restoreWaiter,
  deleteWaiter,
  getSelectorList,
  toggleWaiterVisibility,
  getWaiterSelectorSettings,
  updateWaiterSelectorSettings,
} from "../controllers/waiterManagementController.js";

// ...existing routes...
router.get("/management/:id/selector-settings", protect, authorize("admin"), getWaiterSelectorSettings);
router.patch("/management/:id/selector-settings", protect, authorize("admin"), updateWaiterSelectorSettings);
