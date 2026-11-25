import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function loadProfileService(requestImpl = vi.fn(async () => ({ statusCode: 200 }))) {
  const module = { exports: {} };
  runInNewContext(readFileSync(new URL("./profile.js", import.meta.url), "utf8"), {
    module,
    exports: module.exports,
    require: (id) => {
      if (id === "./api.js") return { request: requestImpl };
      throw new Error("Unexpected require: " + id);
    },
  });
  return { service: module.exports, requestImpl };
}

describe("miniprogram profile service", () => {
  it("requests public profile with optional auth and URL-encoded userId", async () => {
    const { service, requestImpl } = loadProfileService();
    await service.getPublicProfile("user/1?x=2");
    expect(requestImpl).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/profiles/user%2F1%3Fx%3D2",
      auth: "optional",
    });
  });

  it("requests DELETE /v1/profile/me for deleteMyProfile", async () => {
    const { service, requestImpl } = loadProfileService();
    await service.deleteMyProfile();
    expect(requestImpl).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/v1/profile/me",
    });
  });

  it("keeps getMyProfile and updateMyProfile contracts intact", async () => {
    const { service, requestImpl } = loadProfileService();
    await service.getMyProfile();
    await service.updateMyProfile({ nickname: "Sky" });
    expect(requestImpl).toHaveBeenNthCalledWith(1, { method: "GET", path: "/v1/profile/me" });
    expect(requestImpl).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1/profile/me",
      data: { nickname: "Sky" },
    });
  });
});
