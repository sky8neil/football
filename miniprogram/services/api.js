const config = require("../config.js");
const { classifyCloudClientError } = require("./cloud-diagnostics.js");
const { isAuthSessionActive, readAuthSession } = require("../utils/auth-storage.js");

const AUTH_LOGIN_PATH = "/v1/auth/wechat";
const WRITE_METHODS = ["POST", "PATCH", "PUT"];

let accessTokenProvider = null;
let authPreparer = null;

function setAccessTokenProvider(provider) {
  accessTokenProvider = typeof provider === "function" ? provider : null;
}

function setAuthPreparer(provider) {
  authPreparer = typeof provider === "function" ? provider : null;
}

function buildUrl(path, query) {
  const joined = /^https?:\/\//i.test(path)
    ? path
    : config.gatewayOrigin.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  const encoded = encodeURI(joined).replace(/%25([0-9a-f]{2})/gi, "%$1");
  const hashIndex = encoded.indexOf("#");
  const fragment = hashIndex === -1 ? "" : encoded.slice(hashIndex);
  let url = hashIndex === -1 ? encoded : encoded.slice(0, hashIndex);
  const params = [];
  if (query && typeof query === "object") {
    Object.keys(query).forEach((key) => {
      const value = query[key];
      if (value !== undefined && value !== null) {
        params.push(encodeQueryComponent(key) + "=" + encodeQueryComponent(String(value)));
      }
    });
  }
  if (params.length) {
    const separator = url.indexOf("?") === -1 ? "?" : /[?&]$/.test(url) ? "" : "&";
    url += separator + params.join("&");
  }
  return url + fragment;
}

function encodeQueryComponent(value) {
  return encodeURIComponent(value)
    .replace(/[!'()~]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

function assertNoClientIdentity(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(assertNoClientIdentity);
    return;
  }
  Object.keys(value).forEach((key) => {
    if (["openid", "user_id", "token"].includes(key.toLowerCase())) {
      throw new Error(`Client supplied identity field is forbidden: ${key}`);
    }
    assertNoClientIdentity(value[key]);
  });
}

function normalizeCloudQuery(query) {
  if (!query || typeof query !== "object") return query;
  const normalized = {};
  Object.keys(query).forEach((key) => {
    const value = query[key];
    if (value !== undefined && value !== null) normalized[key] = String(value);
  });
  return normalized;
}

function accountVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion;
  } catch (_error) {
    return "develop";
  }
}

function requestPathname(path) {
  const withoutHash = String(path || "").split("#")[0];
  const withoutQuery = withoutHash.split("?")[0];
  const withSlash = withoutQuery.charAt(0) === "/" ? withoutQuery : "/" + withoutQuery;
  return withSlash.replace(/\/+$/, "") || "/";
}

function isAuthLoginRequest(path) {
  return requestPathname(path) === AUTH_LOGIN_PATH;
}

function isIpv4Hostname(hostname) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

