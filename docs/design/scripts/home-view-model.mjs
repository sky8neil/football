/**
 * 首页各状态的 view model 导出（给 extract-home-visuals.py 当渲染输入）
 *
 * 关键原则：**不复制页面逻辑**。真实执行 miniprogram/pages/matches/matches.js，
 * 用 vm + wx/Page shim 把它的 data 原样取出来，因此状态类名、文案、状态机分支
 * 都来自当前实现，不会因为「重构一个镜像副本」而与线上失真。
 *
 * 做法与 miniprogram/pages/matches/matches.brand.test.mjs 一致：仓库根 package.json 是
 * "type": "module"，miniprogram 源码是 CommonJS，只能按原样 runInThisContext 加载。
 *
 * 用法：
 *   node docs/design/scripts/home-view-model.mjs --out /tmp/home-visuals
 * 产物：
 *   <out>/view-model.json   各场景的页面 data（含 anchor 时间，保证可复现）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));   // docs/design/scripts
const ROOT = resolve(HERE, "..", "..", "..");           // 仓库根
const MP = join(ROOT, "miniprogram");

/** 冻结时钟：快照必须可复现（日期条、北京时间解析都依赖 new Date()）。 */
const ANCHOR = "2026-09-26T12:00:00+08:00";
const anchorMs = new Date(ANCHOR).getTime();
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(anchorMs);
    else super(...args);
  }
  static now() {
    return anchorMs;
  }
}
globalThis.Date = FrozenDate;

// ---------- wx / Page shim ----------
const storage = { nickname: "Sky" };
const wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ""),
  setStorageSync: (k, v) => {
    storage[k] = v;
  },
  navigateTo() {},
  switchTab() {},
  showToast() {},
  request() {
    throw new Error("capture 阶段不应发起真实请求");
  },
};
globalThis.wx = wx;
globalThis.getApp = () => ({ globalData: {} });

let pageConfig = null;
globalThis.Page = (cfg) => {
  pageConfig = cfg;
};

// ---------- CommonJS 加载器（支持相对 require） ----------
// 注意：缓存的是 module 对象本身而不是 module.exports 的初始值 —— 小程序模块用的是
// `module.exports = {...}` 重新赋值，缓存初始对象会让第二次 require 拿到空壳。
const cache = new Map();
function loadCommonJs(filePath) {
  const real = resolve(filePath);
  if (cache.has(real)) return cache.get(real).exports;
  const source = readFileSync(real, "utf8");
  const moduleShim = { exports: {} };
  cache.set(real, moduleShim);
  const factory = runInThisContext(
    "(function (module, exports, require) {\n" + source + "\n})",
    { filename: real },
  );
  const requireShim = (id) => {
    if (!id.startsWith(".")) throw new Error("只支持相对路径 require：" + id);
    return loadCommonJs(join(dirname(real), id));
  };
  factory(moduleShim, moduleShim.exports, requireShim);
  return moduleShim.exports;
}

const nicknameMod = loadCommonJs(join(MP, "utils", "nickname.js"));
loadCommonJs(join(MP, "pages", "matches", "matches.js"));

if (!pageConfig) throw new Error("matches.js 没有调用 Page()，页面代码可能已改结构");

/** 造一个尽量贴近微信语义的页面实例：data 深拷贝、setData 浅合并。 */
function instantiate() {
  const inst = Object.assign({}, pageConfig);
  inst.data = JSON.parse(JSON.stringify(pageConfig.data));
  inst.drafts = {};
  inst.uiStates = {};
  inst.submittedMap = {};
  inst.idempotencyKeys = {};
  inst.lastPayloads = {};
  inst.requestSerial = 0;
  inst.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  return inst;
}

const scenarios = {};

// 1) 列表态：真实 mock（英超 5 场，覆盖未开赛/已提交/进行中/完场/未开赛）
{
  const p = instantiate();
  p.onLoad();
  scenarios.list = p.data;
}

