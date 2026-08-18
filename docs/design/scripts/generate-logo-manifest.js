#!/usr/bin/env node
/**
 * 赛事预言家 Logo Asset Manifest 生成器
 *
 * 扫描 /root/football_logos（Source Asset Library）中已启用的联赛，
 * 按统一尺寸规则挑选球队/联赛 Logo，输出到 docs/design/assets/logos/，
 * 并生成 manifest.js（运行时 Registry）与 manifest.json（元数据）。
 *
 * 用法：
 *   node docs/design/scripts/generate-logo-manifest.js
 *
 * 规则（与业务规范一致）：
 *   - 五大联赛 + 欧冠：优先 128x128（球队），联赛官方 Logo 用 256x256
 *   - 中超：球队 512x512，联赛 Logo 512x512
 *   - 新增加一支球队 Logo → 把文件放入源目录对应尺寸文件夹，重跑本脚本即可
 *   - 页面组件永远不写死图片路径，一律走 manifest.getTeamLogo / getLeagueLogo
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
// 源素材库（只读，不修改）
const SOURCE_ROOT = "/root/football_logos";

// 输出目录（项目运行时资源）
const OUT_ROOT = path.resolve(__dirname, "../assets/logos");

// 联赛定义：目录名 -> { leagueId, leagueDir, teamSize, leagueSize }
// leagueId 是稳定业务 ID（与后端 MVP_SEASON.league_id 对齐）
const LEAGUES = [
  { leagueId: "premier_league",      dir: "01_英超_Premier_League",           teamSize: "128x128", leagueSize: "256x256" },
  { leagueId: "la_liga",             dir: "02_西甲_La_Liga",                  teamSize: "128x128", leagueSize: "256x256" },
  { leagueId: "ligue_1",             dir: "03_法甲_Ligue_1",                  teamSize: "128x128", leagueSize: "256x256" },
  { leagueId: "chinese_super_league", dir: "07_中超_Chinese_Super_League",    teamSize: "512x512", leagueSize: "512x512" },
];

// 未来启用时只需在此追加（德甲/意甲/欧冠），无需改页面
// { leagueId: "bundesliga", dir: "04_德甲_Bundesliga", teamSize: "128x128", leagueSize: "256x256" },
// { leagueId: "serie_a",    dir: "05_意甲_Serie_A",    teamSize: "128x128", leagueSize: "256x256" },
// { leagueId: "champions_league", dir: "06_欧冠_Champions_League", teamSize: "128x128", leagueSize: "256x256" },

// 联赛官方 Logo 子目录名（源目录内）
const LEAGUE_LOGO_DIR = "00_联赛官方Logo_League_Official";

// 中超 teams 目录里混入的联赛/国家队 logo 文件（从球队 manifest 剔除）
const CSL_EXCLUDE = ["chinese-super-league", "china-national-team"];

// ---------- 工具 ----------
function slugify(name) {
  // 去掉 .football-logos.cc.png / .hash.png 后缀
  return name
    .replace(/\.football-logos\.cc\.png$/i, "")
    .replace(/\.png$/i, "")
    .replace(/\.\w+$/, "") // 中超 hash 后缀 (如 .1df87f4d)
    .replace(/\s+/g, "-");
}

function collectFiles(dir, size, exclude = []) {
  const full = path.join(dir, size);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .filter((f) => !exclude.some((x) => f.startsWith(x + ".")))
    .sort();
}

// ---------- 生成 ----------
// 确保输出目录存在
for (const sub of ["leagues", "teams", "placeholders"]) {
  fs.mkdirSync(path.join(OUT_ROOT, sub), { recursive: true });
}

const teams = {};
const leagues = {};
const teamFiles = {}; // leagueId -> { key: srcFilename }

for (const lg of LEAGUES) {
  const lgRoot = path.join(SOURCE_ROOT, lg.dir);

  // 联赛 Logo
  const lgLogoDir = path.join(lgRoot, LEAGUE_LOGO_DIR, lg.leagueSize);
  if (fs.existsSync(lgLogoDir)) {
    const files = fs.readdirSync(lgLogoDir).filter((f) => f.toLowerCase().endsWith(".png") && !f.includes("--"));
    if (files.length) {
      const f = files[0];
      const destName = `${lg.leagueId}.png`;
      fs.copyFileSync(path.join(lgLogoDir, f), path.join(OUT_ROOT, "leagues", destName));
      leagues[lg.leagueId] = `assets/logos/leagues/${destName}`;
    }
  }

  // 球队 Logo
  const excl = lg.leagueId === "chinese_super_league" ? CSL_EXCLUDE : [];
  const srcFiles = collectFiles(lgRoot, lg.teamSize, excl);
  const subdir = lg.leagueId.replace(/_/g, "-");
  const outDir = path.join(OUT_ROOT, "teams", subdir);
  fs.mkdirSync(outDir, { recursive: true });

  teams[lg.leagueId] = {};
  teamFiles[lg.leagueId] = {};
  for (const f of srcFiles) {
    const key = slugify(f);
    const destName = `${key}.png`;
    fs.copyFileSync(path.join(lgRoot, lg.teamSize, f), path.join(outDir, destName));
    teams[lg.leagueId][key] = `assets/logos/teams/${subdir}/${destName}`;
    teamFiles[lg.leagueId][key] = f;
  }
}

// ---------- 输出 ----------
const manifest = {
  version: 1,
  generated_at: new Date().toISOString(),
  source: SOURCE_ROOT,
  league_logos: leagues,
  team_logos: teams,
  // 记录源文件名 → 便于审计与 alias 建立
  source_files: teamFiles,
};

const jsContent = `/**
 * 赛事预言家 Logo Asset Registry（自动生成，勿手改）
 * 生成命令：node docs/design/scripts/generate-logo-manifest.js
 * 数据源：/root/football_logos
 */
(function (root, factory) {
  const data = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { LOGO_MANIFEST: data };
  }
  root.LOGO_MANIFEST = data;
})(globalThis, function () {
  return ${JSON.stringify(manifest, null, 2)};
});
`;

fs.writeFileSync(path.join(OUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT_ROOT, "manifest.js"), jsContent);

// ---------- 摘要 ----------
console.log("✅ Logo Manifest 生成完成");
console.log(`   联赛: ${Object.keys(leagues).join(", ")}`);
for (const [lg, list] of Object.entries(teams)) {
  console.log(`   球队 ${lg}: ${Object.keys(list).length} 支`);
}
