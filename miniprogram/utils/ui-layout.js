// Reserve the real WeChat status/capsule area rather than drawing a fake status bar.
function headerHeight() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = wx.getMenuButtonBoundingClientRect();
    return capsule.bottom + Math.max(8, capsule.top - info.statusBarHeight);
  } catch (_) { return 88; }
}
module.exports = { headerHeight };
