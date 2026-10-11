import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const moduleContext = { module: { exports: {} } };
runInNewContext(readFileSync(join(HERE, "cloud-diagnostics.js"), "utf8"), moduleContext);
const { classifyCloudClientError } = moduleContext.module.exports;

describe("cloud client error classification", () => {
  it.each([
    [{ errMsg: "please call wx.cloud.init first" }, "DIAG_CLIENT_CLOUD_NOT_INIT"],
    [{ errMsg: "touristappid does not support cloud capability" }, "DIAG_CLIENT_TOURIST_APPID"],
    [{ errMsg: "invalid cloud environment id" }, "DIAG_CLIENT_ENV_INVALID"],
    [{ errMsg: "cloud function not found" }, "DIAG_CLIENT_FUNCTION_NOT_FOUND"],
    [{ errMsg: "request timeout" }, "DIAG_CLIENT_TIMEOUT"],
    [{ errMsg: "base library version too low" }, "DIAG_CLIENT_LIB_VERSION"],
    [{ errMsg: "network error" }, "DIAG_CLIENT_NETWORK"],
    [{ errCode: -1, errMsg: "unrecognized platform failure" }, "DIAG_UNKNOWN"],
  ])("classifies %s as %s", (error, diagCode) => {
    expect(classifyCloudClientError(error)[0]).toBe(diagCode);
  });
});
