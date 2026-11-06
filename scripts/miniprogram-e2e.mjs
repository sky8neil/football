/**
 * 小程序主流程端到端冒烟 —— 用微信开发者工具的自动化接口跑真实小程序。
 *
 * 覆盖链路：会话页 → 云函数 api → 云数据库 → 首页列表 → 比赛详情 → tab 切换。
 *
 * 前置条件（缺一不可）：
 *   1. 已安装微信开发者工具，且已登录当前 AppID 所属的微信号
 *   2. 开发者工具 → 设置 → 安全设置 → 服务端口：已开启
 *   3. 根目录 project.config.json 的 appid 是当前在用的 AppID
 *
 * 用法：
 *   npm run e2e:main                 跑完关闭开发者工具
 *   npm run e2e:main -- --keep-open   跑完保留开发者工具窗口
 *
 * 退出码：0 全通过；1 有失败项。
 *
 * 关于日期的说明：首页日期条按北京时间切日，而云端 kickoff_at 存 UTC。
 * 所以「今天」可能真的没有比赛（比如英超最近一场在北京时间次日凌晨）。
 * 脚本因此不硬断言今天有数据，而是按用户真实路径往后翻日期找比赛。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import automator from "miniprogram-automator";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const SHOT_DIR = resolve(ROOT, ".e2e-screenshots");

// 注意：currentPage().path 返回不带前导斜杠（pages/xxx/xxx），
// 而 navigateTo/reLaunch 需要带斜杠（/pages/xxx/xxx）。统一用 normalize 比较。
const SESSION = "/pages/session/session";
const HOME = "/pages/matches/matches";
const DETAIL = "/pages/match-detail/match-detail";
const NICKNAME = "自动化球友";

const normalize = (path) => String(path ?? "").replace(/^\//, "");

const results = [];
const runtimeErrors = [];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(name, fn) {
  process.stdout.write(`${name} …\n`);
  try {
    record(name, true, await fn());
  } catch (error) {
    record(name, false, String(error?.message ?? error).slice(0, 300));
  }
}

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${step}${detail ? ` — ${detail}` : ""}`);
}

async function waitForPage(miniProgram, targetPath, timeoutMs = 45000) {
  const target = normalize(targetPath);
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const page = await miniProgram.currentPage();
      last = page?.path ?? "";
      if (normalize(last) === target) return page;
    } catch (_error) {
      /* 切页瞬间取不到，继续轮询 */
    }
    await sleep(500);
  }
  throw new Error(`等待 ${targetPath} 超时，最后停在 ${last || "(未知)"}`);
}

async function shot(miniProgram, name) {
  const path = resolve(SHOT_DIR, `${name}.png`);
  await miniProgram.screenshot({ path });
  return path.replace(`${ROOT}/`, "");
}

/** 首页 state 的「有数据」态叫 list（见 matches.wxml 的分支），不是 ready。 */
const hasItems = (data) => data?.state === "list" && Array.isArray(data.items) && data.items.length > 0;

/** 按用户真实路径往后翻日期，直到翻到有比赛的一天；当前联赛没有就换联赛再翻。 */
async function findDayWithMatches(page, maxDays = 6) {
  const attempts = [];
  const leagueCount = (await page.$$(".league")).length;
  for (let leagueIndex = 0; leagueIndex < Math.max(leagueCount, 1); leagueIndex += 1) {
    const leagues = await page.$$(".league");
    if (leagueIndex > 0) {
      if (!leagues[leagueIndex]) break;
      await leagues[leagueIndex].tap();
      await sleep(2000);
    }
    for (let index = 0; index < maxDays; index += 1) {
      const dates = await page.$$(".date");
      if (!dates[index]) break;
      await dates[index].tap();
      await sleep(1800);
      const data = await page.data();
      attempts.push(`L${leagueIndex}D${index}:${data.state}/${data.items?.length ?? "?"}`);
      if (hasItems(data)) {
        return { leagueIndex, index, data };
      }
    }
  }
  throw new Error(`翻遍 ${leagueCount} 个联赛 × ${maxDays} 天都没有比赛（${attempts.slice(0, 12).join(" ")}）`);
}

