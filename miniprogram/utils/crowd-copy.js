const RESULT_NAMES = {
  home: "主胜",
  draw: "平局",
  away: "客胜",
};

const COPY = {
  title: "大家怎么选",
  homeLink: "大家怎么选 ›",
  loading: "加载中",
  guest: "登录后可看",
  login: "登录",
  locked: "比赛截止后可看，达到最低参与人数后显示",
  insufficient: (minPredictions) => `参与人数不足，至少 ${minPredictions} 人预测后显示`,
  unavailable: "",
  failed: "暂时无法加载",
  retry: "重试",
  footer: "仅展示用户选择分布，不构成任何推荐",
  actualLabel: "实际结果",
  actualTag: "实际结果",
  comparisonSame: (actualName, percent) => `实际结果：${actualName}。约 ${percent}% 的人和你一样选对了`,
  comparisonDifferent: (actualName, percent) => `实际结果：${actualName}。约 ${percent}% 的人和你选了一样的`,
  comparisonNoPrediction: (actualName, percent) => `实际结果：${actualName}。约 ${percent}% 的人选对了结果`,
  yourChoice: "你选了",
};

module.exports = { COPY, RESULT_NAMES };
