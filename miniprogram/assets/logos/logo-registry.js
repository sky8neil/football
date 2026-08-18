/**
 * 赛事预言家 Logo Asset Registry（统一资源查询层）
 *
 * 所有页面（首页 Match Card / 预测编辑 / 排行榜 / 我的 / 历史预测 / 主队选择 / 分享卡）
 * 只通过 getTeamLogo / getLeagueLogo 取 Logo，永远不写死图片路径。
 *
 * 查询链路：
 *   team_id (或 alias)  →  TEAM_LOGOS[league_id][team_key]  →  logo 文件
 *   league_id           →  LEAGUE_LOGOS[league_id]          →  logo 文件
 *
 * 找不到时返回占位图（team-placeholder.png），不产生破图。
 *
 * 使用方式：
 *   浏览器：<script src="assets/logos/manifest.js"></script>
 *          <script src="assets/logos/logo-registry.js"></script>
 *          window.FootballLogoRegistry.getTeamLogo("premier_league", "arsenal")
 *   Node：  const R = require("./logo-registry.js");  // 需先设置 globalThis.LOGO_MANIFEST
 */
(function (root, factory) {
  const manifestData = root.LOGO_MANIFEST || {};
  const registry = factory(manifestData);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = registry;
  }
  root.FootballLogoRegistry = registry;
})(globalThis, function (manifestData) {
  const MANIFEST = manifestData && manifestData.LOGO_MANIFEST ? manifestData.LOGO_MANIFEST : manifestData;

  const PLACEHOLDER = "assets/logos/placeholders/team-placeholder.png";

  // ---------- Team Alias 映射（集中管理，禁止散落在页面） ----------
  // 所有别名统一指向 manifest 中的稳定 asset key（slug）。
  // 新增球队名称变体 → 在此追加一行即可，无需改页面。
  const TEAM_ALIASES = {
    // 英超
    "manchester-city": ["曼城", "曼彻斯特城", "Manchester City", "Man City", "曼市"],
    "manchester-united": ["曼联", "曼彻斯特联", "Manchester United", "Man United", "Man Utd"],
    "arsenal": ["阿森纳", "Arsenal", "枪手"],
    "chelsea": ["切尔西", "Chelsea", "蓝军"],
    "liverpool": ["利物浦", "Liverpool", "红军"],
    "tottenham": ["热刺", "托特纳姆热刺", "Tottenham", "Spurs", "托特纳姆"],
    "newcastle": ["纽卡斯尔", "纽卡", "Newcastle"],
    "aston-villa": ["阿斯顿维拉", "维拉", "Aston Villa"],
    "everton": ["埃弗顿", "Everton"],
    "brighton": ["布莱顿", "Brighton", "布赖顿"],
    "west-ham": ["西汉姆", "西汉姆联", "West Ham"],
    "nottingham-forest": ["诺丁汉森林", "诺丁汉", "Nottingham Forest"],
    "brentford": ["布伦特福德", "小蜜蜂", "Brentford"],
    "bournemouth": ["伯恩茅斯", "Bournemouth"],
    "fulham": ["富勒姆", "Fulham"],
    "crystal-palace": ["水晶宫", "Crystal Palace"],
    "leeds-united": ["利兹联", "利兹", "Leeds United"],
    "ipswich": ["伊普斯维奇", "Ipswich"],
    "coventry-city": ["考文垂", "Coventry City"],
    "hull-city": ["赫尔城", "Hull City"],
    "sunderland": ["桑德兰", "Sunderland"],
    // 西甲
    "real-madrid": ["皇家马德里", "皇马", "Real Madrid", "RM"],
    "barcelona": ["巴塞罗那", "巴萨", "Barcelona", "FC Barcelona"],
    "atletico-madrid": ["马德里竞技", "马竞", "Atletico Madrid", "Atlético Madrid"],
    "sevilla": ["塞维利亚", "Sevilla", "Seville"],
    "athletic-club": ["毕尔巴鄂竞技", "毕尔巴鄂", "Athletic Club", "Bilbao"],
    "real-sociedad": ["皇家社会", "Real Sociedad"],
    "villarreal": ["比利亚雷亚尔", "黄潜", "Villarreal"],
    "real-betis": ["皇家贝蒂斯", "贝蒂斯", "Real Betis"],
    "valencia": ["瓦伦西亚", "Valencia"],
    "celta": ["塞尔塔", "Celta Vigo", "Celta"],
    "osasuna": ["奥萨苏纳", "Osasuna"],
    "getafe": ["赫塔菲", "Getafe"],
    "espanyol": ["西班牙人", "Espanyol"],
    "rayo-vallecano": ["巴列卡诺", "Rayo Vallecano"],
    "deportivo": ["拉科鲁尼亚", "Deportivo", "Deportivo La Coruna"],
    "deportivo-la-coruna": ["拉科鲁尼亚", "Deportivo La Coruna"],
    "malaga": ["马拉加", "Málaga", "Malaga"],
    "levante": ["莱万特", "Levante"],
    "elche": ["埃尔切", "Elche"],
    "racing": ["桑坦德竞技", "Racing Santander", "Racing"],
    // 法甲
    "paris-saint-germain": ["巴黎圣日耳曼", "巴黎", "PSG", "Paris Saint-Germain", "大巴黎"],
    "marseille": ["马赛", "Marseille", "OM", "Olympique de Marseille"],
    "lyon": ["里昂", "Lyon", "Olympique Lyonnais"],
    "lille": ["里尔", "Lille", "LOSC"],
    "as-monaco": ["摩纳哥", "Monaco"],
    "nice": ["尼斯", "Nice", "OGC Nice"],
    "rennes": ["雷恩", "Rennes", "Stade Rennais"],
    "rc-lens": ["朗斯", "Lens"],
    "rc-strasbourg-alsace": ["斯特拉斯堡", "Strasbourg"],
    "toulouse": ["图卢兹", "Toulouse"],
    "auxerre": ["欧塞尔", "Auxerre"],
    "brest": ["布雷斯特", "Brest"],
    "angers": ["昂热", "Angers"],
    "le-havre-ac": ["勒阿弗尔", "Le Havre"],
    "lorient": ["洛里昂", "Lorient"],
    "troyes": ["特鲁瓦", "Troyes"],
    "le-mans": ["勒芒", "Le Mans"],
    "paris-fc": ["巴黎FC", "Paris FC"],
    // 中超
    "shanghai-port": ["上海海港", "上海港", "Shanghai Port", "海港"],
    "shanghai-shenhua": ["上海申花", "申花", "Shanghai Shenhua"],
    "beijing-guoan": ["北京国安", "国安", "Beijing Guoan"],
    "shandong-taishan": ["山东泰山", "泰山", "Shandong Taishan", "山东鲁能"],
    "chengdu-rongcheng": ["成都蓉城", "蓉城", "Chengdu Rongcheng"],
    "zhejiang-professional": ["浙江队", "浙江", "Zhejiang Professional", "浙江绿城"],
    "wuhan-three-towns": ["武汉三镇", "三镇", "Wuhan Three Towns"],
    "tianjin-jinmen-tiger": ["天津津门虎", "津门虎", "Tianjin Jinmen Tiger", "天津泰达"],
    "henan-songshan-longmen": ["河南嵩山龙门", "河南队", "Henan Songshan Longmen", "河南建业"],
    "changchun-yatai": ["长春亚泰", "亚泰", "Changchun Yatai"],
    "qingdao-west-coast": ["青岛西海岸", "西海岸", "Qingdao West Coast"],
    "qingdao-hainiu": ["青岛海牛", "海牛", "Qingdao Hainiu"],
    "meizhou-hakka": ["梅州客家", "梅州", "Meizhou Hakka"],
    "dalian-yingbo": ["大连英博", "大连人", "Dalian Yingbo"],
    "shenzhen-xinpengcheng": ["深圳新鹏城", "深圳", "Shenzhen Xinpengcheng"],
    "chongqing-tonglianglong": ["重庆铜梁龙", "重庆", "Chongqing Tonglianglong"],
    "liaoning-tiening": ["辽宁铁人", "辽宁", "Liaoning Tiening"],
    "yunnan-yukun": ["云南玉昆", "云南", "Yunnan Yukun"],
  };

  // 生成反向 alias 索引：显示名/别名 → 稳定 key
  const ALIAS_INDEX = {};
  for (const [key, aliases] of Object.entries(TEAM_ALIASES)) {
    ALIAS_INDEX[key.toLowerCase()] = key;
    for (const a of aliases) ALIAS_INDEX[a.toLowerCase()] = key;
  }

  /**
   * 归一化任意球队标识 → 稳定 asset key（跨联赛的 key 是唯一的，
   * 因为英超/西甲/法甲/中超的 slug 命名互不冲突）。
   * @param {string} teamId - 可以是稳定 key、中文名、英文名、别名
   */
  function resolveTeamKey(teamId) {
    if (!teamId) return null;
    const v = String(teamId).trim();
    if (!v) return null;
    return ALIAS_INDEX[v.toLowerCase()] || v.toLowerCase();
  }

  /**
   * 获取球队 Logo 路径。
   * @param {string} leagueId - 联赛稳定 ID（premier_league / la_liga / ligue_1 / chinese_super_league）
   * @param {string} teamId   - 球队稳定 key / 任意别名
   * @returns {string} logo 相对路径；找不到 → 占位图
   */
  function getTeamLogo(leagueId, teamId) {
    const league = MANIFEST.team_logos[leagueId];
    if (!league) return PLACEHOLDER;
    const key = resolveTeamKey(teamId);
    if (!key) return PLACEHOLDER;
    return league[key] || PLACEHOLDER;
  }

  /**
   * 获取联赛 Logo 路径。
   * @param {string} leagueId - premier_league / la_liga / ligue_1 / chinese_super_league
   * @returns {string} logo 相对路径；找不到 → null（调用方回退联赛名）
   */
  function getLeagueLogo(leagueId) {
    return MANIFEST.league_logos[leagueId] || null;
  }

  /** 所有已收录球队 key（按联赛分组），用于主队选择/全部列表 */
  function getAllTeams() {
    return MANIFEST.team_logos;
  }

  return {
    getTeamLogo,
    getLeagueLogo,
    getAllTeams,
    resolveTeamKey,
    PLACEHOLDER,
    MANIFEST,
  };
});
