const { listMatches } = require("../../services/matches.js");

const LEAGUES = [
  { id: "premier_league", name: "英超", mark: "pl", markText: "PL" },
  { id: "laliga", name: "西甲", mark: "ll", markText: "LL" },
  { id: "ligue1", name: "法甲", mark: "l1", markText: "L1" },
  { id: "csl", name: "中超", mark: "csl", markText: "中" },
];

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function beijingParts(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const text = date.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  const [ymd, hms] = text.split(" ");
  const [year, month, day] = ymd.split("-").map(Number);
  const [hour, minute] = hms.split(":").map(Number);
  return { year, month, day, hour, minute, key: ymd };
}

function buildDates(anchor) {
  const start = new Date(anchor.getTime());
  start.setHours(12, 0, 0, 0);
  const dates = [];
  for (let i = 0; i < 5; i += 1) {
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + i);
    const weekday = WEEKDAYS[d.getDay()];
    dates.push({
      key: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()),
      label: i === 0 ? "今天" : i === 1 ? "明天" : weekday,
      day: pad(d.getDate()),
    });
  }
  return dates;
}

function dayBounds(key) {
  return {
    from: key + "T00:00:00+08:00",
    to: key + "T23:59:59+08:00",
  };
}

function firstChar(name) {
  const text = String(name || "").trim();
  return text ? text.slice(0, 1) : "?";
}

function statusView(item) {
  const status = item.match_status;
  const reason = item.can_predict_reason;
  if (status === "live") {
    return { cardClass: "is-live", stateClass: "live", stateText: "进行中" };
  }
  if (status === "finished") {
    return { cardClass: "is-done", stateClass: "done", stateText: "完场" };
  }
  if (status === "postponed") {
    return { cardClass: "is-closed", stateClass: "closed", stateText: "延期" };
  }
  if (status === "cancelled") {
    return { cardClass: "is-closed", stateClass: "closed", stateText: "取消" };
  }
  if (status === "abandoned") {
    return { cardClass: "is-closed", stateClass: "closed", stateText: "腰斩" };
  }
  if (status === "scheduled" && reason === "ALREADY_SUBMITTED") {
    return { cardClass: "is-submitted", stateClass: "lock", stateText: "已提交" };
  }
  if (status === "scheduled" && item.can_predict && reason === null) {
    return { cardClass: "is-open", stateClass: "", stateText: "未开赛" };
  }
  if (reason === "ALREADY_SUBMITTED") {
    return { cardClass: "is-submitted", stateClass: "lock", stateText: "已提交" };
  }
  if (status === "scheduled") {
    return { cardClass: "is-closed", stateClass: "closed", stateText: "未开赛" };
  }
  return { cardClass: "is-closed", stateClass: "closed", stateText: "未开赛" };
}

function reasonChip(item) {
  if (item.can_predict && item.can_predict_reason === null) {
    return { reasonChip: "", chipClass: "" };
  }
  const map = {
    ALREADY_SUBMITTED: ["已锁定 · 不可修改", "lock"],
    AUTH_REQUIRED: ["需登录后预测", "auth"],
    USER_DELETED: ["账号已注销", "closed"],
    KICKOFF_UNCONFIRMED: ["开球未确认", "closed"],
    NOT_SCHEDULED: ["非可预测赛程", "closed"],
    CLOSED: ["预测已关闭", "live"],
  };
  const hit = map[item.can_predict_reason];
  if (hit) {
    return { reasonChip: hit[0], chipClass: hit[1] };
  }
  if (item.match_status === "live") {
    return { reasonChip: "预测已关闭", chipClass: "live" };
  }
  if (item.match_status === "finished") {
    return { reasonChip: "已结束", chipClass: "lock" };
  }
  return { reasonChip: "", chipClass: "" };
}

