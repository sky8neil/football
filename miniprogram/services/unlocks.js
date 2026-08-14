const { request } = require("./api.js");

function getMyUnlocks() {
  return request({
    method: "GET",
    path: "/v1/unlocks/me",
  });
}

module.exports = {
  getMyUnlocks,
};
