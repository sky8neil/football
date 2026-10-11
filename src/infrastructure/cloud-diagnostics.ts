export interface CloudDiagnostic {
  diag_code: string;
  layer: "client" | "cloud_function" | "database" | "configuration" | "unknown";
  hint: string;
  sdk_code: string | null;
  sdk_message: string;
}

function rawCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { errCode?: unknown; code?: unknown }).errCode ??
    (error as { code?: unknown }).code;
  return value === undefined || value === null ? null : String(value).slice(0, 100);
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = (error as { errMsg?: unknown; message?: unknown }).errMsg ??
      (error as { message?: unknown }).message;
    return String(value ?? "Unknown error");
  }
  return String(error ?? "Unknown error");
}

function redact(message: string): string {
  return message
    .replace(/(openid|unionid|secret|token|authorization)(["'\s:=]+)[^\s,;"']+/gi, "$1$2[redacted]")
    .replace(/wx[a-f0-9]{16,}/gi, "[redacted-openid]")
    .slice(0, 300);
}

export function classifyCloudError(error: unknown): CloudDiagnostic {
  const message = rawMessage(error);
  const lower = message.toLowerCase();
  let diag_code = "DIAG_UNKNOWN";
  let layer: CloudDiagnostic["layer"] = "unknown";
  let hint = "未知错误，查看原始错误码与文本并对照云函数日志";

  if ((lower.includes("football_") && lower.includes("required")) || lower.includes("required environment") || lower.includes("environment variable")) {
    diag_code = "DIAG_FN_ENV_VAR_MISSING"; layer = "configuration"; hint = "云函数缺少必填环境变量，请按 S17 §17.3 第8步补齐键名";
  } else if (lower.includes("mock identity") || lower.includes("prod") && lower.includes("mock")) {
    diag_code = "DIAG_PROD_MOCK_IDENTITY"; layer = "configuration"; hint = "prod 环境必须清空 FOOTBALL_MOCK_TRUSTED_OPENID";
  } else if (lower.includes("environment mismatch") || lower.includes("env mismatch")) {
    diag_code = "DIAG_ENV_MISMATCH"; layer = "configuration"; hint = "云函数环境 ID 与 FOOTBALL_CLOUD_ENVIRONMENT_ID 不一致";
  } else if (lower.includes("wx-server-sdk") && (lower.includes("cannot find") || lower.includes("missing"))) {
    diag_code = "DIAG_FN_DEPENDENCY_MISSING"; layer = "cloud_function"; hint = "部署云函数时选择云端安装依赖";
  } else if (lower.includes("openid") && (lower.includes("missing") || lower.includes("required"))) {
    diag_code = "DIAG_FN_NO_OPENID"; layer = "cloud_function"; hint = "确认请求通过小程序云函数调用，并检查运行时身份上下文";
  } else if (lower.includes("collection") && (lower.includes("not exist") || lower.includes("not found"))) {
    diag_code = "DIAG_DB_COLLECTION_MISSING"; layer = "database"; hint = "按 cloudbase:schema 输出检查集合全名及命名空间前缀";
  } else if (lower.includes("permission") || lower.includes("denied") || lower.includes("not authorized")) {
    diag_code = "DIAG_DB_PERMISSION"; layer = "database"; hint = "确认云函数与数据库属于同一 CloudBase 环境";
  } else if (lower.includes("duplicate") || lower.includes("unique") || lower.includes("e11000")) {
    diag_code = "DIAG_DB_INDEX_MISSING"; layer = "database"; hint = "核对 S17 §17.3 第5步要求的唯一索引";
  } else if (lower.includes("transaction") || lower.includes("事务")) {
    diag_code = "DIAG_DB_TRANSACTION"; layer = "database"; hint = "对照 S17 §17.8 事务能力表检查当前操作";
  }

  return { diag_code, layer, hint, sdk_code: rawCode(error), sdk_message: redact(message) };
}

export function missingCloudEnvironmentKeys(env: Record<string, string | undefined>): string[] {
  const required = [
    "FOOTBALL_ENVIRONMENT",
    "FOOTBALL_MATCH_CURSOR_SECRET",
    "FOOTBALL_REPOSITORY_BACKEND",
    "FOOTBALL_CLOUD_ENVIRONMENT_ID",
    "FOOTBALL_RESOURCE_NAMESPACE",
  ];
  return required.filter((key) => env[key] === undefined || env[key]?.trim() === "");
}
