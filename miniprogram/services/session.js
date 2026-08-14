const { request } = require("./api.js");

function initSession(nickname) {
  return request({
    method: "POST",
    path: "/v1/session/init",
    data: { nickname },
  });
}

module.exports = {
  initSession,
};