function decorateItem(item) {
  const kick = beijingParts(item.kickoff_at);
  const status = statusView(item);
  const chips = reasonChip(item);
  const hasScore = item.regular_home_score !== null && item.regular_away_score !== null;
  const liveOrDone = item.match_status === "live" || item.match_status === "finished";
  let predText = "未开赛";
  if (item.can_predict && item.can_predict_reason === null) {
    predText = "未开赛";
  } else if (item.can_predict_reason === "ALREADY_SUBMITTED") {
    predText = "我的预测已提交";
  } else if (item.match_status === "finished" && !hasScore) {
    predText = "待结算/暂无比分";
  } else if (item.match_status === "finished") {
    predText = "完场";
  } else if (item.match_status === "live") {
    predText = "比赛进行中";
  } else if (item.can_predict_reason) {
    predText = chips.reasonChip || "暂不可预测";
  }

  return Object.assign({}, item, status, chips, {
    timeText: kick ? pad(kick.hour) + ":" + pad(kick.minute) : "--:--",
    metaText: "英超 · " + (item.round_id || "本轮"),
    homeMark: firstChar(item.home_team && item.home_team.name),
    awayMark: firstChar(item.away_team && item.away_team.name),
    scoreText: hasScore ? item.regular_home_score + " : " + item.regular_away_score : "VS",
    scoreSub: item.match_status === "live" ? "LIVE" : item.match_status === "finished" ? (hasScore ? "FT" : "待结算") : (kick ? pad(kick.hour) + ":" + pad(kick.minute) : ""),
    bugClass: liveOrDone ? (item.match_status === "live" ? "dark live" : "dark") : "",
    predText,
  });
}

Page({
  data: {
    state: "loading",
    items: [],
    errorMessage: "",
    hasMore: false,
    nextCursor: null,
    loadingMore: false,
    leagues: LEAGUES,
    selectedLeague: "premier_league",
    dates: [],
    selectedDate: "",
    openCount: 0,
    doneCount: 0,
    recentScore: 12,
  },

  onLoad() {
    const dates = buildDates(new Date());
    this.setData({ dates, selectedDate: dates[0].key });
    this.loadFirstPage();
  },

  onLeagueTap(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || id === this.data.selectedLeague) {
      return;
    }
    this.setData({ selectedLeague: id });
    if (id !== "premier_league") {
      this.setData({
        state: "empty",
        items: [],
        hasMore: false,
        nextCursor: null,
        openCount: 0,
        doneCount: 0,
        errorMessage: "",
      });
      return;
    }
    this.loadFirstPage();
  },

  onDateTap(event) {
    const key = event.currentTarget.dataset.key;
    if (!key || key === this.data.selectedDate) {
      return;
    }
    this.setData({ selectedDate: key });
    this.loadFirstPage();
  },

  onCalendarTap() {},

  onRetry() {
    this.loadFirstPage();
  },

  loadFirstPage() {
    if (this.data.selectedLeague !== "premier_league") {
      this.setData({
        state: "empty",
        items: [],
        hasMore: false,
        nextCursor: null,
        openCount: 0,
        doneCount: 0,
        errorMessage: "",
      });
      return;
    }
    const bounds = dayBounds(this.data.selectedDate);
    this.setData({
      state: "loading",
      items: [],
      errorMessage: "",
      hasMore: false,
      nextCursor: null,
    });
    listMatches({ from: bounds.from, to: bounds.to }).then((result) => {
      this.applyListResult(result, true);
    });
  },

  applyListResult(result, replace) {
    if (result.statusCode === 429 && result.code === "RATE_LIMITED") {
      this.setData({
        state: replace && this.data.items.length === 0 ? "error" : this.data.state,
        errorMessage: result.message || result.code,
        loadingMore: false,
      });
      return;
    }
    if (result.statusCode !== 200) {
      this.setData({
        state: "error",
        errorMessage: result.message || String(result.code || result.statusCode),
        loadingMore: false,
      });
      return;
    }
    const payload = result.data || {};
    const items = (Array.isArray(payload.items) ? payload.items : []).map(decorateItem);
    const page = payload.page || {};
    const merged = replace ? items : this.data.items.concat(items);
    const openCount = merged.filter((item) => item.can_predict && item.can_predict_reason === null).length;
    const doneCount = merged.filter((item) => item.can_predict_reason === "ALREADY_SUBMITTED").length;
    this.setData({
      state: merged.length === 0 ? "empty" : "list",
      items: merged,
      hasMore: page.has_more === true,
      nextCursor: page.next_cursor === undefined ? null : page.next_cursor,
      errorMessage: "",
      loadingMore: false,
      openCount,
      doneCount,
    });
  },

  onCardTap(event) {
    const matchId = event.currentTarget.dataset.matchId;
    if (!matchId) {
      return;
    }
    wx.navigateTo({
      url: "/pages/match-detail/match-detail?id=" + matchId,
    });
  },

  onMore() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.nextCursor === null) {
      return;
    }
    const bounds = dayBounds(this.data.selectedDate);
    this.setData({ loadingMore: true, errorMessage: "" });
    listMatches({
      from: bounds.from,
      to: bounds.to,
      cursor: this.data.nextCursor,
    }).then((result) => {
      this.applyListResult(result, false);
    });
  },
});
