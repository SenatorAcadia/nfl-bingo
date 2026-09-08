/*
 * Filename: test/game-rules.test.js
 * Purpose: Verify evidence-calibrated event detection, tracking, and card balance.
 * Version: 25.0.1
 */

/* Section 1: Test setup
 * Load Node's test tools and the browser-compatible rule module.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../js/game-rules.js");

/* Section 2: Direct detection tests
 * Protect thresholds, turnover semantics, kicking distinctions, and rare events.
 */
test("emits overlapping calibrated pass thresholds", () => {
    const events = rules.analyzePlay({
        text: "Q.Player pass complete for 31 yards",
        type: { text: "Pass Reception" },
        statYardage: 31,
        start: { down: 2, team: { id: "1" } },
        end: { down: 1, team: { id: "1" } }
    });
    assert.deepEqual(events, ["PASS 20+ YDS", "PASS 25+ YDS", "PASS 30+ YDS"]);
});

test("distinguishes offensive fumbles from turnovers", () => {
    const recoveredByOffense = rules.analyzePlay({
        text: "R.Player FUMBLES, recovered by offense",
        type: { text: "Rush" },
        start: { team: { id: "1" } },
        end: { team: { id: "1" } }
    });
    const recoveredByDefense = rules.analyzePlay({
        text: "R.Player FUMBLES, recovered by defense",
        type: { text: "Rush" },
        start: { team: { id: "1" } },
        end: { team: { id: "2" } }
    });
    assert.ok(recoveredByOffense.includes("FUMBLE"));
    assert.ok(!recoveredByOffense.includes("TURNOVER"));
    assert.ok(recoveredByDefense.includes("TURNOVER"));
});

test("does not classify punt distance as return yardage", () => {
    const events = rules.analyzePlay({
        text: "P.Punter punts 52 yards to the end zone, touchback",
        type: { text: "Punt" },
        statYardage: 52,
        end: { yardsToEndzone: 80 }
    });
    assert.ok(!events.includes("PUNT RETURN 10+ YDS"));
    assert.ok(!events.includes("PUNT INSIDE THE 20"));
});

test("detects fourth-down outcomes from structured downs", () => {
    const conversion = rules.analyzePlay({
        text: "Q.Player pass complete for 4 yards",
        type: { text: "Pass Reception" },
        statYardage: 4,
        start: { down: 4, distance: 2, team: { id: "1" } },
        end: { down: 1, team: { id: "1" } }
    });
    const stop = rules.analyzePlay({
        text: "Q.Player pass incomplete",
        type: { text: "Pass Incompletion" },
        start: { down: 4, distance: 3, team: { id: "1" } },
        end: { down: 1, team: { id: "2" } }
    });
    assert.ok(conversion.includes("4TH DOWN CONVERSION"));
    assert.ok(stop.includes("4TH DOWN STOP"));
});

test("a missed extra point is not a missed field goal", () => {
    const events = rules.analyzePlay({ text: "K.Kicker extra point is NO GOOD", type: { text: "Extra Point" } });
    assert.ok(!events.includes("MISSED FG"));
});

/* Section 3: Stateful tracking tests
 * Verify sequences and cumulative milestones that replaced automatic squares.
 */
test("tracks sack, explosive-pass, and touchdown milestones", () => {
    const tracker = rules.createGameTracker();
    const sack = number => tracker.process({
        id: `s${number}`, text: "Q.Player sacked for -5 yards", type: { text: "Sack" },
        start: { down: 2, team: { id: "1" } }, end: { down: 3, team: { id: "1" } }
    });
    assert.ok(!sack(1).includes("2 SACKS TOTAL"));
    assert.ok(sack(2).includes("2 SACKS TOTAL"));
    assert.ok(sack(3).includes("3 SACKS TOTAL"));

    let lastEvents = [];
    for(let number = 1; number <= 3; number++) {
        lastEvents = tracker.process({
            id: `p${number}`, text: "Q.Player pass complete for 22 yards", type: { text: "Pass Reception" },
            statYardage: 22, start: { down: 1, team: { id: "1" } }, end: { down: 1, team: { id: "1" } }
        });
    }
    assert.ok(lastEvents.includes("3 PASSES OF 20+ YDS"));
    assert.ok(lastEvents.includes("3 STRAIGHT COMPLETIONS"));
});

test("tracks both-team scoring and a tie after scoreless play", () => {
    const tracker = rules.createGameTracker();
    tracker.process({
        text: "Runner for 2 yards, TOUCHDOWN", type: { text: "Rush" }, scoringPlay: true,
        statYardage: 2, awayScore: 0, homeScore: 6,
        start: { down: 1, team: { id: "1" } }, end: { team: { id: "1" } }
    });
    const events = tracker.process({
        text: "Receiver for 10 yards, TOUCHDOWN", type: { text: "Pass Reception" }, scoringPlay: true,
        statYardage: 10, awayScore: 6, homeScore: 6,
        start: { down: 1, team: { id: "2" } }, end: { team: { id: "2" } }
    });
    assert.ok(events.includes("BOTH TEAMS SCORE TD"));
    assert.ok(events.includes("TIE GAME AFTER 0-0"));
});

/* Section 4: Card-balance tests
 * Guarantee unique one-card-tuned cards with the expected free center.
 */
test("balanced classic cards use the one-card-tuned tier mix", () => {
    const events = rules.createBalancedEvents(() => 0.42, true);
    const counts = { common: 0, uncommon: 0, rare: 0 };
    assert.equal(events.length, 25);
    assert.equal(events[12], "FREE");
    assert.equal(new Set(events).size, 25);
    for (const event of events) {
        for (const tier of Object.keys(counts)) {
            if (rules.catalog[tier].includes(event)) counts[tier] += 1;
        }
    }
    assert.deepEqual(counts, rules.cardMix);
});

test("every catalog square is unique and manually callable", () => {
    assert.equal(rules.allSquares.length, 44);
    assert.equal(rules.allSquares.length, new Set(rules.allSquares).size);
});
