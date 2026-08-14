const { request } = require("./api.js");

function getMyProfile() {
  return request({
    method: "GET",
    path: "/v1/profile/me",
  });
}

module.exports = {
  getMyProfile,
};
