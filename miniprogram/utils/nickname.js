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
 * 首页第一行昵称的最大显示字数，超过则截断成「前 11 字…」。
 *
 * 为什么截断在 JS 而不在 CSS：CSS 想「只截昵称、保住问候」就必须给昵称段
 * 设 display:inline-block + 限宽，而微信的 <text> 是组件而非标准行内元素，
 * 那样会让同一行拆成两个盒子、出现上下错行（2026-09-26 实机踩到过）。
 *
 * 12 字的依据：截断后最长 12 字 + 「，今天看哪场？」7 字 = 19 字。
 * 按 750rpx 页宽等比例实测（375px 视口复现本页样式）：整行约需 552rpx，
 * 顶栏内容区约 686rpx，余量约 134rpx —— 问候一定放得下，不会被省略号吃掉。
 */
const NICKNAME_DISPLAY_MAX = 12;

/**
 * 截断过长昵称：超过 NICKNAME_DISPLAY_MAX 字时只保留前 N-1 字并补省略号。
 * 按 code point 切分（Array.from），避免把非 BMP 字符（emoji）截成半个而出现替代符 U+FFFD。
 * 已知边界：不识别 ZWJ 组合序列与区域指示符（👨‍👩‍👧 / 🇨🇳）—— 它们按多个 code point 计数，
 * 截断不会产生乱码，只是可能把一组 emoji 拆开显示。
 */
function truncateNickname(value) {
  const chars = Array.from(value);
  if (chars.length <= NICKNAME_DISPLAY_MAX) return value;
  return `${chars.slice(0, NICKNAME_DISPLAY_MAX - 1).join("")}…`;
}

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
  NICKNAME_DISPLAY_MAX,
  normalizeNickname,
  resolveNickname,
  truncateNickname,
  storeNickname,
};
