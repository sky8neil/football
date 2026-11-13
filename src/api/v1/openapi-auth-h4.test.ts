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
    expect(specification).not.toMatch(
      /(?:name:\s*(?:x[-_])?(?:openid|user_id|jwt|token|authorization)\b[\s\S]{0,300}?in:\s*(?:header|query|cookie)\b|in:\s*(?:header|query|cookie)\b[\s\S]{0,300}?name:\s*(?:x[-_])?(?:openid|user_id|jwt|token|authorization)\b)/i,
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
      ["/predictions", "post"],
      ["/predictions/me", "get"],
      ["/predictions/me/{prediction_id}", "get"],
      ["/profile/me", "get"],
      ["/profile/me", "patch"],
      ["/profile/me", "delete"],
      ["/levels/me", "get"],
      ["/unlocks/me", "get"],
      ["/share-card/me", "get"],
      ["/rankings", "get"],
      ["/admin/anomalies", "get"],
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
      ["/matches", "get"],
      ["/matches/{match_id}", "get"],
      ["/profiles/{user_id}", "get"],
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
    expect(wechatAuth).not.toMatch(/'429':/);
    expect(wechatAuth).not.toMatch(/'422':/);
    expect(wechatAuthRequest).toMatch(/^        code:/m);
    expect(wechatAuthRequest).not.toMatch(/^        (?:openid|user_id|token):/m);
    expect(wechatAuthRequest).toContain("additionalProperties: false");
  });
});
