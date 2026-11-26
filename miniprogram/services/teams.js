const { request } = require("./api.js");

const ACTIVE_TEAMS_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedActiveTeams = null;
let inflightTeamsPromise = null;
const cachedTeamsById = new Map();
const inflightTeamByIdPromises = new Map();

function listTeams({ leagueId } = {}) {
  const options = {
    method: "GET",
    path: "/v1/teams",
    auth: "optional",
  };
  if (leagueId) options.query = { league_id: leagueId };
  return request(options);
}

function getTeamById(teamId) {
  return request({
    method: "GET",
    path: "/v1/teams/" + encodeURIComponent(teamId),
    auth: "optional",
  });
}

function clearTeamsCache() {
  cachedActiveTeams = null;
  inflightTeamsPromise = null;
  cachedTeamsById.clear();
  inflightTeamByIdPromises.clear();
}

function getFreshMemoryTeam(teamId) {
  if (!teamId || typeof teamId !== "string") return null;
  const normalizedId = teamId.trim();
  if (!normalizedId) return null;
  const now = Date.now();
  if (cachedActiveTeams && now < cachedActiveTeams.expiresAt) {
    const activeHit = cachedActiveTeams.byId.get(normalizedId);
    if (activeHit) return activeHit;
  }
  const detailEntry = cachedTeamsById.get(normalizedId);
  if (detailEntry) {
    if (now < detailEntry.expiresAt) return detailEntry.team;
    cachedTeamsById.delete(normalizedId);
  }
  return null;
}

/**
 * Fetches a single team record (active or inactive) by team_id from GET /v1/teams/{team_id}
 * with short-lived in-memory caching and in-flight deduplication.
 */
function fetchTeamByIdCached(teamId, { forceRefresh = false } = {}) {
  if (!teamId || typeof teamId !== "string") return Promise.resolve(null);
  const normalizedId = teamId.trim();
  if (!normalizedId) return Promise.resolve(null);
  const now = Date.now();
  if (!forceRefresh) {
    const cached = cachedTeamsById.get(normalizedId);
    if (cached && now < cached.expiresAt) {
      return Promise.resolve(cached.team);
    }
    if (inflightTeamByIdPromises.has(normalizedId)) {
      return inflightTeamByIdPromises.get(normalizedId);
    }
  }
  const promise = Promise.resolve()
    .then(() => getTeamById(normalizedId))
    .then((result) => {
      if (!result || result.statusCode !== 200 || !result.data || !result.data.team_id) {
        return null;
      }
      const team = result.data;
      cachedTeamsById.set(normalizedId, {
        team,
        expiresAt: Date.now() + ACTIVE_TEAMS_CACHE_TTL_MS,
      });
      return team;
    })
    .catch(() => null)
    .finally(() => {
      if (inflightTeamByIdPromises.get(normalizedId) === promise) {
        inflightTeamByIdPromises.delete(normalizedId);
      }
    });
  inflightTeamByIdPromises.set(normalizedId, promise);
  return promise;
}

/**
 * Fetches active teams from GET /v1/teams with short-lived in-memory caching and in-flight deduplication.
 * Failed or non-200 responses are not cached so subsequent lookups can recover.
 */
function fetchActiveTeamsCached({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedActiveTeams && now < cachedActiveTeams.expiresAt) {
    return Promise.resolve(cachedActiveTeams.items);
  }
  if (!forceRefresh && inflightTeamsPromise) {
    return inflightTeamsPromise;
  }
  const promise = Promise.resolve()
    .then(() => listTeams())
    .then((result) => {
      if (!result || result.statusCode !== 200 || !result.data || !Array.isArray(result.data.items)) {
        return null;
      }
      const items = result.data.items.filter(
        (item) => item && item.team_id && (!item.status || item.status === "active"),
      );
      const byId = new Map();
      for (const item of items) {
        byId.set(item.team_id, item);
      }
      cachedActiveTeams = {
        items,
        byId,
        expiresAt: Date.now() + ACTIVE_TEAMS_CACHE_TTL_MS,
      };
      return items;
    })
    .catch(() => null)
    .finally(() => {
      if (inflightTeamsPromise === promise) {
        inflightTeamsPromise = null;
      }
    });
  inflightTeamsPromise = promise;
  return promise;
}

/**
 * Resolves an active server team record by team_id via the cached /v1/teams directory.
 */
async function resolveTeamById(teamId) {
  if (!teamId || typeof teamId !== "string") return null;
  const normalizedId = teamId.trim();
  if (!normalizedId) return null;
  if (cachedActiveTeams && Date.now() < cachedActiveTeams.expiresAt) {
    const cachedHit = cachedActiveTeams.byId.get(normalizedId);
    if (cachedHit) return cachedHit;
  }
  const items = await fetchActiveTeamsCached();
  if (!Array.isArray(items)) return null;
  if (cachedActiveTeams && cachedActiveTeams.byId.has(normalizedId)) {
    return cachedActiveTeams.byId.get(normalizedId);
  }
  return items.find((item) => item && item.team_id === normalizedId) || null;
}

function readStorage(key) {
  if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") return "";
  try {
    return wx.getStorageSync(key) || "";
  } catch (_error) {
    return "";
  }
}

function writeStorage(key, value) {
  if (typeof wx === "undefined" || typeof wx.setStorageSync !== "function") return;
  try {
    wx.setStorageSync(key, value);
  } catch (_error) {
    /* ignore storage write errors */
  }
}

