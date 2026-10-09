import { describe, expect, it } from "vitest";
import { MatchStatus } from "./enums.js";
import type { Match } from "./types.js";
import { crowdStatus, roundDistribution } from "./crowd-distribution.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function crowdMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: "match",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: new Date("2026-08-09T12:10:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: NOW,
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: MatchStatus.Scheduled,
    settlement_status: "pending",
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as Match;
}

describe("roundDistribution", () => {
  it("converts 45/25/30 counts to the same percentages", () => {
    expect(roundDistribution({ HOME: 45, DRAW: 25, AWAY: 30 })).toEqual({
      home: 45,
      draw: 25,
      away: 30,
    });
  });

  it("breaks equal remainders in home, draw, away order", () => {
    expect(roundDistribution({ HOME: 21, DRAW: 21, AWAY: 21 })).toEqual({
      home: 35,
      draw: 35,
      away: 30,
    });
  });

  it("preserves zero-result buckets and always sums to 100 in 5% steps", () => {
    expect(roundDistribution({ HOME: 1, DRAW: 0, AWAY: 19 })).toEqual({
      home: 5,
      draw: 0,
      away: 95,
    });

    for (let home = 0; home <= 30; home += 1) {
      for (let draw = 0; draw <= 30; draw += 1) {
        for (let away = 0; away <= 30; away += 1) {
          if (home + draw + away < 20) continue;
          const distribution = roundDistribution({ HOME: home, DRAW: draw, AWAY: away });
          expect(distribution.home + distribution.draw + distribution.away).toBe(100);
          expect([distribution.home, distribution.draw, distribution.away].every(
            (value) => value % 5 === 0,
          )).toBe(true);
        }
      }
    }
  });
});

describe("crowdStatus", () => {
  it("keeps unconfirmed kickoff and a deadline before its boundary not closed", () => {
    expect(crowdStatus({
      match: crowdMatch({ kickoff_confirmed: false, prediction_deadline_at: null }),
      predictionCount: 50,
      serverNow: NOW,
    })).toBe("not_closed");
    expect(crowdStatus({
      match: crowdMatch({ prediction_deadline_at: new Date(NOW.getTime() + 1) }),
      predictionCount: 50,
      serverNow: NOW,
    })).toBe("not_closed");
  });

  it("uses the prediction deadline boundary and applies the minimum at 19/20", () => {
    expect(crowdStatus({
      match: crowdMatch(),
      predictionCount: 19,
      serverNow: NOW,
    })).toBe("insufficient");
    expect(crowdStatus({
      match: crowdMatch(),
      predictionCount: 20,
      serverNow: NOW,
    })).toBe("available");
  });

  it("treats live and finished as count-based after closing", () => {
    for (const match_status of [MatchStatus.Live, MatchStatus.Finished]) {
      expect(crowdStatus({
        match: crowdMatch({ match_status, prediction_closed_at: NOW }),
        predictionCount: 20,
        serverNow: NOW,
      })).toBe("available");
    }
  });

  it("does not expose distribution for postponed, cancelled, or abandoned matches", () => {
    for (const match_status of [
      MatchStatus.Postponed,
      MatchStatus.Cancelled,
      MatchStatus.Abandoned,
    ]) {
      expect(crowdStatus({
        match: crowdMatch({ match_status }),
        predictionCount: 20,
        serverNow: NOW,
      })).toBe("unavailable");
    }
  });
});
