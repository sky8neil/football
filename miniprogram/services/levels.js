const { request } = require("./api.js");

function getMyLevels() {
  return request({
    method: "GET",
    path: "/v1/levels/me",
  });
}

module.exports = {
  getMyLevels,
};
