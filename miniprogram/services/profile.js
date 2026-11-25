const { request } = require("./api.js");

function getMyProfile() {
  return request({
    method: "GET",
    path: "/v1/profile/me",
  });
}

function getPublicProfile(userId) {
  return request({
    method: "GET",
    path: `/v1/profiles/${encodeURIComponent(String(userId || ""))}`,
    auth: "optional",
  });
}

function updateMyProfile(data) {
  // wx.request does not support PATCH; the gateway exposes an authenticated POST alias.
  return request({ method: "POST", path: "/v1/profile/me", data });
}

function deleteMyProfile() {
  return request({
    method: "DELETE",
    path: "/v1/profile/me",
  });
}

module.exports = {
  updateMyProfile,
  getMyProfile,
  getPublicProfile,
  deleteMyProfile,
};
