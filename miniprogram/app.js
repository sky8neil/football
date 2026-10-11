const config = require("./config.js");

App({
  onLaunch() {
    if (config.transport !== "cloud") return;
    if (!config.cloudEnvId) throw new Error("cloudEnvId is required when transport is cloud");
    if (!wx.cloud || typeof wx.cloud.init !== "function") {
      throw new Error("This WeChat base library does not support cloud development");
    }
    wx.cloud.init({ env: config.cloudEnvId, traceUser: true });
  },
});
