Component({
  properties: { activeIndex: { type: Number, value: -1 } },
  data: {
    selected: 0,
    tabs: [
      { path: "/pages/matches/matches", label: "比赛", icon: "pitch" },
      { path: "/pages/rankings/rankings", label: "排行榜", icon: "ranking" },
      { path: "/pages/profile/profile", label: "我的", icon: "person" },
    ],
  },
  lifetimes: {
    attached() {
      if (this.properties.activeIndex >= 0) this.setData({ selected: this.properties.activeIndex });
    },
  },
  methods: {
    onTabTap(event) {
      wx.switchTab({ url: this.data.tabs[event.currentTarget.dataset.index].path });
    },
  },
});
