const { gatewayOrigin } = require("../config.js");

function buildUrl(path, query) {
  const url = new URL(path, gatewayOrigin);
  if (query && typeof query === "object") {
    Object.keys(query).forEach((key) => {
      const value = query[key];
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });
  }
  return url.toString();
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
        });
      },
      fail() {
        resolve({
          data: undefined,
          request_id: undefined,
          statusCode: 0,
          code: undefined,
          message: undefined,
        });
      },
    });
  });
}

module.exports = {
  request,
};
