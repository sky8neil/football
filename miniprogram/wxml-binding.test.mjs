import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const ROOT = dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

const MUSTACHE_BUILTINS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "Math",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Date",
]);

function collectWxmlFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectWxmlFiles(full));
    } else if (entry.name.endsWith(".wxml")) {
      results.push(full);
    }
  }
  return results.sort();
}

function loadCommonJsWithStubs(entryFile) {
  const cache = new Map();
  const load = (filePath) => {
    const abs = resolve(filePath);
    if (cache.has(abs)) return cache.get(abs).exports;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const src = readFileSync(abs, "utf8");
    const factory = runInThisContext(
      "(function(exports, require, module, __filename, __dirname) {\n" + src + "\n})",
      { filename: abs },
    );
    const localRequire = (spec) => {
      if (spec.startsWith(".")) {
        let target = resolve(dirname(abs), spec);
        if (!existsSync(target) && existsSync(`${target}.js`)) {
          target = `${target}.js`;
        }
        return load(target);
      }
      return nodeRequire(spec);
    };
    factory(mod.exports, localRequire, mod, abs, dirname(abs));
    return mod.exports;
  };
  return load(entryFile);
}

/** 从源码中按括号配对提取 `.setData({ ... })` 字面量的顶层属性名（含简写属性）。 */
function extractSetDataTopLevelKeys(jsSource) {
  const keys = new Set();
  for (const match of jsSource.matchAll(/\.setData\s*\(\s*\{/g)) {
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    let inString = null;
    let escaped = false;
    let bodyStart = braceStart + 1;
    let bodyEnd = -1;
    for (let i = braceStart; i < jsSource.length; i += 1) {
      const ch = jsSource[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    if (bodyEnd === -1) continue;
    const block = jsSource.slice(bodyStart, bodyEnd);
    let innerBrace = 0;
    let innerParen = 0;
    let innerBracket = 0;
    let tokenStart = 0;
    inString = null;
    escaped = false;
    const pushSegment = (segment) => {
      const trimmed = segment.trim().replace(/^\/\/.*$/gm, "").trim();
      if (!trimmed || trimmed.startsWith("...")) return;
      const keyMatch = trimmed.match(/^["']?([a-zA-Z_$][\w$]*)["']?(?:\.[^:\s]+)?\s*(?::|$)/);
      if (keyMatch) keys.add(keyMatch[1]);
    };
    for (let i = 0; i < block.length; i += 1) {
      const ch = block[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        continue;
      }
      if (ch === "{") innerBrace += 1;
      else if (ch === "}") innerBrace -= 1;
      else if (ch === "(") innerParen += 1;
      else if (ch === ")") innerParen -= 1;
      else if (ch === "[") innerBracket += 1;
      else if (ch === "]") innerBracket -= 1;
      else if (ch === "," && innerBrace === 0 && innerParen === 0 && innerBracket === 0) {
        pushSegment(block.slice(tokenStart, i));
        tokenStart = i + 1;
      }
    }
    pushSegment(block.slice(tokenStart));
  }
  return keys;
}

function extractMustacheRootVariables(wxmlSource) {
  const loopAndHelperVars = new Set(["item", "index"]);
  for (const m of wxmlSource.matchAll(/\bwx:for-(?:item|index)\s*=\s*["']([a-zA-Z_$][\w$]*)["']/g)) {
    loopAndHelperVars.add(m[1]);
  }
  for (const m of wxmlSource.matchAll(/<wxs\b[^>]*\bmodule\s*=\s*["']([a-zA-Z_$][\w$]*)["']/g)) {
    loopAndHelperVars.add(m[1]);
  }
  const roots = new Set();
  for (const m of wxmlSource.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    let expr = m[1].replace(/(["'])(?:\\.|(?!\1).)*\1/g, " ");
    expr = expr.replace(/\.[a-zA-Z_$][\w$]*/g, " ");
    expr = expr.replace(/\b([a-zA-Z_$][\w$]*)\s*:/g, " ");
    for (const id of expr.matchAll(/\b([a-zA-Z_$][\w$]*)\b/g)) {
      const name = id[1];
      if (!MUSTACHE_BUILTINS.has(name) && !loopAndHelperVars.has(name)) {
        roots.add(name);
      }
    }
  }
  return [...roots].sort();
}

describe("miniprogram WXML 模板事件与数据绑定校验", () => {
  const savedGlobals = {
    Page: Object.getOwnPropertyDescriptor(globalThis, "Page"),
    Component: Object.getOwnPropertyDescriptor(globalThis, "Component"),
    getApp: Object.getOwnPropertyDescriptor(globalThis, "getApp"),
    wx: Object.getOwnPropertyDescriptor(globalThis, "wx"),
  };

  afterEach(() => {
    for (const [name, desc] of Object.entries(savedGlobals)) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  });

  const wxmlFiles = [
    ...collectWxmlFiles(join(ROOT, "pages")),
    join(ROOT, "custom-tab-bar", "index.wxml"),
  ];

  it("覆盖全部页面与 custom-tab-bar WXML 模板", () => {
    expect(wxmlFiles.length).toBeGreaterThanOrEqual(14);
  });

  for (const wxmlPath of wxmlFiles) {
    const relPath = relative(ROOT, wxmlPath);
    it(`${relPath} 的全部 bind/catch 处理函数与数据绑定均在对应 JS 中定义`, () => {
      const jsPath = wxmlPath.replace(/\.wxml$/, ".js");
      expect(existsSync(jsPath), `missing JS file for ${relPath}`).toBe(true);

      let definition = null;
      let isComponent = false;
      Object.defineProperty(globalThis, "Page", {
        value: (def) => {
          definition = def;
          isComponent = false;
        },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "Component", {
        value: (def) => {
          definition = def;
          isComponent = true;
        },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "getApp", {
        value: () => ({ globalData: {}, ensureAuth: async () => ({}) }),
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "wx", {
        value: {
          getStorageSync: () => "",
          setStorageSync: () => {},
          removeStorageSync: () => {},
          getMenuButtonBoundingClientRect: () => ({}),
          getWindowInfo: () => ({}),
          getSystemInfoSync: () => ({}),
        },
        configurable: true,
        writable: true,
      });

      loadCommonJsWithStubs(jsPath);
      expect(definition, `Page/Component not registered by ${relPath}`).toBeTruthy();

      const wxmlSource = readFileSync(wxmlPath, "utf8");
      const jsSource = readFileSync(jsPath, "utf8");

      const handlers = [
        ...new Set(
          [...wxmlSource.matchAll(/\b(?:bind|catch)(?::)?[a-zA-Z0-9_-]+\s*=\s*["']([^"']+)["']/g)].map(
            (m) => m[1],
          ),
        ),
      ];
      const methodHost = isComponent ? definition.methods ?? {} : definition;
      for (const handlerName of handlers) {
        expect(
          typeof methodHost[handlerName],
          `${relPath}: missing handler "${handlerName}" in ${relative(ROOT, jsPath)}`,
        ).toBe("function");
      }

      const knownDataKeys = new Set([
        ...Object.keys(definition.data ?? {}),
        ...(isComponent ? Object.keys(definition.properties ?? {}) : []),
        ...extractSetDataTopLevelKeys(jsSource),
      ]);
      const referencedVars = extractMustacheRootVariables(wxmlSource);
      for (const variable of referencedVars) {
        expect(
          knownDataKeys.has(variable),
          `${relPath}: dead data binding "{{${variable}}}" not in data/setData of ${relative(ROOT, jsPath)}`,
        ).toBe(true);
      }
    });
  }
});
