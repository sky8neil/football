import { createAdminApiClient } from "./api.js";
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  LEAGUES,
  PROVIDERS,
  createCursorPager,
  formatApiError,
  formatIsoDate,
  formatJsonCompact,
  isValidUuid,
  readStoredToken,
  validateLogoUrl,
  validateReason,
  writeStoredToken,
} from "./state.js";

const anomalyPager = createCursorPager();
const auditPager = createCursorPager();
let currentTab = "anomalies";
let cachedTeams = [];

const el = (id) => document.getElementById(id);

function showToast(message, kind = "ok") {
  const box = el("global-toast");
  box.textContent = message;
  box.className = `toast ${kind}`;
}

function hideToast() {
  el("global-toast").className = "toast hidden";
}

function setVisible(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function showLoginView(message) {
  setVisible(el("login-view"), true);
  setVisible(el("dashboard-view"), false);
  setVisible(el("session-bar"), false);
  if (message) {
    el("login-error").textContent = message;
    setVisible(el("login-error"), true);
  } else {
    setVisible(el("login-error"), false);
  }
}

function showDashboardView(admin) {
  setVisible(el("login-view"), false);
  setVisible(el("dashboard-view"), true);
  setVisible(el("session-bar"), true);
  setVisible(el("login-error"), false);
  el("session-admin-info").textContent = `管理员 ${admin.admin_id} (${admin.role}/${admin.status})`;
}

const api = createAdminApiClient({
  getToken: () => readStoredToken(window.sessionStorage),
  setToken: (token) => writeStoredToken(window.sessionStorage, token),
  onUnauthorized: (err) => {
    showLoginView(formatApiError(err));
  },
});

function populateStaticSelects() {
  const leagueSelect = el("teams-league-filter");
  for (const league of LEAGUES) {
    const opt = document.createElement("option");
    opt.value = league.id;
    opt.textContent = league.label;
    leagueSelect.appendChild(opt);
  }

  const providerSelect = el("team-map-provider");
  for (const provider of PROVIDERS) {
    const opt = document.createElement("option");
    opt.value = provider;
    opt.textContent = provider;
    providerSelect.appendChild(opt);
  }

  const actionSelect = el("audit-action-filter");
  for (const action of AUDIT_ACTIONS) {
    const opt = document.createElement("option");
    opt.value = action;
    opt.textContent = action;
    actionSelect.appendChild(opt);
  }

  const targetTypeSelect = el("audit-target-type-filter");
  for (const targetType of AUDIT_TARGET_TYPES) {
    const opt = document.createElement("option");
    opt.value = targetType;
    opt.textContent = targetType;
    targetTypeSelect.appendChild(opt);
  }
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    setVisible(panel, panel.id === `tab-${tab}`);
  });
  if (tab === "anomalies") void loadAnomalies();
  if (tab === "teams") void loadTeams();
  if (tab === "audit") void loadAuditLogs();
}

