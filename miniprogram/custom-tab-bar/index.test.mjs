import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(root + path, "utf8");
function loadComponent(activeIndex = -1) {
  let definition;
  const switchTab = vi.fn();
  runInNewContext(read("custom-tab-bar/index.js"), { Component: (value) => { definition = value; }, wx: { switchTab } });
  const component = {
    data: { ...definition.data }, properties: { activeIndex },
    setData(value) { Object.assign(this.data, value); },
  };
  definition.lifetimes.attached.call(component);
  return { definition, component, switchTab };
}

describe("shared mini program bottom navigation", () => {
  it("registers native tab pages and reuses the same component on prediction history", () => {
    const app = JSON.parse(read("app.json"));
    const page = JSON.parse(read("pages/my-predictions/my-predictions.json"));
    expect(app.tabBar.custom).toBe(true);
    expect(page.usingComponents["app-tab-bar"]).toBe("/custom-tab-bar/index");
    expect(read("pages/my-predictions/my-predictions.wxml")).toContain('<app-tab-bar active-index="2"');
    expect(loadComponent().component.data.tabs.map((tab) => tab.path.slice(1))).toEqual(app.tabBar.list.map((tab) => tab.pagePath));
  });
  it.each([0, 1, 2])("switches tab %i to its real page", (index) => {
    const { definition, component, switchTab } = loadComponent();
    definition.methods.onTabTap.call(component, { currentTarget: { dataset: { index } } });
    expect(switchTab).toHaveBeenCalledWith({ url: component.data.tabs[index].path });
  });
  it("highlights My on prediction history and lets My return to the profile tab", () => {
    const { definition, component, switchTab } = loadComponent(2);
    expect(component.data.selected).toBe(2);
    definition.methods.onTabTap.call(component, { currentTarget: { dataset: { index: 2 } } });
    expect(switchTab).toHaveBeenCalledWith({ url: "/pages/profile/profile" });
  });
  it.each([["matches", 0], ["rankings", 1], ["profile", 2]])("refreshes selection when cached %s page is shown", (name, index) => {
    let definition;
    const setData = vi.fn();
    runInNewContext(read(`pages/${name}/${name}.js`), {
      Page: (value) => { definition = value; },
      require: () => ({}), wx: { getStorageSync: () => null },
    });
    const page = { getTabBar: () => ({ setData }), loadFirstPage: vi.fn(), loadPage: vi.fn(), initialized: false };
    definition.onShow.call(page);
    expect(setData).toHaveBeenCalledWith({ selected: index });
  });
});