function isValidHttpsDomainOrigin(origin) {
  if (typeof origin !== "string") return false;
  const match = /^https:\/\/([^/:?#]+)\/?$/i.exec(origin.trim());
  if (!match) return false;
  const hostname = match[1].toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (isIpv4Hostname(hostname) || hostname.indexOf(".") === -1) return false;
  if (hostname.charAt(0) === "." || hostname.charAt(hostname.length - 1) === ".") return false;
  return hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function assertTrialReleaseTransport(envVersion, transport) {
  if (envVersion !== "trial" && envVersion !== "release") return;
  if (transport === "cloud") return;
  if (transport === "http" && isValidHttpsDomainOrigin(config.gatewayOrigin)) return;
  if (transport === "http") {
    throw new Error(`${envVersion} mini program HTTP transport requires a valid https:// domain`);
  }
  throw new Error(`${envVersion} mini program must use cloud transport`);
}

function resolveAccessToken() {
  if (typeof accessTokenProvider !== "function") return undefined;
  const token = accessTokenProvider();
  if (typeof token !== "string") return undefined;
  const trimmed = token.trim();
  return trimmed || undefined;
}

function resolveOptionalAccessToken() {
  const session = readAuthSession();
  if (!isAuthSessionActive(session, new Date())) return undefined;
  return session.access_token;
}

function buildHttpHeaders(method, path, authMode) {
  const header = {};
  if (WRITE_METHODS.includes(method)) {
    header["content-type"] = "application/json";
  }
  const token = resolveRequestToken(path, authMode);
  if (token) header.Authorization = "Bearer " + token;
  return header;
}

function failResult() {
  return { data: undefined, request_id: undefined, statusCode: 0, code: "NETWORK_ERROR", message: "网络异常", details: undefined };
}

function fromGatewayResponse(response, cloudTransport) {
  const gateway = response && response.result && typeof response.result.status === "number"
    ? response.result
    : response;
  const body = gateway && gateway.body && typeof gateway.body === "object" ? gateway.body : {};
  const requestId = body.request_id;
  let message = body.message;
  if (cloudTransport && gateway && gateway.status >= 400 && requestId) {
    message = `${message || "出错了，请稍后重试"} · 编号 ${String(requestId).slice(-4)}`;
  }
  return {
    data: body.data,
    request_id: requestId,
    statusCode: gateway && gateway.status,
    code: body.code,
    message,
    details: body.details,
  };
}

function resolveRequestToken(path, authMode) {
  if (isAuthLoginRequest(path)) return undefined;
  return authMode === "optional" ? resolveOptionalAccessToken() : resolveAccessToken();
}

function resolveLoginGeneration() {
  const auth = require("./auth.js");
  if (typeof auth.getLoginGeneration !== "function") return undefined;
  const value = auth.getLoginGeneration();
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

let unauthorizedRecovery;

function beginSessionRecovery(sentToken, fallbackResult) {
  const auth = require("./auth.js");
  if (typeof auth.recoverSession === "function") {
    return auth.recoverSession(sentToken);
  }
  if (typeof auth.clearAuth === "function") auth.clearAuth();
  if (typeof auth.ensureAuth !== "function") return fallbackResult;
  return auth.ensureAuth();
}

function recoverUnauthorized(result, context) {
  if (
    context.transport !== "http"
    || context.retried
    || isAuthLoginRequest(context.path)
    || !context.hadAuthorization
    || !result
    || result.statusCode !== 401
    || result.code !== "UNAUTHORIZED"
  ) {
    return Promise.resolve(result);
  }
  if (typeof context.loginGeneration === "number") {
    const currentGeneration = resolveLoginGeneration();
    if (typeof currentGeneration === "number" && currentGeneration !== context.loginGeneration) {
      return Promise.resolve(result);
    }
  }
  const currentToken = resolveRequestToken(context.path, context.authMode);
  if (context.sentToken && currentToken && currentToken !== context.sentToken) {
    return send(context, true);
  }
  const generation = context.loginGeneration;
  if (!unauthorizedRecovery || unauthorizedRecovery.generation !== generation) {
    const started = {
      generation,
      promise: Promise.resolve(beginSessionRecovery(context.sentToken, result)).finally(() => {
        if (unauthorizedRecovery === started) unauthorizedRecovery = undefined;
      }),
    };
    unauthorizedRecovery = started;
  }
  return unauthorizedRecovery.promise.then((authResult) => {
    if (typeof context.loginGeneration === "number") {
      const currentGeneration = resolveLoginGeneration();
      if (typeof currentGeneration === "number" && currentGeneration !== context.loginGeneration) {
        return result;
      }
    }
    if (authResult && authResult.statusCode !== 200) return authResult;
    return send(context, true);
  });
}

function send({ method, path, data, query, transport, envVersion, authMode }, retried) {
  const sentToken = transport === "http" ? resolveRequestToken(path, authMode) : undefined;
  const hadAuthorization = Boolean(sentToken);
  const loginGeneration = transport === "http" ? resolveLoginGeneration() : undefined;
  return dispatchRequest({ method, path, data, query, transport, envVersion, authMode }).then((result) => (
    recoverUnauthorized(result, { method, path, data, query, transport, envVersion, authMode, retried, hadAuthorization, sentToken, loginGeneration })
  ));
}

function dispatchRequest({ method, path, data, query, transport, envVersion, authMode }) {
  return new Promise((resolve) => {
    if (transport === "cloud") {
      wx.cloud.callFunction({
        name: config.cloudFunctionName,
        // HTTP query parameters always arrive as strings. Preserve that contract
        // when the cloud transport passes query data directly to the function.
        data: { method, path, query: normalizeCloudQuery(query), body: data },
        success(res) { resolve(fromGatewayResponse(res.result, true)); },
        fail(error) {
          if (envVersion === "develop" || envVersion === "trial") {
            const [diagCode, hint] = classifyCloudClientError(error);
            console.warn("[diag]", { diag_code: diagCode, hint, errCode: error && error.errCode, errMsg: error && error.errMsg });
          }
          resolve(failResult());
        },
      });
      return;
    }
    wx.request({
      url: buildUrl(path, query),
      method,
      data: WRITE_METHODS.includes(method) ? data : undefined,
      header: buildHttpHeaders(method, path, authMode),
      success(res) {
        const body = res.data && typeof res.data === "object" ? res.data : {};
        resolve({ data: body.data, request_id: body.request_id, statusCode: res.statusCode, code: body.code, message: body.message, details: body.details });
      },
      fail() { resolve(failResult()); },
    });
  });
}

function request({ method, path, data, query, auth }) {
  const authMode = auth === "optional" ? "optional" : "required";
  const transport = config.transport || "http";
  const envVersion = accountVersion();
  assertTrialReleaseTransport(envVersion, transport);
  if (transport === "cloud") {
    if (!config.cloudEnvId) throw new Error("cloudEnvId is required when transport is cloud");
    if (!config.cloudFunctionName) throw new Error("cloudFunctionName is required when transport is cloud");
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") throw new Error("wx.cloud.callFunction is unavailable");
  }
  assertNoClientIdentity({ data, query });
  const dispatch = (retried) => send({ method, path, data, query, transport, envVersion, authMode }, retried);
  if (transport === "cloud" || isAuthLoginRequest(path) || typeof authPreparer !== "function") {
    return dispatch(false);
  }
  // auth "optional": public GETs that the server allows anonymously.
  // Skip authPreparer so an expired auth_session cannot trigger wx.login and
  // either block the request (previous bug) or delay the anonymous fallback.
  // Live sessions still send Bearer from storage in buildHttpHeaders; expired
  // or missing sessions go out with no Authorization.
  if (authMode === "optional") return dispatch(false);
  return Promise.resolve(authPreparer()).then((authResult) => {
    if (authResult && authResult.statusCode !== 200) return authResult;
    return dispatch(false);
  });
}

module.exports = { request, setAccessTokenProvider, setAuthPreparer };
