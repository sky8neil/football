const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_TOKEN_KEY = "football_admin_access_token";

export const LEAGUES = [
  { id: "premier_league", label: "英超 (premier_league)" },
  { id: "la_liga", label: "西甲 (la_liga)" },
  { id: "serie_a", label: "意甲 (serie_a)" },
  { id: "bundesliga", label: "德甲 (bundesliga)" },
  { id: "ligue_1", label: "法甲 (ligue_1)" },
  { id: "chinese_super_league", label: "中超 (chinese_super_league)" },
];

export const PROVIDERS = [
  "football_data",
  "5dollar",
  "openfoot",
  "bsd",
  "sportapi",
  "api_football",
];

export const AUDIT_ACTIONS = [
  "result_correction",
  "retry_settlement",
  "rebuild_user_stats",
  "rebuild_rankings",
  "grant_admin",
  "resolve_anomaly",
  "update_team",
  "upsert_team_mapping",
];

export const AUDIT_TARGET_TYPES = [
  "match",
  "settlement",
  "user",
  "ranking_period",
  "admin",
  "anomaly",
  "team",
  "team_provider_mapping",
];

export function isValidUuid(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value.trim());
}

export function validateReason(reason) {
  if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > 500) {
    return "原因说明不能为空且长度不能超过 500 字符";
  }
  return null;
}

export function validateLogoUrl(value) {
  if (value === null || value === undefined || value.trim() === "") return null;
  const trimmed = value.trim();
  if (/^https:\/\/[^/\s]+/.test(trimmed) || (trimmed.startsWith("/") && !trimmed.startsWith("//"))) {
    return null;
  }
  return "队徽 URL 必须以 https:// 或 / 开头";
}

export function formatIsoDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatJsonCompact(value) {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatApiError(error) {
  if (!error) return "未知错误";
  const code = error.code || "ERROR";
  const message = error.message || "请求失败";
  const hints = {
    UNAUTHORIZED: "登录态已失效或凭证无效，请重新登录",
    FORBIDDEN: "当前账号不是活跃管理员或已被禁用",
    RATE_LIMITED: "请求过于频繁，请稍后再试",
    ANOMALY_ALREADY_RESOLVED: "该异常已被解决，请刷新列表",
    TEAM_MAPPING_CONFLICT: "该外部源队名/队 ID 已映射到其他球队，如需覆盖请勾选允许覆盖",
    RESULT_VERSION_CONFLICT:
      error.details?.actual_result_version !== undefined
        ? `比赛 result_version 已更新为 v${error.details.actual_result_version}，请先重新读取最新赛果`
        : "比赛 result_version 已更新，请先重新读取最新赛果",
  };
  const hint = hints[code];
  return hint ? `[${code}] ${hint}（${message}）` : `[${code}] ${message}`;
}

export function createCursorPager() {
  return {
    currentCursor: null,
    history: [],
    nextCursor: null,
    hasMore: false,
    reset() {
      this.currentCursor = null;
      this.history = [];
      this.nextCursor = null;
      this.hasMore = false;
    },
    applyPage(page) {
      this.nextCursor = page?.next_cursor ?? null;
      this.hasMore = page?.has_more === true;
    },
    planAdvance() {
      if (!this.hasMore || !this.nextCursor) return null;
      return {
        currentCursor: this.nextCursor,
        history: [...this.history, this.currentCursor],
      };
    },
    planBack() {
      if (this.history.length === 0) return null;
      const nextHistory = [...this.history];
      const prevCursor = nextHistory.pop() ?? null;
      return {
        currentCursor: prevCursor,
        history: nextHistory,
      };
    },
    commit(transition, page) {
      if (transition) {
        this.currentCursor = transition.currentCursor;
        this.history = [...transition.history];
      }
      this.applyPage(page);
    },
    advance() {
      const next = this.planAdvance();
      if (!next) return false;
      this.history = next.history;
      this.currentCursor = next.currentCursor;
      return true;
    },
    back() {
      const prev = this.planBack();
      if (!prev) return false;
      this.history = prev.history;
      this.currentCursor = prev.currentCursor;
      return true;
    },
    canGoBack() {
      return this.history.length > 0;
    },
  };
}

export function readStoredToken(storage) {
  try {
    return storage?.getItem?.(SESSION_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function writeStoredToken(storage, token) {
  try {
    if (!storage) return;
    if (token) storage.setItem(SESSION_TOKEN_KEY, token);
    else storage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // ignore storage quota errors
  }
}
