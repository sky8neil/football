const cloud = require("wx-server-sdk");
const { createCloudFunctionRuntime } = require("./dist/cloud-function/runtime.js");
const { builtAt } = require("./dist/build-info.json");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const runtime = createCloudFunctionRuntime({
  env: process.env,
  db: cloud.database(),
  sdkVersion: require("wx-server-sdk/package.json").version,
  nodeVersion: process.version,
  buildTime: builtAt,
});

exports.main = async (event) => runtime(event || {}, cloud.getWXContext());
