const AUTH_SESSION_STORAGE_KEY = "auth_session";

function parseExpiresAt(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeAuthSession(value) {
  if (!value || typeof value !== "object") return null;
  const accessToken = typeof value.access_token === "string" ? value.access_token.trim() : "";
  if (!accessToken) return null;
  const expiresMs = parseExpiresAt(value.expires_at);
  if (expiresMs === null) return null;
  return {
    access_token: accessToken,
    expires_at: new Date(expiresMs).toISOString(),
  };
}

function isAuthSessionActive(session, now) {
  const normalized = normalizeAuthSession(session);
  if (!normalized) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) return false;
  return Date.parse(normalized.expires_at) > nowMs;
}

function readAuthSession() {
  try {
    return normalizeAuthSession(wx.getStorageSync(AUTH_SESSION_STORAGE_KEY));
  } catch (_error) {
    return null;
  }
}

function writeAuthSession(session) {
  const normalized = normalizeAuthSession(session);
  if (!normalized) return false;
  wx.setStorageSync(AUTH_SESSION_STORAGE_KEY, normalized);
  return true;
}

function clearAuthSession() {
  wx.removeStorageSync(AUTH_SESSION_STORAGE_KEY);
}

module.exports = {
  AUTH_SESSION_STORAGE_KEY,
  normalizeAuthSession,
  isAuthSessionActive,
  readAuthSession,
  writeAuthSession,
  clearAuthSession,
};
