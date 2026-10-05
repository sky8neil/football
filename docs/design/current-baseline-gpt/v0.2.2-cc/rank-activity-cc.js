/* Offline fixture; production should supply server_now and last_prediction_at. */
(function () {
  const dayMs = 24 * 60 * 60 * 1000;
  const params = new URLSearchParams(location.search);
  const requestedDays = Number(params.get('inactiveDays'));
  const inactiveDays = Number.isFinite(requestedDays) && requestedDays >= 0 ? requestedDays : 0;
  const serverNow = Date.now();
  window.rankingActivity = {
    serverNow,
    lastPredictionAt: serverNow - inactiveDays * dayMs
  };

  window.shouldShowRankingUpdated = function (board) {
    if (!['career', 'strength', 'season'].includes(board)) return true;
    const { serverNow, lastPredictionAt } = window.rankingActivity;
    if (!Number.isFinite(serverNow) || !Number.isFinite(lastPredictionAt)) return false;
    const elapsed = serverNow - lastPredictionAt;
    return elapsed >= 0 && elapsed <= 10 * dayMs;
  };
})();
