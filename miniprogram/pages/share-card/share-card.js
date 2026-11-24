const config = require("../../config.js");
const { getMyShareCard, getShareCardForUser } = require("../../services/share-card.js");
const { listLeagueSeasons } = require("../../services/league-seasons.js");
const { formatRound } = require("../../utils/match-presentation.js");
const { isAuthSessionActive, readAuthSession } = require("../../utils/auth-storage.js");

const LEAGUE_NAMES = {
  premier_league: "英超",
  la_liga: "西甲",
  serie_a: "意甲",
  bundesliga: "德甲",
  ligue_1: "法甲",
  chinese_super_league: "中超",
};

const LEAGUE_PLACEHOLDER = "选择联赛";
const SEASON_PLACEHOLDER = "选择赛季";
const ROUND_PLACEHOLDER = "选择轮次";

function readQueryValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeRoundId(value) {
  const text = readQueryValue(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return String(Number(text)).padStart(2, "0");
  return text;
}

function sortedRounds(roundIds) {
  if (!Array.isArray(roundIds)) return [];
  return roundIds.slice().sort((left, right) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return String(left).localeCompare(String(right));
  });
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatGeneratedAt(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time + 8 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function presentCard(data) {
  const payload = data || {};
  return {
    displayName: payload.display_name,
    leagueName: LEAGUE_NAMES[payload.league_id] || payload.league_id,
    leagueId: payload.league_id,
    seasonId: payload.season_id,
    roundId: payload.round_id,
    seasonLabel: payload.season_label,
    roundText: formatRound(payload.round_id),
    settledCount: payload.round_predictions,
    wdlHits: payload.round_wdl_hits,
    exactHits: payload.round_exact_hits,
    roundScore: payload.round_score,
    careerPoints: payload.career_points,
    seasonLevel: payload.season_level,
    levelSeasonText: String(payload.level_season_id || "").replace(/_/g, "/"),
    pendingCount: payload.pending_predictions,
    generatedAtText: formatGeneratedAt(payload.generated_at),
    userId: payload.user_id,
  };
}

function compactRoundLabel(roundText, roundId) {
  const text = roundText || formatRound(roundId) || "";
  return String(text).replace(/\s/g, "");
}

function isShareableCard(card) {
  if (!card) return false;
  return Boolean(
    readQueryValue(card.userId)
    && readQueryValue(card.leagueId)
    && readQueryValue(card.seasonId)
    && readQueryValue(card.roundId)
  );
}

const SHARE_MENU_OPTIONS = { menus: ["shareAppMessage", "shareTimeline"] };
const MATCHES_TAB_PATH = "/pages/matches/matches";
const MY_PREDICTIONS_ROUTE = "pages/my-predictions/my-predictions";
const MY_PREDICTIONS_PATH = "/pages/my-predictions/my-predictions";

Page({
  data: {
    state: "picker",
    mode: "preview",
    sharerId: null,
    card: null,
    errorKind: "",
    errorMessage: "",
    leagues: [],
    seasonsByLeague: {},
    roundsBySeason: {},
    leagueOptions: [LEAGUE_PLACEHOLDER],
    seasonOptions: [SEASON_PLACEHOLDER],
    roundOptions: [ROUND_PLACEHOLDER],
    leagueIndex: 0,
    seasonIndex: 0,
    roundIndex: 0,
    selectedLeagueId: null,
    selectedSeasonId: null,
    selectedRoundId: null,
    catalogReady: false,
    catalogError: "",
  },

  requestSerial: 0,
  pendingLoginRetry: false,
  loginReturnContext: null,

  onLoad(query) {
    const options = query || {};
    const userId = readQueryValue(options.user_id);
    const leagueId = readQueryValue(options.league_id);
    const seasonId = readQueryValue(options.season_id);
    const roundId = normalizeRoundId(options.round_id);
    const mode = userId ? "receiver" : "preview";
    const hasAll = Boolean(leagueId && seasonId && roundId);
    this.setData({
      mode,
      sharerId: userId,
      selectedLeagueId: leagueId,
      selectedSeasonId: seasonId,
      selectedRoundId: roundId,
      state: hasAll ? "loading" : "picker",
      card: null,
      errorKind: "",
      errorMessage: "",
    });
    this.syncShareMenu();
    const catalogPromise = this.loadCatalog();
    if (hasAll) return this.loadCard();
    return catalogPromise;
  },

  onShow() {
    if (!this.pendingLoginRetry || !this.loginReturnContext) return;
    this.pendingLoginRetry = false;
    const isHttpTransport = (config.transport || "http") === "http";
    if (isHttpTransport && !isAuthSessionActive(readAuthSession(), new Date())) return;
    const context = this.loginReturnContext;
    this.setData({
      mode: context.mode,
      sharerId: context.sharerId,
      selectedLeagueId: context.leagueId,
      selectedSeasonId: context.seasonId,
      selectedRoundId: context.roundId,
    });
    return this.loadCard();
  },

  loadCatalog() {
    return listLeagueSeasons().then((result) => {
      if (!result || result.statusCode !== 200) {
        this.setData({ catalogError: "筛选选项加载失败", catalogReady: false });
        return;
      }
      const items = result.data && Array.isArray(result.data.items) ? result.data.items : [];
      const leagues = [];
      const seasonsByLeague = {};
      const roundsBySeason = {};
      const seen = new Set();
      for (const item of items) {
        const leagueId = item.league_id;
        if (!seen.has(leagueId)) {
          seen.add(leagueId);
          leagues.push({
            id: leagueId,
            name: LEAGUE_NAMES[leagueId] || leagueId,
          });
        }
        if (!seasonsByLeague[leagueId]) seasonsByLeague[leagueId] = [];
        seasonsByLeague[leagueId].push({
          id: item.season_id,
          label: item.season_label,
        });
        roundsBySeason[leagueId + "|" + item.season_id] = sortedRounds(item.round_ids);
      }
      const picker = this.buildPickerState(leagues, seasonsByLeague, roundsBySeason);
      this.setData({
        leagues,
        seasonsByLeague,
        roundsBySeason,
        catalogReady: true,
        catalogError: "",
        ...picker,
      });
    }).catch(() => {
      this.setData({ catalogError: "筛选选项加载失败", catalogReady: false });
    });
  },

  buildPickerState(leagues, seasonsByLeague, roundsBySeason) {
    const leagueId = this.data.selectedLeagueId;
    const seasonId = this.data.selectedSeasonId;
    const roundId = this.data.selectedRoundId;
    let leagueIndex = 0;
    let seasonIndex = 0;
    let roundIndex = 0;
    let seasonOptions = [SEASON_PLACEHOLDER];
    let roundOptions = [ROUND_PLACEHOLDER];
    if (leagueId) {
      const leagueOffset = leagues.findIndex((league) => league.id === leagueId);
      if (leagueOffset >= 0) {
        leagueIndex = leagueOffset + 1;
        const seasons = seasonsByLeague[leagueId] || [];
        seasonOptions = [SEASON_PLACEHOLDER, ...seasons.map((season) => season.label)];
        if (seasonId) {
          const seasonOffset = seasons.findIndex((season) => season.id === seasonId);
          if (seasonOffset >= 0) {
            seasonIndex = seasonOffset + 1;
            const rounds = roundsBySeason[leagueId + "|" + seasonId] || [];
            roundOptions = [ROUND_PLACEHOLDER, ...rounds.map((round) => formatRound(round))];
            if (roundId) {
              const normalized = normalizeRoundId(roundId);
              const roundOffset = rounds.findIndex((round) => {
                return normalizeRoundId(round) === normalized || String(round) === String(roundId);
              });
              if (roundOffset >= 0) roundIndex = roundOffset + 1;
            }
          }
        }
      }
    }
    return {
      leagueIndex,
      seasonIndex,
      roundIndex,
      leagueOptions: [LEAGUE_PLACEHOLDER, ...leagues.map((league) => league.name)],
      seasonOptions,
      roundOptions,
    };
  },

  requestCard() {
    const params = {
      leagueId: this.data.selectedLeagueId,
      seasonId: this.data.selectedSeasonId,
      roundId: this.data.selectedRoundId,
    };
    if (this.data.mode === "receiver") {
      return getShareCardForUser(this.data.sharerId, params);
    }
    return getMyShareCard(params);
  },

  loadCard() {
    const serial = ++this.requestSerial;
    this.setData({
      state: "loading",
      card: null,
      errorKind: "",
      errorMessage: "",
    });
    this.syncShareMenu();
    return this.requestCard().then((result) => this.applyCardResult(result, serial)).catch(() => {
      if (serial !== this.requestSerial) return;
      this.setData({
        state: "error",
        errorKind: "network",
        errorMessage: "网络异常，请重试",
        card: null,
      });
      this.syncShareMenu();
    });
  },

  applyCardResult(result, serial) {
    if (result && result.statusCode === 200) {
      const card = presentCard(result.data);
      if (serial !== this.requestSerial) return;
      this.setData({
        state: "card",
        card,
        errorKind: "",
        errorMessage: "",
      });
      this.syncShareMenu();
      return;
    }
    if (serial !== this.requestSerial) return;
    const mapped = this.mapCardError(result);
    this.setData({
      state: "error",
      card: null,
      errorKind: mapped.errorKind,
      errorMessage: mapped.errorMessage,
    });
    this.syncShareMenu();
  },

  syncShareMenu() {
    if (this.data.state === "card" && isShareableCard(this.data.card)) {
      wx.showShareMenu(SHARE_MENU_OPTIONS);
      return;
    }
    wx.hideShareMenu(SHARE_MENU_OPTIONS);
  },

  mapCardError(result) {
    const statusCode = result && result.statusCode;
    const code = result && result.code;
    if (
      statusCode === undefined ||
      statusCode === null ||
      statusCode === "" ||
      statusCode === 0 ||
      code === "NETWORK_ERROR"
    ) {
      return { errorKind: "network", errorMessage: "网络异常，请重试" };
    }
    const message = result && result.message ? String(result.message) : "";
    if (statusCode === 404 && (code === "ROUND" || code === "ROUND_NOT_FOUND" || /轮次/.test(message))) {
      return { errorKind: "roundNotFound", errorMessage: "这个轮次还没有接入，换个轮次看看" };
    }
    if (statusCode === 404 && code === "USER_NOT_FOUND") {
      return { errorKind: "userUnavailable", errorMessage: "这位用户不存在或已注销" };
    }
    if (statusCode === 409 && code === "USER_DELETED") {
      return { errorKind: "userUnavailable", errorMessage: "这位用户已注销" };
    }
    if (statusCode === 422) {
      return { errorKind: "badParams", errorMessage: "筛选条件不正确，请重新选择" };
    }
    if (statusCode === 401) {
      return {
        errorKind: "unauthorized",
        errorMessage: this.data.mode === "preview"
          ? "登录后才能查看自己的成绩单"
          : "登录后才能查看成绩单",
      };
    }
    return { errorKind: "failed", errorMessage: message || "成绩单读取失败" };
  },

  onLeagueChange(event) {
    this.requestSerial += 1;
    const index = Number(event.detail.value);
    if (index === 0) {
      this.setData({
        leagueIndex: 0,
        selectedLeagueId: null,
        seasonIndex: 0,
        selectedSeasonId: null,
        roundIndex: 0,
        selectedRoundId: null,
        seasonOptions: [SEASON_PLACEHOLDER],
        roundOptions: [ROUND_PLACEHOLDER],
        state: "picker",
        card: null,
        errorKind: "",
        errorMessage: "",
      });
      this.syncShareMenu();
      return;
    }
    const league = this.data.leagues[index - 1];
    const seasons = (league && this.data.seasonsByLeague[league.id]) || [];
    this.setData({
      leagueIndex: index,
      selectedLeagueId: league ? league.id : null,
      seasonIndex: 0,
      selectedSeasonId: null,
      roundIndex: 0,
      selectedRoundId: null,
      seasonOptions: [SEASON_PLACEHOLDER, ...seasons.map((season) => season.label)],
      roundOptions: [ROUND_PLACEHOLDER],
      state: "picker",
      card: null,
      errorKind: "",
      errorMessage: "",
    });
    this.syncShareMenu();
  },

  onSeasonChange(event) {
    this.requestSerial += 1;
    const index = Number(event.detail.value);
    if (index === 0) {
      this.setData({
        seasonIndex: 0,
        selectedSeasonId: null,
        roundIndex: 0,
        selectedRoundId: null,
        roundOptions: [ROUND_PLACEHOLDER],
        state: "picker",
        card: null,
        errorKind: "",
        errorMessage: "",
      });
      this.syncShareMenu();
      return;
    }
    const seasons = this.data.seasonsByLeague[this.data.selectedLeagueId] || [];
    const season = seasons[index - 1];
    const rounds = (season && this.data.roundsBySeason[this.data.selectedLeagueId + "|" + season.id]) || [];
    this.setData({
      seasonIndex: index,
      selectedSeasonId: season ? season.id : null,
      roundIndex: 0,
      selectedRoundId: null,
      roundOptions: [ROUND_PLACEHOLDER, ...rounds.map((round) => formatRound(round))],
      state: "picker",
      card: null,
      errorKind: "",
      errorMessage: "",
    });
    this.syncShareMenu();
  },

  onRoundChange(event) {
    const index = Number(event.detail.value);
    if (index === 0) {
      this.requestSerial += 1;
      this.setData({
        roundIndex: 0,
        selectedRoundId: null,
        state: "picker",
        card: null,
        errorKind: "",
        errorMessage: "",
      });
      this.syncShareMenu();
      return;
    }
    const rounds = this.data.roundsBySeason[this.data.selectedLeagueId + "|" + this.data.selectedSeasonId] || [];
    const roundId = normalizeRoundId(rounds[index - 1]);
    this.setData({
      roundIndex: index,
      selectedRoundId: roundId,
    });
    if (roundId) return this.loadCard();
  },

  onShareAppMessage() {
    const card = this.data.card;
    // 右上角原生转发不看页面内按钮显隐，卡片未就绪时仍会进这个回调。
    // 不能带上空的 user_id 等参数，否则接收者会按本人预览打开。
    // tabBar 首页只能分享 /pages/matches/matches，不能写别的首页路径。
    if (this.data.state !== "card" || !isShareableCard(card)) {
      return {
        title: "预测成绩单",
        path: MATCHES_TAB_PATH,
      };
    }
    const displayName = card.displayName || "预测成绩单";
    const roundLabel = compactRoundLabel(card.roundText, card.roundId) || "第?轮";
    const pendingCount = Number(card.pendingCount) || 0;
    const settledCount = card.settledCount;
    const title = pendingCount > 0
      ? `${displayName} ${roundLabel}成绩（已结算 ${settledCount} 场）`
      : `${displayName} ${roundLabel}成绩`;
    return {
      title,
      path: `/pages/share-card/share-card?user_id=${card.userId}&league_id=${card.leagueId}&season_id=${card.seasonId}&round_id=${card.roundId}`,
    };
  },

  onBackToPredictions() {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const previous = pages.length >= 2 ? pages[pages.length - 2] : null;
    if (previous && previous.route === MY_PREDICTIONS_ROUTE) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.redirectTo({
      url: MY_PREDICTIONS_PATH,
      fail() {
        wx.navigateBack();
      },
    });
  },

  onLoginTap() {
    this.loginReturnContext = {
      mode: this.data.mode,
      sharerId: this.data.sharerId,
      leagueId: this.data.selectedLeagueId,
      seasonId: this.data.selectedSeasonId,
      roundId: this.data.selectedRoundId,
    };
    this.pendingLoginRetry = this.data.errorKind === "unauthorized";
    wx.navigateTo({ url: "/pages/session/session?return_to=share-card" });
  },

  onRetry() {
    return this.loadCard();
  },

  onReselect() {
    this.requestSerial += 1;
    const resetReceiver = this.data.mode === "receiver" || this.data.errorKind === "userUnavailable";
    this.setData({
      state: "picker",
      card: null,
      selectedRoundId: null,
      roundIndex: 0,
      errorKind: "",
      errorMessage: "",
      ...(resetReceiver ? { mode: "preview", sharerId: null } : {}),
    });
    this.syncShareMenu();
  },

  onCatalogRetry() {
    this.setData({ catalogError: "" });
    return this.loadCatalog();
  },
});