async function main() {
  const keepOpen = process.argv.includes("--keep-open");
  mkdirSync(SHOT_DIR, { recursive: true });

  console.log("启动微信开发者工具（自动化模式）…");
  const miniProgram = await automator.launch({
    projectPath: ROOT,
    cliPath: CLI_PATH,
    timeout: 180000,
  });

  // 小程序侧异常不会中断 node 进程，必须显式收集，否则会假绿。
  if (typeof miniProgram.on === "function") {
    miniProgram.on("exception", (error) => runtimeErrors.push(String(error?.message ?? error).slice(0, 300)));
    miniProgram.on("console", (msg) => {
      if (msg?.type === "error") runtimeErrors.push(String(msg.args?.join(" ") ?? "").slice(0, 300));
    });
  }

  let sessionPage = null;
  await step("0. 清空本地缓存（保证会话页是首次进入状态）", async () => {
    // 昵称缓存在 Storage 里，不清的话第二次跑会发现昵称已回填，
    // 空昵称拦截和输入用例全部失真。
    await miniProgram.callWxMethod("clearStorageSync");
    return "已清空 Storage";
  });

  await step("1. 打开会话页", async () => {
    await miniProgram.reLaunch(SESSION);
    sessionPage = await waitForPage(miniProgram, SESSION);
    const data = await sessionPage.data();
    assert(data.nickname === "", `会话页昵称应为空，实际 "${data.nickname}"`);
    return sessionPage.path;
  });

  await step("2. 空昵称被前端拦下（不发请求）", async () => {
    assert(sessionPage, "会话页未打开");
    const cta = await sessionPage.$(".cta");
    assert(cta, "找不到提交按钮 .cta");
    await cta.tap();
    await sleep(800);
    const data = await sessionPage.data();
    assert(data.errorMessage, "空昵称提交后没有错误提示");
    assert(data.loading === false, "空昵称不应进入 loading");
    return data.errorMessage;
  });

  await step("3. 输入昵称并实时计字", async () => {
    const input = await sessionPage.$(".nickname-input");
    assert(input, "找不到输入框 .nickname-input");
    await input.input(NICKNAME);
    await sleep(600);
    const data = await sessionPage.data();
    assert(data.nickname === NICKNAME, `昵称未写入，实际 "${data.nickname}"`);
    assert(data.lengthText === `${NICKNAME.length}/32`, `字数显示异常：${data.lengthText}`);
    return data.lengthText;
  });

  await step("4. 提交昵称 → 云函数创建会话 → 跳首页", async () => {
    const cta = await sessionPage.$(".cta");
    await cta.tap();
    await waitForPage(miniProgram, HOME);
    return "已进入首页";
  });

  let homePage = null;
  await step("5. 首页加载完成且无错误", async () => {
    homePage = await waitForPage(miniProgram, HOME);
    const deadline = Date.now() + 40000;
    let data = await homePage.data();
    while (Date.now() < deadline && data.state === "loading") {
      await sleep(1000);
      data = await homePage.data();
    }
    assert(data.state !== "loading", "首页一直 loading，云函数没有响应");
    assert(data.state !== "error", `首页报错：${data.errorMessage}`);
    assert(data.nickname === NICKNAME, `首页昵称未带出，实际 "${data.nickname}"`);
    return `state=${data.state} 昵称=${data.nickname} 默认联赛=${data.selectedLeague}`;
  });

  await step("6. 翻日期能找到云端比赛并按联赛过滤", async () => {
    assert(homePage, "首页未打开");
    const found = await findDayWithMatches(homePage);
    const leagues = await homePage.$$(".league");
    assert(leagues.length === 6, `联赛 tab 应有 6 个，实际 ${leagues.length}`);
    const leagueId = found.data.items[0].league_id;
    return `联赛#${found.leagueIndex} 第 ${found.index} 天有 ${found.data.items.length} 场，示例 ${leagueId}`;
  });

  await step("7. 点比赛卡片进入详情页", async () => {
    const cards = await homePage.$$(".match");
    assert(cards.length > 0, "找不到比赛卡片 .match");
    await cards[0].tap();
    const detail = await waitForPage(miniProgram, DETAIL);
    const deadline = Date.now() + 30000;
    let data = await detail.data();
    while (Date.now() < deadline && data.state === "loading") {
      await sleep(800);
      data = await detail.data();
    }
    assert(data.state !== "error", `详情页报错：${data.errorMessage}`);
    assert(data.match, "详情页 match 为空");
    const file = await shot(miniProgram, "0-detail");
    return `${data.match.home_team?.name ?? "?"} vs ${data.match.away_team?.name ?? "?"}｜${file}`;
  });

  await step("8. 四个 tab 均可切换", async () => {
    const shots = [];
    await miniProgram.switchTab("/pages/rankings/rankings");
    await sleep(2500);
    shots.push(await shot(miniProgram, "1-rankings"));
    await miniProgram.switchTab("/pages/profile/profile");
    await sleep(2000);
    shots.push(await shot(miniProgram, "2-profile"));
    await miniProgram.switchTab("/pages/matches/matches");
    await sleep(2000);
    shots.push(await shot(miniProgram, "3-home"));
    return shots.join(", ");
  });

  await step("9. 运行期无未捕获异常", async () => {
    const noise = runtimeErrors.filter((item) => item && !/devtools|DeprecationWarning/i.test(item));
    assert(noise.length === 0, `${noise.length} 条异常：${noise.slice(0, 3).join(" | ")}`);
    return "无异常";
  });

  if (!keepOpen) await miniProgram.close();

  const failed = results.filter((item) => !item.ok);
  console.log("");
  console.log(failed.length === 0
    ? `主流程通过：${results.length}/${results.length}`
    : `主流程失败：${failed.length} 项未过（共 ${results.length} 项）`);
  for (const item of failed) console.log(`  ✗ ${item.step}: ${item.detail}`);
  console.log(`截图：${SHOT_DIR}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error("脚本异常：", String(error?.message ?? error).slice(0, 500));
}
process.exit(exitCode);
