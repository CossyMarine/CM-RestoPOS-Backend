// Get current date object anchored to East Africa Time (Africa/Nairobi)
export const getKenyanDate = () => {
  const now = new Date();
  const kenyaString = now.toLocaleString("en-US", { timeZone: "Africa/Nairobi" });
  return new Date(kenyaString);
};

// Same trick as getKenyanDate, but for an arbitrary input date/string instead
// of "now" — lets us anchor a specific calendar date (e.g. a date picker
// value) to Kenya's wall clock instead of the server's.
const toKenyanWallClock = (dateInput) => {
  const base = dateInput ? new Date(dateInput) : new Date();
  const kenyaString = base.toLocaleString("en-US", { timeZone: "Africa/Nairobi" });
  return new Date(kenyaString);
};

// Start (00:00:00.000) and end (23:59:59.999) of the Kenyan calendar day
// that `dateInput` falls on. Defaults to today (Kenya) if omitted.
export const getKenyanDayBounds = (dateInput) => {
  const kenyaDate = toKenyanWallClock(dateInput);

  const start = new Date(kenyaDate);
  start.setHours(0, 0, 0, 0);

  const end = new Date(kenyaDate);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

// Rolling boundaries (today / this week / this month / this year), all
// anchored to Kenya time. Week starts Sunday, matching the original
// waiter-management logic this replaces.
export const getKenyanDateRanges = () => {
  const now = getKenyanDate();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  return { startOfToday, startOfWeek, startOfMonth, startOfYear };
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
