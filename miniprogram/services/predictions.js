const { request } = require("./api.js");

/**
 * UUID v4 for prediction idempotency_key.
 *
 * 熵源优先级（同步方案，开发文档 §5.4）：
 *   1. globalThis.crypto.randomUUID（同步 Web Crypto，优先）
 *   2. globalThis.crypto.getRandomValues（同步就地填充 Uint8Array）
 *   3. 同步混合熵兜底（Date.now + performance.now + 递增 counter + Math.random）
 *
 * 注意：微信 wx.getRandomValues 是异步 Object 参数形态（success/fail 回调），
 * 不是同步 Web Crypto TypedArray API，绝不能当 crypto.getRandomValues 用。
 * 本实现不调用任何异步 wx API，也不虚构 wx.getRandomValuesSync。
 */
function createUuidV4() {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    fillMixedEntropy(bytes);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

let mixedEntropyCounter = 0;

/**
 * 同步混合熵兜底：不调用任何异步 wx API。
 * 仅用于 idempotency_key（非密码学密钥材料），碰撞足够低即可。
 */
function fillMixedEntropy(bytes) {
  mixedEntropyCounter = (mixedEntropyCounter + 1) >>> 0;
  const timeSeed = Date.now();
  const perfSeed =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? Math.floor(performance.now() * 1000)
      : 0;
  const mixer = (timeSeed ^ perfSeed ^ mixedEntropyCounter) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const randomByte = Math.floor(Math.random() * 256);
    bytes[i] = (randomByte ^ ((mixer >>> ((i % 4) * 8)) & 0xff)) & 0xff;
  }
}

function submitPrediction({ idempotencyKey, matchId, homeScore, awayScore }) {
  return request({
    method: "POST",
    path: "/v1/predictions",
    data: {
      idempotency_key: idempotencyKey,
      match_id: matchId,
      home_score: homeScore,
      away_score: awayScore,
    },
  });
}

function listMyPredictions({ limit, cursor } = {}) {
  const query = {};
  if (limit !== undefined && limit !== null) {
    query.limit = limit;
  }
  if (cursor !== undefined && cursor !== null) {
    query.cursor = cursor;
  }
  return request({
    method: "GET",
    path: "/v1/predictions/me",
    query,
  });
}

module.exports = {
  createUuidV4,
  submitPrediction,
  listMyPredictions,
};
