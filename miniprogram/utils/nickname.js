/**
 * 首页第一行昵称的唯一来源：缓存 key、兜底文案、读写校验都放在这里，
 * 避免「session 页写入用的 key」与「首页读取用的 key」各写一份而悄悄漂移。
 *
 * 背景（2026-09-26 需求）：第一行由写死的「用户ID」改为登录用户的微信昵称。
 * 微信自 2022-10-25 24:00 起收回了 wx.getUserProfile 的昵称能力——生效后发布的新版本
 * 一律返回默认灰头像与昵称「微信用户」，昵称**无法静默获取**；唯一合规路径是
 * 「头像昵称填写能力」（基础库 2.21.2+），即用户在 pages/session 主动确认一次，
 * 服务端校验后返回（MVP §24.1 Response data 含 nickname），
 * 再由 session 页写入本地缓存、首页读取展示。
 */

/** 本地缓存 key。首页读、session 页写都必须用它。 */
const NICKNAME_STORAGE_KEY = "nickname";

/** 昵称未取得时展示的兜底文案（首次进入、未登录、缓存被清、账号已注销）。 */
const FALLBACK_NICKNAME = "球友";

/**
 * 归一化昵称：非字符串、或 trim 后为空，一律返回 null。
 * 返回 null 的含义交给调用方决定——读取时回落兜底文案，写入时拒绝落库。
 */
function normalizeNickname(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 读取展示用昵称；缓存缺失、空白或脏数据一律回落兜底文案。 */
function resolveNickname() {
  const normalized = normalizeNickname(wx.getStorageSync(NICKNAME_STORAGE_KEY));
  return normalized === null ? FALLBACK_NICKNAME : normalized;
}

/** 写入昵称（登录成功后调用）。非法值不写入并返回 false。 */
function storeNickname(value) {
  const normalized = normalizeNickname(value);
  if (normalized === null) return false;
  wx.setStorageSync(NICKNAME_STORAGE_KEY, normalized);
  return true;
}

module.exports = {
  NICKNAME_STORAGE_KEY,
  FALLBACK_NICKNAME,
  normalizeNickname,
  resolveNickname,
  storeNickname,
};