function isPlaceholderLogo(logo, placeholder) {
  if (typeof logo !== "string") return true;
  const trimmed = logo.trim();
  return (
    !trimmed ||
    (Boolean(placeholder) && trimmed === placeholder) ||
    trimmed.endsWith("/team-placeholder.png") ||
    trimmed === "placeholder.png"
  );
}

function formatServerTeam(serverTeam, { presentTeam, placeholder = "" } = {}) {
  const presented = typeof presentTeam === "function"
    ? presentTeam(serverTeam, serverTeam.league_id)
    : null;
  const presentedName = presented && presented.nameZh && presented.nameZh !== "球队资料待补全"
    ? presented.nameZh
    : "";
  const resolvedName = presentedName || serverTeam.name_zh || serverTeam.name || "";
  const rawLogo = (presented && presented.logo) || "";
  const hasRealLogo = !isPlaceholderLogo(rawLogo, placeholder);
  return {
    resolvedName,
    rawLogo,
    hasRealLogo,
  };
}

/**
 * Synchronously resolves favorite team display fields from static TEAM_REGISTRY, fresh in-memory cache,
 * or local wx storage (for immediate first-paint display while flagging stale out-of-bundle teams for remote refresh).
 */
function resolveFavoriteTeamSync(favoriteTeamId, { findTeam, presentTeam, placeholder = "" } = {}) {
  if (!favoriteTeamId) {
    return {
      favoriteTeamId: null,
      favoriteTeamText: "未设置",
      favoriteTeamLogo: placeholder,
      hasFavoriteTeam: false,
      needsRemoteLookup: false,
    };
  }
  const registered = typeof findTeam === "function" ? findTeam(favoriteTeamId) : null;
  if (registered) {
    const presented = typeof presentTeam === "function"
      ? presentTeam(
        {
          team_id: favoriteTeamId,
          name: registered.source_name,
          name_zh: registered.name_zh,
          league_id: registered.league_id,
        },
        registered.league_id,
      )
      : null;
    return {
      favoriteTeamId,
      favoriteTeamText: (presented && presented.nameZh) || registered.name_zh || registered.source_name || "已选择球队",
      favoriteTeamLogo: (presented && presented.logo) || placeholder,
      hasFavoriteTeam: true,
      needsRemoteLookup: false,
    };
  }
  const cachedName = readStorage("team_name:" + favoriteTeamId);
  const cachedLogo = readStorage("team_logo:" + favoriteTeamId);
  const validCachedLogo = !isPlaceholderLogo(cachedLogo, placeholder) ? cachedLogo : "";
  const memoryTeam = getFreshMemoryTeam(favoriteTeamId);
  if (memoryTeam) {
    const formatted = formatServerTeam(memoryTeam, { presentTeam, placeholder });
    return {
      favoriteTeamId,
      favoriteTeamText: formatted.resolvedName || cachedName || "已选择球队",
      favoriteTeamLogo: (formatted.hasRealLogo ? formatted.rawLogo : validCachedLogo) || placeholder,
      hasFavoriteTeam: true,
      needsRemoteLookup: false,
    };
  }
  return {
    favoriteTeamId,
    favoriteTeamText: cachedName || "已选择球队",
    favoriteTeamLogo: validCachedLogo || placeholder,
    hasFavoriteTeam: true,
    needsRemoteLookup: true,
  };
}

/**
 * Resolves an out-of-bundle favorite team via GET /v1/teams (active directory) with fallback to
 * GET /v1/teams/{team_id} (for inactive selected teams), formats it via presentTeam, and caches it locally.
 */
async function resolveFavoriteTeamRemote(favoriteTeamId, { presentTeam, placeholder = "" } = {}) {
  if (!favoriteTeamId || typeof favoriteTeamId !== "string") return null;
  const normalizedId = favoriteTeamId.trim();
  if (!normalizedId) return null;
  let serverTeam = getFreshMemoryTeam(normalizedId);
  if (!serverTeam) {
    const activeItems = await fetchActiveTeamsCached();
    if (Array.isArray(activeItems)) {
      if (cachedActiveTeams && cachedActiveTeams.byId.has(normalizedId)) {
        serverTeam = cachedActiveTeams.byId.get(normalizedId);
      } else {
        serverTeam = activeItems.find((item) => item && item.team_id === normalizedId) || null;
      }
      if (!serverTeam) {
        serverTeam = await fetchTeamByIdCached(normalizedId);
      }
    }
  }
  if (!serverTeam) return null;
  const { resolvedName, rawLogo, hasRealLogo } = formatServerTeam(serverTeam, { presentTeam, placeholder });
  if (resolvedName) writeStorage("team_name:" + normalizedId, resolvedName);
  if (hasRealLogo) writeStorage("team_logo:" + normalizedId, rawLogo);
  return {
    favoriteTeamId: normalizedId,
    favoriteTeamText: resolvedName,
    favoriteTeamLogo: hasRealLogo ? rawLogo : placeholder,
  };
}

module.exports = {
  listTeams,
  getTeamById,
  fetchActiveTeamsCached,
  fetchTeamByIdCached,
  resolveTeamById,
  clearTeamsCache,
  isPlaceholderLogo,
  resolveFavoriteTeamSync,
  resolveFavoriteTeamRemote,
};
