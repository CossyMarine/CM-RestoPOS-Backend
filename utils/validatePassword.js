// utils/validatePassword.js
// Single source of truth for password strength rules across all four
// password flows (register, admin-create, change, reset). Returns which
// specific requirements failed so the frontend can show them precisely.

const SPECIAL_CHAR_REGEX = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/;

export const validatePassword = (password) => {
  const errors = [];

  if (!password || password.length < 8) {
    errors.push("Password must be at least 8 characters");
  }
  if (!password || !/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter");
  }
  if (!password || !/[0-9]/.test(password)) {
    errors.push("Password must contain at least one number");
  }
  if (!password || !SPECIAL_CHAR_REGEX.test(password)) {
    errors.push("Password must contain at least one special character");
  }

  return { valid: errors.length === 0, errors };
};