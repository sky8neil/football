const { request } = require("./api.js");
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function isValidInviteCode(value) {
  return typeof value === "string" && value.length === 8 &&
    [...value].every((character) => INVITE_CODE_ALPHABET.includes(character));
}

function listMyGroups({ limit, cursor } = {}) {
  const query = {};
  if (limit !== undefined && limit !== null) query.limit = limit;
  if (cursor !== undefined && cursor !== null) query.cursor = cursor;
  return request({ method: "GET", path: "/v1/groups/me", query });
}

function createGroup() {
  return request({ method: "POST", path: "/v1/groups", data: {} });
}

function joinGroup(inviteCode) {
  if (!isValidInviteCode(inviteCode)) {
    return Promise.resolve({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: "邀请码格式不正确",
    });
  }
  return request({ method: "POST", path: "/v1/groups/join", data: { invite_code: inviteCode } });
}

function leaveGroup(groupId) {
  return request({ method: "POST", path: `/v1/groups/${groupId}/leave` });
}

function dissolveGroup(groupId) {
  return request({ method: "DELETE", path: `/v1/groups/${groupId}` });
}

function getGroup(groupId) {
  return request({ method: "GET", path: `/v1/groups/${groupId}` });
}

module.exports = {
  listMyGroups,
  createGroup,
  joinGroup,
  leaveGroup,
  dissolveGroup,
  getGroup,
  isValidInviteCode,
};
