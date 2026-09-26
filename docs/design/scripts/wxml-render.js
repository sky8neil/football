/**
 * WXML → HTML 渲染器（供 extract-home-visuals.py 在浏览器里调用）
 *
 * 只做「样式提取」需要的事：把 WXML 的结构/条件/循环/数据绑定还原成等价的 HTML DOM，
 * 让浏览器能在真实 CSS cascade 下算出最终生效样式。不做事件绑定、不做组件语义。
 *
 * 语义覆盖：
 *   - 标签映射：view→div、text→span、image→img、scroll-view→div、button→button
 *   - {{expr}}：用 new Function + with(ctx) 原生求值（WXML 是 JS 表达式，不要在 Python 里翻译）
 *   - wx:if / wx:elif / wx:else：相邻兄弟链，命中即短路
 *   - wx:for：绑定 item / index
 *   - class / id / style 里的插值；src 一律替换成 1×1 透明占位图（只看样式，不看图）
 *
 * 已知取舍：同一元素上同时出现 wx:for 与 wx:if 时，wx:if 在外层作用域判断（本仓库未用到该组合）。
 */
(function () {
  const TAG_MAP = { view: "div", text: "span", image: "img", "scroll-view": "div", button: "button" };
  const DROP_ATTR = /^(wx-|bind|catch|data-|mode$|aria-|hover-)/;
  const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  function evalJs(expr, ctx) {
    // eslint-disable-next-line no-new-func
    const fn = new Function("ctx", "with (ctx) { return (" + expr + "); }");
    return fn(ctx);
  }

  function interp(value, ctx) {
    if (value == null) return value;
    const only = /^\{\{([\s\S]*)\}\}$/.exec(value);
    if (only) return evalJs(only[1], ctx);
    return value.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
      const v = evalJs(e, ctx);
      return v == null ? "" : String(v);
    });
  }

  function attrsOf(el) {
    const out = {};
    for (const a of el.attributes) out[a.name] = a.value;
    return out;
  }

  function renderElement(el, ctx) {
    const tag = TAG_MAP[el.tagName] || el.tagName;
    const attrs = attrsOf(el);
    const parts = [];
    // scroll-view 的滚动轴在小程序里由原生处理；这里映射成等价 overflow，
    // 否则浏览器会把内容溢出显示，影响容器与子元素的布局结果。
    const overflow = [];
    if ("scroll-x" in attrs) overflow.push("overflow-x: auto");
    if ("scroll-y" in attrs) overflow.push("overflow-y: auto");
    for (const [k, v] of Object.entries(attrs)) {
      if (DROP_ATTR.test(k)) continue;
      if (k === "scroll-x" || k === "scroll-y") continue;
      if (k === "class") {
        const c = String(interp(v, ctx)).replace(/\s+/g, " ").trim();
        if (c) parts.push('class="' + c + '"');
      } else if (k === "id") {
        parts.push('id="' + interp(v, ctx) + '"');
      } else if (k === "style" || (k === "enable-flex" && overflow.length)) {
        // enable-flex 只是小程序的布局开关，不进 HTML
        if (k === "style") parts.push('style="' + interp(v, ctx) + '"');
      } else if (k === "src") {
        parts.push('src="' + (tag === "img" ? PLACEHOLDER : interp(v, ctx)) + '"');
      } else {
        parts.push(k + '="' + String(interp(v, ctx)) + '"');
      }
    }
    if (overflow.length) {
      const existing = parts.findIndex((s) => s.startsWith('style="'));
      const decl = overflow.join("; ");
      if (existing >= 0) parts[existing] = parts[existing].replace(/^style="/, 'style="' + decl + "; ");
      else parts.push('style="' + decl + '"');
    }
    if (tag === "img") return "<img " + parts.join(" ") + ">";
    return "<" + tag + " " + parts.join(" ") + ">" + renderChildren(el, ctx) + "</" + tag + ">";
  }

  function renderChildren(parent, ctx) {
    let out = "";
    let branchTaken = false;
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) {
        const t = interp(node.textContent, ctx);
        out += t == null ? "" : String(t);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const attrs = attrsOf(node);
      if ("wx-if" in attrs) {
        const ok = !!interp(attrs["wx-if"], ctx);
        branchTaken = ok;
        if (!ok) continue;
      } else if ("wx-elif" in attrs) {
        const ok = !branchTaken && !!interp(attrs["wx-elif"], ctx);
        branchTaken = branchTaken || ok;
        if (!ok) continue;
      } else if ("wx-else" in attrs) {
        if (branchTaken) continue;
        branchTaken = true;
      }
      if ("wx-for" in attrs) {
        const list = interp(attrs["wx-for"], ctx) || [];
        list.forEach((item, index) => {
          out += renderElement(node, Object.assign({}, ctx, { item, index }));
        });
        continue;
      }
      out += renderElement(node, ctx);
    }
    return out;
  }

  /** WXML 允许无值属性（scroll-x / enable-flex 等），XML 解析器不允许 → 需要补 ="true"。
      必须**引号感知**：属性值里的 {{ item.id === selectedLeague ? 'a' : '' }} 也含
      「空格+标识符+空格」，naive 正则会把表达式里的变量名当无值属性补上 ="true"。 */
  function normalizeBareAttrs(source) {
    return source.replace(/<[^>]+>/g, (tag) => {
      let out = "";
      let quote = null;
      for (let i = 0; i < tag.length; i++) {
        const ch = tag[i];
        if (quote) {
          out += ch;
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          out += ch;
          continue;
        }
        if (/[a-zA-Z]/.test(ch) && /\s/.test(out[out.length - 1] || "")) {
          let j = i;
          let name = "";
          while (j < tag.length && /[\w-]/.test(tag[j])) {
            name += tag[j];
            j += 1;
          }
          const next = tag[j];
          // 注意：/<[^>]+>/ 的匹配包含首尾尖括号，所以标签内最后一个属性的 next 是 ">"
          if (name && (next === undefined || next === " " || next === "/" || next === ">")) {
            out += name + '="true"';
            i = j - 1;
            continue;
          }
        }
        out += ch;
      }
      return out;
    });
  }

  window.__renderWxml = function (wxmlSource, data) {
    const fixed = normalizeBareAttrs(String(wxmlSource).replace(/wx:/g, "wx-"));
    const doc = new DOMParser().parseFromString(fixed, "text/xml");
    const bad = doc.getElementsByTagName("parsererror");
    if (bad.length) throw new Error("WXML 解析失败: " + bad[0].textContent.slice(0, 300));
    // 注意：要渲染 documentElement 本身（WXML 的根 <view class="page">），
    // 只渲染它的子节点会把这个根容器整层丢掉——它的底色/内边距/overflow 都不会进快照。
    return renderElement(doc.documentElement, Object.assign({}, data));
  };
})();
