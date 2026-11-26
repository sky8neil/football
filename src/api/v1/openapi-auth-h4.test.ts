import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const pathBlock = (specification: string, path: string): string => {
  const start = specification.indexOf(`  ${path}:\n`);
  const nextPath = specification.indexOf("\n  /", start + 1);
  return start === -1 ? "" : specification.slice(start, nextPath === -1 ? undefined : nextPath);
};

const operationBlock = (
  specification: string,
  path: string,
  method: "get" | "post" | "patch" | "delete",
): string => {
  const pathSpecification = pathBlock(specification, path);
  const start = pathSpecification.indexOf(`    ${method}:\n`);
  const remaining = start === -1 ? "" : pathSpecification.slice(start);
  const nextOperation = remaining.search(
    /\n    (?:get|post|put|patch|delete|head|options|trace):\n/,
  );

  return nextOperation === -1 ? remaining : remaining.slice(0, nextOperation);
};

describe("H4 dual-deploy identity OpenAPI contract", () => {
  it("forbids JWT bearer and client-supplied identity schemes", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const securitySchemes = specification.match(
      /^  securitySchemes:\n((?: {4,}.*(?:\n|$))*)/m,
    )?.[1] ?? "";

    expect(specification).not.toMatch(/BearerAuth/);
    expect(specification).not.toMatch(/bearerFormat:\s*JWT/);
    expect(securitySchemes).not.toMatch(/type:\s*(?:apiKey|oauth2|openIdConnect)/i);
    // 公开资源标识（如 /share-card/{user_id} 的 path 参数）不算客户端自带身份：
    // 该守卫只针对 header/query/cookie 里出现的身份字段，因此匹配不得跨到下一个参数块。
    expect(specification).not.toMatch(
      /(?:name:\s*(?:x[-_])?(?:openid|user_id|jwt|token|authorization)\b(?:(?!- name:)[\s\S]){0,300}?in:\s*(?:header|query|cookie)\b|in:\s*(?:header|query|cookie)\b[\s\S]{0,300}?name:\s*(?:x[-_])?(?:openid|user_id|jwt|token|authorization)\b)/i,
    );
    // 反向守卫：header/query/cookie 参数里不得再出现身份字段名
    expect(specification).not.toMatch(
      /- name:\s*(?:x[-_])?(?:openid|user_id|jwt|token|authorization)\s*\n\s*in:\s*(?:header|query|cookie)\b/i,
    );
  });

  it("declares an opaque VPS bearer that the backend must verify", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const securitySchemes = specification.match(
      /^  securitySchemes:\n((?: {4,}.*(?:\n|$))*)/m,
    )?.[1] ?? "";

    expect(securitySchemes).toMatch(/VpsSessionBearer:/);
    expect(securitySchemes).toMatch(/scheme:\s*bearer/);
    expect(securitySchemes).toMatch(/bearerFormat:\s*Opaque/);
    expect(securitySchemes).toMatch(/网关必须校验后再注入 trusted_openid/);
    expect(securitySchemes).toMatch(/不是 JWT/);
    expect(securitySchemes).toMatch(/CloudBase 继续使用云函数 context\.OPENID/);
  });

  it("declares the trusted runtime identity model at the document level", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const trustedRuntime = specification.match(
      /^x-trusted-runtime-openid:\n(?: {2}.*\n?)+/m,
    )?.[0] ?? "";

    expect(trustedRuntime).toContain("required_for: auth_required_operations");
    expect(trustedRuntime).toContain("identity_field: openid");
    expect(trustedRuntime).toContain("injection: gateway_or_runtime");
    expect(trustedRuntime).toContain("client_supply_forbidden: true");
    expect(trustedRuntime).toContain("CloudBase 从云函数 context.OPENID 注入");
    expect(trustedRuntime).toContain("自建 VPS / HTTP 签发不透明 Bearer 会话");
  });

  it("marks every auth-required operation as depending on trusted openid", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const authRequiredOperations = [
      ["/session/init", "post"],
      ["/predictions/summary", "get"],
      ["/matches/{match_id}/crowd", "get"],
      ["/predictions", "post"],
      ["/predictions/me", "get"],
      ["/predictions/me/{prediction_id}", "get"],
      ["/profile/me", "get"],
      ["/profile/me", "patch"],
      ["/profile/me", "post"],
      ["/profile/me", "delete"],
      ["/levels/me", "get"],
      ["/unlocks/me", "get"],
      ["/share-card/me", "get"],
      ["/rankings", "get"],
      ["/groups", "post"],
      ["/groups/join", "post"],
      ["/groups/{group_id}/leave", "post"],
      ["/groups/me", "get"],
      ["/groups/{group_id}", "get"],
      ["/groups/{group_id}", "delete"],
      ["/admin/auth/me", "get"],
      ["/admin/auth/logout", "post"],
      ["/admin/anomalies", "get"],
      ["/admin/anomalies/{anomaly_id}/resolve", "post"],
      ["/admin/audit-logs", "get"],
      ["/admin/teams", "get"],
      ["/admin/teams/{team_id}", "patch"],
      ["/admin/teams/{team_id}/mappings", "post"],
      ["/admin/matches/{match_id}/result-corrections", "post"],
      ["/admin/matches/{match_id}/retry-settlement", "post"],
      ["/admin/rebuild/users/{user_id}", "post"],
      ["/admin/rebuild/rankings", "post"],
    ] as const;

    for (const [path, method] of authRequiredOperations) {
      const operation = operationBlock(specification, path, method);
      expect(operation).toContain("x-requires-trusted-openid: true");
      expect(operation).not.toContain("security:");
    }
  });

  it("keeps public reads and wechat login free of a required identity marker", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const publicReads = [
      ["/auth/wechat", "post"],
      ["/admin/auth/login", "post"],
      ["/leagues/status", "get"],
      ["/league-seasons", "get"],
      ["/teams", "get"],
      ["/matches", "get"],
      ["/matches/{match_id}", "get"],
      ["/profiles/{user_id}", "get"],
      ["/share-card/{user_id}", "get"],
    ] as const;

    for (const [path, method] of publicReads) {
      expect(operationBlock(specification, path, method)).not.toContain(
        "x-requires-trusted-openid: true",
      );
    }
  });

  it("keeps session init protected by trusted openid and declares 401", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const sessionInit = operationBlock(specification, "/session/init", "post");
    const sessionInitRequest = specification.match(
      /^    SessionInitRequest:\n((?: {6,}.*(?:\n|$))*)/m,
    )?.[1] ?? "";

    expect(sessionInit).toContain("x-requires-trusted-openid: true");
    expect(sessionInit).toMatch(/'401':\n          \$ref: '#\/components\/responses\/Unauthorized'/);
    expect(sessionInit).toMatch(/'500':\n          \$ref: '#\/components\/responses\/InternalError'/);
    expect(sessionInit).not.toMatch(/'409':/);
    expect(sessionInitRequest).not.toMatch(/^        (?:openid|user_id):/m);
  });

  it("declares POST /auth/wechat as a public code exchange with 401", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const wechatAuth = operationBlock(specification, "/auth/wechat", "post");
    const wechatAuthRequest = specification.match(
      /^    WechatAuthRequest:\n((?: {6,}.*(?:\n|$))*)/m,
    )?.[1] ?? "";

    expect(wechatAuth).not.toContain("security:");
    expect(wechatAuth).toMatch(/'401':\n          \$ref: '#\/components\/responses\/Unauthorized'/);
    expect(wechatAuth).toMatch(/'422':\n          \$ref: '#\/components\/responses\/ValidationError'/);
    expect(wechatAuth).toMatch(/'429':\n          \$ref: '#\/components\/responses\/RateLimited'/);
    expect(wechatAuthRequest).toMatch(/^        code:/m);
    expect(wechatAuthRequest).toContain("pattern: '^[A-Za-z0-9_-]{1,128}$'");
    expect(wechatAuthRequest).not.toMatch(/^        (?:openid|user_id|token):/m);
    expect(wechatAuthRequest).toContain("additionalProperties: false");
  });

  it("declares 401 and 429 for public reads that pre-parse bearer or rate-limit", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const bearerRejected = [
      ["/leagues/status", "get"],
      ["/league-seasons", "get"],
      ["/teams", "get"],
      ["/matches", "get"],
      ["/matches/{match_id}", "get"],
      ["/profiles/{user_id}", "get"],
      ["/share-card/{user_id}", "get"],
    ] as const;
    for (const [path, method] of bearerRejected) {
      expect(operationBlock(specification, path, method)).toMatch(
        /'401':\n          \$ref: '#\/components\/responses\/Unauthorized'/,
      );
    }
    for (const path of ["/league-seasons", "/teams", "/share-card/{user_id}"] as const) {
      expect(operationBlock(specification, path, "get")).toMatch(
        /'429':\n          \$ref: '#\/components\/responses\/RateLimited'/,
      );
    }
  });

  it("points GET /groups/me conflicts at group responses, not prediction history", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const myGroups = operationBlock(specification, "/groups/me", "get");
    expect(myGroups).toMatch(/'409':\n          \$ref: '#\/components\/responses\/Conflict'/);
    expect(myGroups).not.toMatch(/'404':/);
    expect(myGroups).not.toContain("PredictionHistory");
  });

  it("declares 405 on every registered operation", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    const paths = [...specification.matchAll(/^  (\/[^:\n]+):\n/gm)].map((match) => match[1] ?? "");
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const block = pathBlock(specification, path);
      const methods = [...block.matchAll(/\n    (get|post|patch|delete):\n/g)].map((match) => match[1] ?? "");
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        expect(operationBlock(specification, path, method as "get" | "post" | "patch" | "delete")).toContain(
          "$ref: '#/components/responses/MethodNotAllowed'",
        );
      }
    }
  });
});