// 2) 展开预测（第一张可预测卡进入 editing，比分非 0:0 以覆盖 derivedResult 非「平局」）
{
  const p = instantiate();
  p.onLoad();
  const target = p.data.items.find((i) => i.showPredict);
  p.uiStates[target.key] = "editing";
  p.drafts[target.key] = { home: 2, away: 1 };
  p.refreshItems();
  scenarios.editing = p.data;
}

// 3) 提交中（按钮 loading 态）
{
  const p = instantiate();
  p.onLoad();
  const target = p.data.items.find((i) => i.showPredict);
  p.uiStates[target.key] = "submitting";
  p.refreshItems();
  scenarios.submitting = p.data;
}

// 4) 提交失败（submitError 文案）
{
  const p = instantiate();
  p.onLoad();
  const target = p.data.items.find((i) => i.showPredict);
  p.uiStates[target.key] = "editing";
  p.data.submitErrors = { [target.key]: "提交失败：网络异常，请重试" };
  p.refreshItems();
  scenarios.submit_error = p.data;
}

// 5) 已提交锁定（submitted_locked）
{
  const p = instantiate();
  p.onLoad();
  const target = p.data.items.find((i) => i.showPredict);
  p.submittedMap[target.key] = { home: 1, away: 0 };
  p.refreshItems();
  scenarios.submitted_locked = p.data;
}

// 6) 追加状态卡：延期 / 取消 / +12 精确命中 / +0 未命中
//    这几类 mock 里没有现成数据，但状态机与样式类真实存在（statusView / RESULT_TEXT）。
//    用页面自己的 decorateItem 计算类名与文案，只把输入 fixture 造出来。
{
  const p = instantiate();
  p.onLoad();
  const base = p.data.items[0];
  const make = (over) =>
    p.decorateItem(
      Object.assign({}, {
        match_id: "capture-extra",
        league_id: p.data.selectedLeague,
        league_name: "英超",
        round_id: "capture",
        kickoff_at: "2026-09-26T20:30:00+08:00",
        match_status: "scheduled",
        can_predict: false,
        can_predict_reason: null,
        regular_home_score: null,
        regular_away_score: null,
        home_team: base.home_team,
        away_team: base.away_team,
      }, over),
    );
  p.setData({
    items: [
      make({ match_status: "postponed" }),
      make({ match_status: "cancelled" }),
      make({ match_status: "finished", regular_home_score: 2, regular_away_score: 1, result_type: "hit12", my_prediction: { pred_home_score: 2, pred_away_score: 1 } }),
      make({ match_status: "finished", regular_home_score: 0, regular_away_score: 3, result_type: "miss", my_prediction: { pred_home_score: 2, pred_away_score: 1 } }),
    ],
    openCount: 0,
    doneCount: 0,
  });
  scenarios.extra_states = p.data;
}

// 7) 加载中 / 空 / 错误
for (const [name, patch] of Object.entries({
  loading: { state: "loading", items: [], resultsTransition: "results-enter" },
  empty: { state: "empty", items: [] },
  error: { state: "error", items: [], errorMessage: "网络开小差，请稍后重试" },
})) {
  const p = instantiate();
  p.onLoad();
  p.setData(patch);
  scenarios[name] = p.data;
}

// 8) 长昵称（真跑到 12 字截断上限）+ 更多按钮
{
  const p = instantiate();
  p.onLoad();
  p.setData({
    nickname: nicknameMod.truncateNickname("阿森纳铁杆球迷张三丰永不独行"),
    hasMore: true,
    loadingMore: false,
    resultsTransition: "results-exit",
  });
  scenarios.long_nickname_more = p.data;
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(ROOT, "docs/design/baselines");

mkdirSync(outDir, { recursive: true });
const payload = {
  anchor: ANCHOR,
  scenarios: Object.keys(scenarios),
  data: scenarios,
};
writeFileSync(join(outDir, "view-model.json"), JSON.stringify(payload, null, 1));

console.log("场景数：" + payload.scenarios.length + " → " + payload.scenarios.join(", "));
console.log("view-model.json 已写入 " + outDir);