function makeCell(text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function makeBadge(text, className) {
  const span = document.createElement("span");
  span.className = `badge ${className}`;
  span.textContent = text;
  return span;
}

async function loadAnomalies(transition = null) {
  const tbody = el("anomalies-tbody");
  tbody.textContent = "";
  try {
    const cursor = transition ? transition.currentCursor : anomalyPager.currentCursor;
    const data = await api.listAnomalies({
      status: el("anomaly-status-filter").value,
      blocking: el("anomaly-blocking-filter").value,
      limit: el("anomaly-limit-filter").value,
      cursor,
    });
    anomalyPager.commit(transition, data.page);
    el("anomaly-prev-btn").disabled = !anomalyPager.canGoBack();
    el("anomaly-next-btn").disabled = !anomalyPager.hasMore;

    if (data.items.length === 0) {
      const tr = document.createElement("tr");
      const td = makeCell("暂无符合条件的异常记录");
      td.colSpan = 7;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const item of data.items) {
      const tr = document.createElement("tr");

      const statusTd = document.createElement("td");
      statusTd.appendChild(
        makeBadge(item.status, item.status === "open" ? "badge-open" : "badge-resolved"),
      );
      if (item.blocking) {
        statusTd.appendChild(document.createTextNode(" "));
        statusTd.appendChild(makeBadge("blocking", "badge-blocking"));
      }
      tr.appendChild(statusTd);

      tr.appendChild(makeCell(item.type, "mono"));

      const idsTd = document.createElement("td");
      idsTd.className = "mono";
      idsTd.textContent = `match: ${item.match_id}\nanomaly: ${item.anomaly_id}`;
      idsTd.style.whiteSpace = "pre-line";
      tr.appendChild(idsTd);

      tr.appendChild(makeCell(formatIsoDate(item.last_seen_at)));
      tr.appendChild(makeCell(String(item.occurrence_count)));
      tr.appendChild(makeCell(item.resolution ?? "—", "mono"));

      const actionTd = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "actions-row";
      if (item.status === "open") {
        const resolveBtn = document.createElement("button");
        resolveBtn.type = "button";
        resolveBtn.className = "btn btn-danger btn-sm";
        resolveBtn.textContent = "手动解除";
        resolveBtn.addEventListener("click", () => {
          el("resolve-anomaly-id").value = item.anomaly_id;
          el("resolve-anomaly-meta").value = `${item.type} / ${item.match_id}`;
          el("resolve-anomaly-reason").value = "";
          setVisible(el("resolve-anomaly-card"), true);
        });
        actions.appendChild(resolveBtn);
      }
      const fixBtn = document.createElement("button");
      fixBtn.type = "button";
      fixBtn.className = "btn btn-secondary btn-sm";
      fixBtn.textContent = "去修正赛果";
      fixBtn.addEventListener("click", () => {
        el("rc-match-id").value = item.match_id;
        el("retry-match-id").value = item.match_id;
        switchTab("settlement");
      });
      actions.appendChild(fixBtn);
      actionTd.appendChild(actions);
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    }
  } catch (err) {
    showToast(formatApiError(err), "error");
  }
}

async function loadTeams() {
  const tbody = el("teams-tbody");
  tbody.textContent = "";
  try {
    const data = await api.listTeams({
      league_id: el("teams-league-filter").value,
      q: el("teams-search-input").value.trim(),
      missing_only: el("teams-missing-only").checked ? "true" : "",
    });
    cachedTeams = data.items || [];

    if (cachedTeams.length === 0) {
      const tr = document.createElement("tr");
      const td = makeCell("暂无符合条件的球队记录");
      td.colSpan = 6;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const item of cachedTeams) {
      const tr = document.createElement("tr");
      tr.appendChild(makeCell(item.league_id, "mono"));

      const nameTd = document.createElement("td");
      const nameDiv = document.createElement("div");
      nameDiv.textContent = item.name;
      const idDiv = document.createElement("div");
      idDiv.className = "mono";
      idDiv.textContent = item.team_id;
      nameTd.append(nameDiv, idDiv);
      tr.appendChild(nameTd);

      tr.appendChild(makeCell(item.name_zh ?? "（缺失）"));
      tr.appendChild(makeCell(item.logo_url ?? "（缺失）", "mono"));

      const mapText = item.mappings.length === 0
        ? "（无映射）"
        : item.mappings.map((m) => `${m.provider}: ${m.provider_team_id}`).join("\n");
      const mapTd = makeCell(mapText, "mono");
      mapTd.style.whiteSpace = "pre-line";
      tr.appendChild(mapTd);

      const opTd = document.createElement("td");
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn-secondary btn-sm";
      editBtn.textContent = "维护资料/映射";
      editBtn.addEventListener("click", () => {
        el("team-editor-title").textContent = `维护球队：${item.name} (${item.team_id})`;
        el("team-edit-id").value = item.team_id;
        el("team-edit-name-zh").value = item.name_zh ?? "";
        el("team-edit-logo-url").value = item.logo_url ?? "";
        el("team-edit-reason").value = "";
        el("team-map-external-id").value = "";
        el("team-map-overwrite").checked = false;
        el("team-map-reason").value = "";
        setVisible(el("team-editor-card"), true);
      });
      opTd.appendChild(editBtn);
      tr.appendChild(opTd);

      tbody.appendChild(tr);
    }
  } catch (err) {
    showToast(formatApiError(err), "error");
  }
}

async function loadAuditLogs(transition = null) {
  const tbody = el("audit-tbody");
  tbody.textContent = "";
  try {
    const cursor = transition ? transition.currentCursor : auditPager.currentCursor;
    const data = await api.listAuditLogs({
      action: el("audit-action-filter").value,
      target_type: el("audit-target-type-filter").value,
      target_id: el("audit-target-id-filter").value.trim(),
      limit: el("audit-limit-filter").value,
      cursor,
    });
    auditPager.commit(transition, data.page);
    el("audit-prev-btn").disabled = !auditPager.canGoBack();
    el("audit-next-btn").disabled = !auditPager.hasMore;

    if (data.items.length === 0) {
      const tr = document.createElement("tr");
      const td = makeCell("暂无审计日志");
      td.colSpan = 6;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const item of data.items) {
      const tr = document.createElement("tr");
      tr.appendChild(makeCell(formatIsoDate(item.created_at)));
      tr.appendChild(makeCell(item.action, "mono"));
      tr.appendChild(makeCell(`${item.target_type}:${item.target_id}`, "mono"));
      tr.appendChild(makeCell(item.admin_id, "mono"));
      tr.appendChild(makeCell(item.reason));
      const diffTd = makeCell(
        `old: ${formatJsonCompact(item.old_value)}\nnew: ${formatJsonCompact(item.new_value)}`,
        "mono",
      );
      diffTd.style.whiteSpace = "pre-line";
      tr.appendChild(diffTd);
      tbody.appendChild(tr);
    }
  } catch (err) {
    showToast(formatApiError(err), "error");
  }
}

function bindEvents() {
  document.querySelectorAll("[data-auth-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.authMode;
      document.querySelectorAll("[data-auth-mode]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      setVisible(el("token-login-form"), mode === "token");
      setVisible(el("passcode-login-form"), mode === "passcode");
    });
  });

  el("token-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    hideToast();
    try {
      const data = await api.loginWithToken(el("login-token-input").value.trim());
      el("login-token-input").value = "";
      showDashboardView(data.admin);
      switchTab("anomalies");
      showToast("登录成功");
    } catch (err) {
      showLoginView(formatApiError(err));
    }
  });

  el("passcode-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    hideToast();
    try {
      const data = await api.loginWithPasscode(
        el("login-openid-input").value.trim(),
        el("login-passcode-input").value,
      );
      el("login-passcode-input").value = "";
      showDashboardView(data.admin);
      switchTab("anomalies");
      showToast("登录成功");
    } catch (err) {
      showLoginView(formatApiError(err));
    }
  });

  el("logout-btn").addEventListener("click", async () => {
    await api.logout().catch(() => {});
    showLoginView();
    showToast("已退出管理员会话");
  });

  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      hideToast();
      switchTab(btn.dataset.tab);
    });
  });

  // Anomalies
  for (const filterId of ["anomaly-status-filter", "anomaly-blocking-filter", "anomaly-limit-filter"]) {
    el(filterId).addEventListener("change", () => {
      anomalyPager.reset();
      el("anomaly-prev-btn").disabled = true;
      el("anomaly-next-btn").disabled = true;
      void loadAnomalies();
    });
  }
  el("anomaly-refresh-btn").addEventListener("click", () => {
    anomalyPager.reset();
    void loadAnomalies();
  });
  el("anomaly-prev-btn").addEventListener("click", () => {
    const prev = anomalyPager.planBack();
    if (prev) void loadAnomalies(prev);
  });
  el("anomaly-next-btn").addEventListener("click", () => {
    const next = anomalyPager.planAdvance();
    if (next) void loadAnomalies(next);
  });
  el("resolve-anomaly-cancel").addEventListener("click", () => {
    setVisible(el("resolve-anomaly-card"), false);
  });
  el("resolve-anomaly-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const anomalyId = el("resolve-anomaly-id").value.trim();
    const reason = el("resolve-anomaly-reason").value;
    const reasonErr = validateReason(reason);
    if (reasonErr) return showToast(reasonErr, "error");
    try {
      const res = await api.resolveAnomaly(anomalyId, { reason: reason.trim() });
      setVisible(el("resolve-anomaly-card"), false);
      showToast(`已解除异常 ${res.anomaly_id}（审计 ${res.audit_id}）`);
      await loadAnomalies();
    } catch (err) {
      showToast(formatApiError(err), "error");
    }
  });

  // Settlement
  el("rc-load-match-btn").addEventListener("click", async () => {
    const matchId = el("rc-match-id").value.trim();
    if (!isValidUuid(matchId)) return showToast("match_id 必须为 UUID v4", "error");
    try {
      const match = await api.getMatch(matchId);
      el("rc-expected-version").value = String(match.result_version ?? 0);
      if (match.regular_home_score !== null && match.regular_home_score !== undefined) {
        el("rc-home-score").value = String(match.regular_home_score);
      }
      if (match.regular_away_score !== null && match.regular_away_score !== undefined) {
        el("rc-away-score").value = String(match.regular_away_score);
      }
      const preview = el("rc-match-preview");
      const openAnomalyCount = Array.isArray(match.open_anomalies) ? match.open_anomalies.length : 0;
      preview.textContent =
        `${match.home_team?.name_zh || match.home_team?.name || "?"} vs ${match.away_team?.name_zh || match.away_team?.name || "?"} | 状态: ${match.match_status} / 结算: ${match.settlement_status} | 当前版本: v${match.result_version} (已结算 v${match.settled_result_version ?? 0}, 来源: ${match.result_source ?? "none"}, 未解决异常: ${openAnomalyCount})`;
      setVisible(preview, true);
    } catch (err) {
      showToast(formatApiError(err), "error");
    }
  });

  el("result-correction-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const matchId = el("rc-match-id").value.trim();
    if (!isValidUuid(matchId)) return showToast("match_id 必须为 UUID v4", "error");
    const reason = el("rc-reason").value;
    const reasonErr = validateReason(reason);
    if (reasonErr) return showToast(reasonErr, "error");
    try {
      const res = await api.correctResult(matchId, {
        expected_result_version: Number(el("rc-expected-version").value),
        regular_home_score: Number(el("rc-home-score").value),
        regular_away_score: Number(el("rc-away-score").value),
        reason: reason.trim(),
      });
      const out = el("rc-result-box");
      out.textContent = JSON.stringify(res, null, 2);
      setVisible(out, true);
      el("rc-expected-version").value = String(res.result_version);
      showToast(`赛果修正成功：v${res.result_version}（审计 ${res.audit_id}）`);
    } catch (err) {
      showToast(formatApiError(err), "error");
    }
  });

  el("retry-settlement-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const matchId = el("retry-match-id").value.trim();
    if (!isValidUuid(matchId)) return showToast("match_id 必须为 UUID v4", "error");
    try {
      const res = await api.retrySettlement(matchId);
      const out = el("retry-result-box");
      out.textContent = JSON.stringify(res, null, 2);
      setVisible(out, true);
      showToast(`结算重试完成：${res.outcome}（审计 ${res.audit_id}）`);
    } catch (err) {
      showToast(formatApiError(err), "error");
    }
  });

  // Teams
  el("teams-refresh-btn").addEventListener("click", () => void loadTeams());
  el("team-editor-close").addEventListener("click", () => {
    setVisible(el("team-editor-card"), false);
  });
  el("team-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const teamId = el("team-edit-id").value;
    const nameZhRaw = el("team-edit-name-zh").value.trim();
    const logoRaw = el("team-edit-logo-url").value.trim();
    const logoErr = validateLogoUrl(logoRaw);
    if (logoErr) return showToast(logoErr, "error");
    const reasonErr = validateReason(el("team-edit-reason").value);
    if (reasonErr) return showToast(reasonErr, "error");
    try {
      const res = await api.updateTeam(teamId, {
        name_zh: nameZhRaw === "" ? null : nameZhRaw,
        logo_url: logoRaw === "" ? null : logoRaw,
        reason: el("team-edit-reason").value.trim(),
      });
      showToast(`球队资料已更新（审计 ${res.audit_id}）`);
      await loadTeams();
    } catch (err) {
      showToast(formatApiError(err), "error");
    }
  });

  el("team-mapping-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const teamId = el("team-edit-id").value;
    const provider = el("team-map-provider").value;
    const externalId = el("team-map-external-id").value.trim();
    const reasonErr = validateReason(el("team-map-reason").value);
    if (reasonErr) return showToast(reasonErr, "error");
    if (!externalId) return showToast("外部源队名/队 ID 不能为空", "error");
    try {
      const res = await api.upsertTeamMapping(teamId, {
        provider,
        provider_team_id: externalId,
        overwrite: el("team-map-overwrite").checked,
        reason: el("team-map-reason").value.trim(),
      });
      showToast(`映射操作完成：${res.status}（审计 ${res.audit_id}）`);
      await loadTeams();
    } catch (err) {
      showToast(formatApiError(err), "error");
    }
  });

  // Rebuilds
  el("rebuild-user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const userId = el("rebuild-user-id").value.trim();
    if (!isValidUuid(userId)) return showToast("user_id 必须为 UUID v4", "error");
    try {
      const res = await api.rebuildUserStats(userId);
      const out = el("rebuild-user-result");
      out.textContent = JSON.stringify(res, null, 2);
      setVisible(out, true);
      showToast(`用户统计重建完成（审计 ${res.audit_id}）`);
    } catch (err) {
      showToast(formatApiError(err), "error");
    }
  });

  el("rebuild-board").addEventListener("change", () => {
    const isWeek = el("rebuild-board").value === "week";
    setVisible(el("rebuild-period-row"), isWeek);
    el("rebuild-period-key").required = isWeek;
  });

  el("rebuild-rankings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const board = el("rebuild-board").value;
    const periodKey = el("rebuild-period-key").value.trim();
    const reason = el("rebuild-rankings-reason").value;
    const reasonErr = validateReason(reason);
    if (reasonErr) return showToast(reasonErr, "error");
    try {
      const res = await api.rebuildRankings({
        board,
        period_key: board === "week" ? periodKey : undefined,
        reason: reason.trim(),
      });
      const out = el("rebuild-rankings-result");
      out.textContent = JSON.stringify(res, null, 2);
      setVisible(out, true);
      showToast(`排行榜重建完成：${res.rebuilt_entry_count} 条（审计 ${res.audit_id}）`);
    } catch (err) {
      showToast(formatApiError(err), "error");
    }
  });

  // Audit logs
  for (const filterId of ["audit-action-filter", "audit-target-type-filter", "audit-limit-filter"]) {
    el(filterId).addEventListener("change", () => {
      auditPager.reset();
      el("audit-prev-btn").disabled = true;
      el("audit-next-btn").disabled = true;
      void loadAuditLogs();
    });
  }
  el("audit-target-id-filter").addEventListener("input", () => {
    auditPager.reset();
    el("audit-prev-btn").disabled = true;
    el("audit-next-btn").disabled = true;
  });
  el("audit-refresh-btn").addEventListener("click", () => {
    auditPager.reset();
    void loadAuditLogs();
  });
  el("audit-prev-btn").addEventListener("click", () => {
    const prev = auditPager.planBack();
    if (prev) void loadAuditLogs(prev);
  });
  el("audit-next-btn").addEventListener("click", () => {
    const next = auditPager.planAdvance();
    if (next) void loadAuditLogs(next);
  });
}

async function bootstrap() {
  populateStaticSelects();
  bindEvents();
  const storedToken = readStoredToken(window.sessionStorage);
  if (!storedToken) {
    showLoginView();
    return;
  }
  try {
    const admin = await api.getMe();
    showDashboardView(admin);
    switchTab(currentTab);
  } catch (err) {
    writeStoredToken(window.sessionStorage, null);
    showLoginView(formatApiError(err));
  }
}

void bootstrap();
