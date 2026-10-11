function classifyCloudClientError(error) {
  const message = String((error && (error.errMsg || error.message)) || error || "").toLowerCase();
  if (message.includes("cloud.init")) return ["DIAG_CLIENT_CLOUD_NOT_INIT", "小程序启动时没有初始化云开发，请检查 app.js"];
  if (message.includes("touristappid") || message.includes("cloud capability")) return ["DIAG_CLIENT_TOURIST_APPID", "游客 AppID 不能使用云开发，请在开发者工具中选择真实 AppID"];
  if (message.includes("environment") || message.includes("env ")) return ["DIAG_CLIENT_ENV_INVALID", "云环境 ID 无效或不属于当前 AppID，请核对 config.js"];
  if (message.includes("function not found") || message.includes("function does not exist") || message.includes("云函数不存在")) return ["DIAG_CLIENT_FUNCTION_NOT_FOUND", "云函数 api 尚未部署到当前环境"];
  if (message.includes("timeout") || message.includes("超时")) return ["DIAG_CLIENT_TIMEOUT", "云函数响应超时，请检查函数超时设置和冷启动"];
  if (message.includes("base library") || message.includes("基础库")) return ["DIAG_CLIENT_LIB_VERSION", "请在开发者工具中调高调试基础库版本"];
  if (message.includes("network") || message.includes("网络") || !error || error.errCode === undefined) return ["DIAG_CLIENT_NETWORK", "网络不可用，请检查开发者工具网络连接"];
  return ["DIAG_UNKNOWN", "云函数调用失败，请检查开发者工具和云函数日志"];
}

module.exports = { classifyCloudClientError };
