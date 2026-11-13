const { request } = require("./api.js");
const { ensureAuth } = require("./auth.js");

function initSession(nickname) {
  return ensureAuth().then((authResult) => {
    if (authResult.statusCode !== 200) return authResult;
    return request({
      method: "POST",
      path: "/v1/session/init",
      data: { nickname },
    });
  });
}

module.exports = {
  initSession,
};
