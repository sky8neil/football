function buildLevelView(input) {
  const { level, bPoints, isRated, remainingToRated, nextThreshold } = input;

  if (level >= 6) {
    return {
      state: "max",
      title: "已达最高等级",
      detail: "已达最高等级 · 顶级球星",
      progressPercent: 100,
      showProgress: false,
    };
  }

  if (isRated === false) {
    return {
      state: "unrated",
      title: "当前为初始等级 Lv.1",
      detail: remainingToRated > 0
        ? `还需完成 ${remainingToRated} 场有效预测，参与首次定级`
        : "已达到定级场次，等待每周评估",
      progressPercent: 0,
      showProgress: false,
    };
  }

  if (bPoints == null || nextThreshold == null) {
    return {
      state: "pending",
      title: "等待评估",
      detail: "暂无可用的评估积分，每周一 10:00 评估后更新",
      progressPercent: 0,
      showProgress: false,
    };
  }

  if (bPoints < nextThreshold) {
    const remaining = nextThreshold - bPoints;
    return {
      state: "below",
      title: `评估积分 ${bPoints} / ${nextThreshold}`,
      detail: `还差 ${remaining} 分`,
      progressPercent: Math.min(100, Math.floor((bPoints / nextThreshold) * 100)),
      showProgress: true,
    };
  }

  return {
    state: "reached",
    title: "评估积分已达门槛",
    detail: "上次评估积分已达门槛，升级还需满足表现条件，以每周评估结果为准",
    progressPercent: 100,
    showProgress: true,
  };
}

module.exports = { buildLevelView };
