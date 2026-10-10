const { gatewayOrigin } = require("../config.js");

function buildUrl(path, query) {
  // 小程序逻辑层不保证提供 URL / URLSearchParams，使用 JS 字符串拼接。
  const joined = /^https?:\/\//i.test(path)
    ? path
    : gatewayOrigin.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  // 保留路径里已有的百分号编码，同时编码空格与非 ASCII 字符。
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
  // 沿用 URLSearchParams 的表单编码口径：空格为 +，字面 + 为 %2B。
  return encodeURIComponent(value)
    .replace(/[!'()~]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

/**
 * wx.request 的 401/422/409/429 走 success，不能把 success 当 2xx。
 * 返回完整 envelope：{ data, request_id }，并附带 statusCode / code / message。
 */
function request({ method, path, data, query }) {
  return new Promise((resolve) => {
    wx.request({
      url: buildUrl(path, query),
      method,
      data: method === "POST" ? data : undefined,
      header: method === "POST" ? { "content-type": "application/json" } : {},
      success(res) {
        const body = res.data && typeof res.data === "object" ? res.data : {};
        resolve({
          data: body.data,
          request_id: body.request_id,
          statusCode: res.statusCode,
          code: body.code,
          message: body.message,
          details: body.details,
        });
      },
      fail() {
        resolve({
          data: undefined,
          request_id: undefined,
          statusCode: 0,
          code: undefined,
          message: undefined,
          details: undefined,
        });
      },
    });
  });
}

module.exports = {
  request,
};
