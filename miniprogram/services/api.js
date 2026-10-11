const config = require("../config.js");
const { classifyCloudClientError } = require("./cloud-diagnostics.js");

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

function accountVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion;
  } catch (_error) {
    return "develop";
  }
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

function request({ method, path, data, query }) {
  const transport = config.transport || "http";
  const envVersion = accountVersion();
  if ((envVersion === "trial" || envVersion === "release") && transport !== "cloud") {
    throw new Error(`${envVersion} mini program must use cloud transport`);
  }
  if (transport === "cloud") {
    if (!config.cloudEnvId) throw new Error("cloudEnvId is required when transport is cloud");
    if (!config.cloudFunctionName) throw new Error("cloudFunctionName is required when transport is cloud");
    if (!wx.cloud || typeof wx.cloud.callFunction !== "function") throw new Error("wx.cloud.callFunction is unavailable");
  }
  assertNoClientIdentity({ data, query });
  return new Promise((resolve) => {
    if (transport === "cloud") {
      wx.cloud.callFunction({
        name: config.cloudFunctionName,
        data: { method, path, query, body: data },
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
      data: ["POST", "PATCH", "PUT"].includes(method) ? data : undefined,
      header: ["POST", "PATCH", "PUT"].includes(method) ? { "content-type": "application/json" } : {},
      success(res) {
        const body = res.data && typeof res.data === "object" ? res.data : {};
        resolve({ data: body.data, request_id: body.request_id, statusCode: res.statusCode, code: body.code, message: body.message, details: body.details });
      },
      fail() { resolve(failResult()); },
    });
  });
}

module.exports = { request };
