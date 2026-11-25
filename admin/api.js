export class AdminApiError extends Error {
  constructor(status, code, message, details = null, requestId = null) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

function buildQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

export function createAdminApiClient(options = {}) {
  const baseUrl = (options.baseUrl ?? "/v1").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const getToken = options.getToken ?? (() => null);
  const setToken = options.setToken ?? (() => {});
  const onUnauthorized = options.onUnauthorized ?? (() => {});

  async function request(method, path, { query, body, auth = true, notifyOnAuthFailure = true } = {}) {
    const headers = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (auth) {
      const token = getToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    const url = `${baseUrl}${path}${buildQueryString(query)}`;
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 204) {
      return null;
    }

    let payload = null;
    const text = await response.text();
    if (text.trim().length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const code = payload?.code || `HTTP_${response.status}`;
      const message = payload?.message || `HTTP ${response.status}`;
      const err = new AdminApiError(
        response.status,
        code,
        message,
        payload?.details ?? null,
        payload?.request_id ?? null,
      );
      if (notifyOnAuthFailure && (response.status === 401 || response.status === 403)) {
        setToken(null);
        onUnauthorized(err);
      }
      throw err;
    }

    return payload?.data ?? payload;
  }

  return {
    async loginWithToken(loginToken) {
      const data = await request("POST", "/admin/auth/login", {
        auth: false,
        notifyOnAuthFailure: false,
        body: { login_token: loginToken },
      });
      if (data?.access_token) setToken(data.access_token);
      return data;
    },

    async loginWithPasscode(openid, passcode) {
      const data = await request("POST", "/admin/auth/login", {
        auth: false,
        notifyOnAuthFailure: false,
        body: { openid, passcode },
      });
      if (data?.access_token) setToken(data.access_token);
      return data;
    },

    getMe() {
      return request("GET", "/admin/auth/me");
    },

    async logout() {
      try {
        await request("POST", "/admin/auth/logout", {
          body: {},
          notifyOnAuthFailure: false,
        });
      } finally {
        setToken(null);
      }
    },

    listAnomalies(params = {}) {
      return request("GET", "/admin/anomalies", { query: params });
    },

    resolveAnomaly(anomalyId, { reason }) {
      return request("POST", `/admin/anomalies/${encodeURIComponent(anomalyId)}/resolve`, {
        body: { reason },
      });
    },

    getMatch(matchId) {
      return request("GET", `/admin/matches/${encodeURIComponent(matchId)}`);
    },

    correctResult(matchId, { expected_result_version, regular_home_score, regular_away_score, reason }) {
      return request("POST", `/admin/matches/${encodeURIComponent(matchId)}/result-corrections`, {
        body: { expected_result_version, regular_home_score, regular_away_score, reason },
      });
    },

    retrySettlement(matchId) {
      return request("POST", `/admin/matches/${encodeURIComponent(matchId)}/retry-settlement`, {
        body: {},
      });
    },

    rebuildUserStats(userId) {
      return request("POST", `/admin/rebuild/users/${encodeURIComponent(userId)}`, {
        body: {},
      });
    },

    rebuildRankings({ board, period_key, reason }) {
      const body = board === "week"
        ? { board, period_key, reason }
        : { board, reason };
      return request("POST", "/admin/rebuild/rankings", { body });
    },

    listAuditLogs(params = {}) {
      return request("GET", "/admin/audit-logs", { query: params });
    },

    listTeams(params = {}) {
      return request("GET", "/admin/teams", { query: params });
    },

    updateTeam(teamId, { name_zh, logo_url, reason }) {
      const body = { reason };
      if (name_zh !== undefined) body.name_zh = name_zh;
      if (logo_url !== undefined) body.logo_url = logo_url;
      return request("PATCH", `/admin/teams/${encodeURIComponent(teamId)}`, { body });
    },

    upsertTeamMapping(teamId, { provider, provider_team_id, overwrite, reason }) {
      return request("POST", `/admin/teams/${encodeURIComponent(teamId)}/mappings`, {
        body: {
          provider,
          provider_team_id,
          ...(overwrite === true ? { overwrite: true } : {}),
          reason,
        },
      });
    },
  };
}
