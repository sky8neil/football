const config = require("../../config.js");
const { getMyShareCard, getShareCardForUser } = require("../../services/share-card.js");
const { listLeagueSeasons } = require("../../services/league-seasons.js");
const {
  isPlaceholderLogo,
  resolveFavoriteTeamSync,
  resolveFavoriteTeamRemote,
} = require("../../services/teams.js");
const { formatRound, formatKickoff } = require("../../utils/match-presentation.js");
const { presentTeam } = require("../../utils/team-presentation.js");
const { findTeam } = require("../../utils/team-registry.js");
const { PLACEHOLDER } = require("../../utils/logo-registry.js");
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
const DELETED_DISPLAY_NAME = "已注销用户";
const FULL_SUMMARY_SETTLED_THRESHOLD = 3;

function readQueryValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function resolveFavoriteTeam(favoriteTeamId, isDeleted) {
  const { needsRemoteLookup: _needsRemoteLookup, ...team } = resolveFavoriteTeamSync(
    isDeleted ? null : favoriteTeamId,
    { findTeam, presentTeam, placeholder: PLACEHOLDER },
  );
  return team;
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

function presentMatchItem(item, leagueId) {
  const row = item || {};
  const homePresented = presentTeam(row.home_team, leagueId);
  const awayPresented = presentTeam(row.away_team, leagueId);
  const matchId = readQueryValue(row.match_id) || "";
  const predHome = Number(row.pred_home_score);
  const predAway = Number(row.pred_away_score);
  const validPred =
    Number.isInteger(predHome) &&
    predHome >= 0 &&
    predHome <= 20 &&
    Number.isInteger(predAway) &&
    predAway >= 0 &&
    predAway <= 20;
  const canFollow = Boolean(
    matchId &&
    validPred &&
    row.match_status === "scheduled" &&
    row.is_prediction_closed !== true,
  );
  const cancelled = row.match_status === "cancelled" || row.settlement_status === "voided";
  const hasActualScore =
    row.regular_home_score !== null &&
    row.regular_home_score !== undefined &&
    row.regular_away_score !== null &&
    row.regular_away_score !== undefined;
  const actualText = cancelled
    ? "—"
    : hasActualScore
      ? `${row.regular_home_score} : ${row.regular_away_score}`
      : "";
  const settled =
    !cancelled &&
    row.settlement_status === "settled" &&
    row.match_score !== null &&
    row.match_score !== undefined;

  let statusText = "待开赛";
  let statusClass = "pending";
  let pointsText = "";

  if (canFollow) {
    statusText = "未开赛 · 可跟单";
    statusClass = "open";
  } else if (row.match_status === "scheduled") {
    statusText = "已截止 · 未开赛";
    statusClass = "closed";
    pointsText = "待结算";
  } else if (row.match_status === "live") {
    statusText = "进行中 · 未完赛";
    statusClass = "live";
    pointsText = "未完赛";
  } else if (row.match_status === "postponed") {
    statusText = "比赛延期 · 未完赛";
    statusClass = "postponed";
    pointsText = "未完赛";
  } else if (row.match_status === "abandoned") {
    statusText = "比赛腰斩 · 不计分";
    statusClass = "voided";
    pointsText = "不计分";
  } else if (cancelled) {
    statusText = "比赛取消 · 不计分";
    statusClass = "voided";
    pointsText = "不计分";
  } else if (settled) {
    if (row.exact_hit === true) {
      statusText = "已结算 · 精确命中";
      statusClass = "exact";
    } else if (row.wdl_hit === true) {
      statusText = "已结算 · 胜平负命中";
      statusClass = "hit";
    } else {
      statusText = "已结算 · 未命中";
      statusClass = "miss";
    }
    pointsText = `+${row.match_score}`;
  } else {
    statusText = "已完场 · 待结算";
    statusClass = "pending";
    pointsText = "待结算";
  }

  return {
    matchId,
    homeNameZh: homePresented.nameZh,
    awayNameZh: awayPresented.nameZh,
    homeLogo: homePresented.logo,
    awayLogo: awayPresented.logo,
    kickoffText: formatKickoff(row.kickoff_at),
    predictionText: validPred ? `${predHome} : ${predAway}` : "—",
    predHomeScore: validPred ? predHome : null,
    predAwayScore: validPred ? predAway : null,
    actualText,
    statusText,
    statusClass,
    pointsText,
    canFollow,
    followText: "去预测 / 跟一单",
    detailText: "查看详情",
  };
}

function presentCard(data) {
  const payload = data || {};
  const settledCount = Number(payload.round_predictions) || 0;
  const showFullSummary = settledCount > FULL_SUMMARY_SETTLED_THRESHOLD;
  const displayName = payload.display_name || "预言家";
  const isDeleted = displayName === DELETED_DISPLAY_NAME;
  const favoriteTeam = resolveFavoriteTeam(payload.favorite_team_id || null, isDeleted);
  const rawMatches = Array.isArray(payload.matches) ? payload.matches : [];
  return {
    displayName,
    isDeleted,
    ...favoriteTeam,
    leagueName: LEAGUE_NAMES[payload.league_id] || payload.league_id,
    leagueId: payload.league_id,
    seasonId: payload.season_id,
    roundId: payload.round_id,
    seasonLabel: payload.season_label,
    roundText: formatRound(payload.round_id),
    settledCount,
    showFullSummary,
    cardTitle: showFullSummary ? "本轮战绩" : "本轮晒预测",
    wdlHits: payload.round_wdl_hits,
    exactHits: payload.round_exact_hits,
    roundScore: payload.round_score,
    careerPoints: payload.career_points,
    seasonLevel: payload.season_level,
    levelSeasonText: String(payload.level_season_id || "").replace(/_/g, "/"),
    generatedAtText: formatGeneratedAt(payload.generated_at),
    userId: payload.user_id,
    shareToken: readQueryValue(payload.share_token),
    matches: rawMatches.map((item) => presentMatchItem(item, payload.league_id)),
  };
}

function compactRoundLabel(roundText, roundId) {
  const text = roundText || formatRound(roundId) || "";
  return String(text).replace(/\s/g, "");
}

function isShareableCard(card) {
  if (!card) return false;
  return Boolean(
    readQueryValue(card.userId) &&
    readQueryValue(card.leagueId) &&
    readQueryValue(card.seasonId) &&
    readQueryValue(card.roundId),
  );
}

function buildShareQuery(card) {
  const parts = [
    `user_id=${encodeURIComponent(card.userId)}`,
    `league_id=${encodeURIComponent(card.leagueId)}`,
    `season_id=${encodeURIComponent(card.seasonId)}`,
    `round_id=${encodeURIComponent(card.roundId)}`,
  ];
  const shareToken = readQueryValue(card.shareToken);
  if (shareToken) {
    parts.push(`share_token=${encodeURIComponent(shareToken)}`);
  }
  return parts.join("&");
}

function buildShareTitle(card) {
  const displayName = card.displayName || "预测分享卡";
  const leagueName = card.leagueName || LEAGUE_NAMES[card.leagueId] || card.leagueId || "";
  const roundLabel = compactRoundLabel(card.roundText, card.roundId) || "第?轮";
  if (card.showFullSummary) {
    const hasScore =
      card.roundScore !== null &&
      card.roundScore !== undefined &&
      Number.isFinite(Number(card.roundScore));
    const roundScore = hasScore ? Number(card.roundScore) : 0;
    return `${displayName} ${leagueName}${roundLabel}战绩：已拿 ${roundScore} 分`;
  }
  return `${displayName} 晒出了${leagueName}${roundLabel}预测`;
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
    shareToken: null,
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
  unloaded: false,
  pendingLoginRetry: false,
  loginReturnContext: null,

  onLoad(query) {
    this.unloaded = false;
    const options = query || {};
    const userId = readQueryValue(options.user_id);
    const leagueId = readQueryValue(options.league_id);
    const seasonId = readQueryValue(options.season_id);
    const roundId = normalizeRoundId(options.round_id);
    const shareToken = readQueryValue(options.share_token);
    const mode = userId ? "receiver" : "preview";
    const hasAll = Boolean(leagueId && seasonId && roundId);
    this.setData({
      mode,
      sharerId: userId,
      shareToken: userId ? shareToken : null,
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
      shareToken: context.shareToken || null,
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
      if (this.data.shareToken) {
        params.shareToken = this.data.shareToken;
      }
      return getShareCardForUser(this.data.sharerId, params);
    }
    return getMyShareCard(params);
  },

  onUnload() {
    this.unloaded = true;
    this.requestSerial += 1;
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
      if (this.unloaded || serial !== this.requestSerial) return;
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
      if (this.unloaded || serial !== this.requestSerial) return;
      this.setData({
        state: "card",
        card,
        errorKind: "",
        errorMessage: "",
      });
      this.syncShareMenu();
      return this.hydrateFavoriteTeam(card, serial);
    }
    if (this.unloaded || serial !== this.requestSerial) return;
    const mapped = this.mapCardError(result);
    this.setData({
      state: "error",
      card: null,
      errorKind: mapped.errorKind,
      errorMessage: mapped.errorMessage,
    });
    this.syncShareMenu();
  },

  async hydrateFavoriteTeam(card, serial) {
    const favoriteTeamId = card && card.favoriteTeamId;
    if (!favoriteTeamId || (card && card.isDeleted)) return;
    const syncState = resolveFavoriteTeamSync(favoriteTeamId, {
      findTeam,
      presentTeam,
      placeholder: PLACEHOLDER,
    });
    if (!syncState.needsRemoteLookup) return;
    try {
      const resolved = await resolveFavoriteTeamRemote(favoriteTeamId, {
        presentTeam,
        placeholder: PLACEHOLDER,
      });
      if (!resolved) return;
      if (this.unloaded || serial !== this.requestSerial) return;
      const currentCard = this.data.card;
      if (
        this.data.state !== "card" ||
        !currentCard ||
        currentCard.isDeleted ||
        currentCard.favoriteTeamId !== favoriteTeamId
      ) {
        return;
      }
      const nextText = resolved.favoriteTeamText || currentCard.favoriteTeamText || "已选择球队";
      const nextLogo = !isPlaceholderLogo(resolved.favoriteTeamLogo, PLACEHOLDER)
        ? resolved.favoriteTeamLogo
        : (currentCard.favoriteTeamLogo || PLACEHOLDER);
      if (nextText === currentCard.favoriteTeamText && nextLogo === currentCard.favoriteTeamLogo) {
        return;
      }
      this.setData({
        card: {
          ...currentCard,
          favoriteTeamText: nextText,
          favoriteTeamLogo: nextLogo,
        },
      });
    } catch (_error) {
      /* 远端球队资料补全失败时保留兜底展示，不阻塞卡片 */
    }
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
    if (statusCode === 429 || code === "RATE_LIMITED") {
      return { errorKind: "rateLimited", errorMessage: message || "请求过于频繁，请稍后再试" };
    }
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
        title: "预测分享卡",
        path: MATCHES_TAB_PATH,
      };
    }
    return {
      title: buildShareTitle(card),
      path: `/pages/share-card/share-card?${buildShareQuery(card)}`,
    };
  },

  onShareTimeline() {
    const card = this.data.card;
    if (this.data.state !== "card" || !isShareableCard(card)) {
      return {
        title: "预测分享卡",
        query: "",
      };
    }
    return {
      title: buildShareTitle(card),
      query: buildShareQuery(card),
    };
  },

  navigateToMatch(matchId, prefillHome, prefillAway) {
    if (!matchId) return;
    let url = `/pages/match-detail/match-detail?match_id=${encodeURIComponent(matchId)}`;
    const hasHome = prefillHome !== null && prefillHome !== undefined && prefillHome !== "";
    const hasAway = prefillAway !== null && prefillAway !== undefined && prefillAway !== "";
    if (hasHome && hasAway) {
      url += `&prefill_home=${encodeURIComponent(String(prefillHome))}&prefill_away=${encodeURIComponent(String(prefillAway))}`;
    }
    wx.navigateTo({ url });
  },

  onFollowTap(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    this.navigateToMatch(dataset.matchId, dataset.prefillHome, dataset.prefillAway);
  },

  onMatchTap(event) {
    const dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    const canFollow = dataset.canFollow === true || dataset.canFollow === "true";
    if (canFollow) {
      this.navigateToMatch(dataset.matchId, dataset.prefillHome, dataset.prefillAway);
      return;
    }
    this.navigateToMatch(dataset.matchId);
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
      shareToken: this.data.shareToken,
      leagueId: this.data.selectedLeagueId,
      seasonId: this.data.selectedSeasonId,
      roundId: this.data.selectedRoundId,
    };
    this.pendingLoginRetry = this.data.errorKind === "unauthorized";
    wx.navigateTo({ url: "/pages/session/session?return_to=share-card" });
  },

  onRetry() {
    if (this.data.errorKind === "rateLimited") return;
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
      ...(resetReceiver ? { mode: "preview", sharerId: null, shareToken: null } : {}),
    });
    this.syncShareMenu();
  },

  onCatalogRetry() {
    this.setData({ catalogError: "" });
    return this.loadCatalog();
  },
});
