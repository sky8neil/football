const config = require("../config.js");
const { classifyCloudClientError } = require("./cloud-diagnostics.js");

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

function buildHttpHeaders(method, path) {
  const header = {};
  if (WRITE_METHODS.includes(method)) {
    header["content-type"] = "application/json";
  }
  if (!isAuthLoginRequest(path)) {
    const token = resolveAccessToken();
    if (token) header.Authorization = "Bearer " + token;
  }
  return header;
}

function failResult() {
  return { data: undefined, request_id: undefined, statusCode: 0, code: undefined, message: undefined, details: undefined };
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

function dispatchRequest({ method, path, data, query, transport, envVersion }) {
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
      header: buildHttpHeaders(method, path),
      success(res) {
        const body = res.data && typeof res.data === "object" ? res.data : {};
        resolve({ data: body.data, request_id: body.request_id, statusCode: res.statusCode, code: body.code, message: body.message, details: body.details });
      },
      fail() { resolve(failResult()); },
    });
  });
}

function request({ method, path, data, query }) {
  const transport = config.transport || "http";
  const envVersion = accountVersion();
  assertTrialReleaseTransport(envVersion, transport);
  if (transport === "cloud") {
    if (!config.cloudEnvId) throw new Error("cloudEnvId is required when transport is cloud");
    if (!config.cloudFunctionName) throw new Error("cloudFunctionName is required when transport is cloud");
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") throw new Error("wx.cloud.callFunction is unavailable");
  }
  assertNoClientIdentity({ data, query });
  const dispatch = () => dispatchRequest({ method, path, data, query, transport, envVersion });
  if (transport === "cloud" || isAuthLoginRequest(path) || typeof authPreparer !== "function") {
    return dispatch();
  }
  return Promise.resolve(authPreparer()).then((authResult) => {
    if (authResult && authResult.statusCode !== 200) return authResult;
    return dispatch();
  });
}

module.exports = { request, setAccessTokenProvider, setAuthPreparer };
