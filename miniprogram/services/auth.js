const config = require("../config.js");
const { request, setAccessTokenProvider, setAuthPreparer } = require("./api.js");
const {
  readAuthSession,
  writeAuthSession,
  clearAuthSession,
  isAuthSessionActive,
} = require("../utils/auth-storage.js");

const AUTH_LOGIN_PATH = "/v1/auth/wechat";

let accessToken;
let inflight;

setAccessTokenProvider(() => accessToken);
setAuthPreparer(() => restoreAuth());

function isHttpTransport() {
  return (config.transport || "http") === "http";
}

function skippedResult() {
  return { data: undefined, request_id: undefined, statusCode: 200, code: undefined, message: undefined, details: undefined };
}

function unauthorizedResult() {
  return { data: undefined, request_id: undefined, statusCode: 401, code: "UNAUTHORIZED", message: "需要重新登录", details: undefined };
}

function applySession(session, now) {
  if (!isAuthSessionActive(session, now)) {
    accessToken = undefined;
    return false;
  }
  accessToken = session.access_token;
  return true;
}

function clearAuth() {
  accessToken = undefined;
  inflight = undefined;
  clearAuthSession();
}

function wxLoginCode() {
  return new Promise((resolve) => {
    if (!wx.login || typeof wx.login !== "function") {
      resolve("");
      return;
    }
    wx.login({
      success(res) {
        const code = res && typeof res.code === "string" ? res.code.trim() : "";
        resolve(code);
      },
      fail() {
        resolve("");
      },
    });
  });
}

function persistLoginResult(result) {
  const payload = result && result.data && typeof result.data === "object" ? result.data : {};
  const session = {
    access_token: payload.access_token,
    expires_at: payload.expires_at,
  };
  if (result && result.statusCode === 200 && writeAuthSession(session) && applySession(session, new Date())) {
    return result;
  }
  accessToken = undefined;
  if (result && result.statusCode === 200) {
    clearAuthSession();
    return unauthorizedResult();
  }
  return result || unauthorizedResult();
}

function login() {
  return wxLoginCode().then((code) => {
    if (!code) return unauthorizedResult();
    return request({
      method: "POST",
      path: AUTH_LOGIN_PATH,
      data: { code },
    }).then(persistLoginResult);
  });
}

function startLogin() {
  if (inflight) return inflight;
  inflight = login().then(
    (result) => {
      inflight = undefined;
      return result;
    },
    (error) => {
      inflight = undefined;
      throw error;
    },
  );
  return inflight;
}

function cachedAuthResult(cached) {
  return {
    data: cached,
    request_id: undefined,
    statusCode: 200,
    code: undefined,
    message: undefined,
    details: undefined,
  };
}

function ensureAuth() {
  if (!isHttpTransport()) return Promise.resolve(skippedResult());
  if (inflight) return inflight;
  const now = new Date();
  const cached = readAuthSession();
  if (applySession(cached, now)) return Promise.resolve(cachedAuthResult(cached));
  accessToken = undefined;
  if (cached) clearAuthSession();
  return startLogin();
}

function restoreAuth() {
  if (!isHttpTransport()) return Promise.resolve(skippedResult());
  if (inflight) return inflight;
  const now = new Date();
  const cached = readAuthSession();
  if (applySession(cached, now)) return Promise.resolve(cachedAuthResult(cached));
  accessToken = undefined;
  if (!cached) return Promise.resolve(skippedResult());
  clearAuthSession();
  return startLogin();
}

module.exports = {
  ensureAuth,
  restoreAuth,
  clearAuth,
};
