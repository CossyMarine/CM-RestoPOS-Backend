// Get current date object anchored to East Africa Time (Africa/Nairobi)
export const getKenyanDate = () => {
  const now = new Date();
  const kenyaString = now.toLocaleString("en-US", { timeZone: "Africa/Nairobi" });
  return new Date(kenyaString);
};

export const getDateRangePreset = (preset) => {
  const now = getKenyanDate();
  const start = new Date(now);
  const end = new Date(now);

  // Set end of day to 23:59:59.999
  end.setHours(23, 59, 59, 999);

  switch (preset) {
    case "today":
      start.setHours(0, 0, 0, 0);
      break;

    case "this_week": {
      // Start of week (Monday)
      const day = start.getDay();
      const diff = start.getDate() - day + (day === 0 ? -6 : 1);
      start.setDate(diff);
      start.setHours(0, 0, 0, 0);
      break;
    }

    case "last_7_days":
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      break;

    case "this_month":
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      break;

    case "last_30_days":
      start.setDate(start.getDate() - 29);
      start.setHours(0, 0, 0, 0);
      break;

    default:
      start.setHours(0, 0, 0, 0);
  }

  return { startDate: start, endDate: end };
};
