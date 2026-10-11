const { request } = require("./api.js");

function getMyProfile() {
  return request({
    method: "GET",
    path: "/v1/profile/me",
  });
}

function updateMyProfile(data) {
  // wx.request does not support PATCH; the gateway exposes an authenticated POST alias.
  return request({ method: "POST", path: "/v1/profile/me", data });
}

module.exports = {
  updateMyProfile,
  getMyProfile,
};
