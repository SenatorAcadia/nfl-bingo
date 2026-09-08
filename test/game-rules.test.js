/*
 * Filename: test/game-rules.test.js
 * Purpose: Verify square detection and balanced-card guarantees for NFL BEANO.
 * Version: 24.1.0
 */

/* Section 1: Test setup
 * Load Node's test tools and the browser-compatible rules module.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../js/game-rules.js");

/* Section 2: Detection tests
 * Protect the football semantics that previously produced dead or incorrect squares.
 */
test("detects structured pass yardage without dead-label mismatches", () => {
    const events = rules.analyzePlay({
        id: "p1",
        text: "(Shotgun) Q.Player pass complete for 38 yards",
        type: { text: "Pass Reception" },
        statYardage: 38,
        start: { down: 2, yardsToEndzone: 48 }
    });

    assert.deepEqual(events, ["COMPLETE PASS", "SHOTGUN", "PASS 10+ YDS", "PASS 20+ YDS", "PASS 35+ YDS"]);
});

test("an interception is always a turnover", () => {
    const events = rules.analyzePlay({
        text: "Q.Player pass INTERCEPTED by D.Player",
        type: { text: "Pass Interception" },
        statYardage: 0
    });

    assert.ok(events.includes("INTERCEPTION"));
    assert.ok(events.includes("TURNOVER"));
});

test("an offensive fumble recovery is not a turnover", () => {
    const events = rules.analyzePlay({
        text: "R.Player FUMBLES, recovered by offense",
        type: { text: "Rush" },
        statYardage: 4,
        start: { team: { id: "1" } },
        end: { team: { id: "1" } }
    });

    assert.ok(events.includes("FUMBLE"));
    assert.ok(!events.includes("TURNOVER"));
});

test("a missed extra point is not a missed field goal", () => {
    const events = rules.analyzePlay({
        text: "K.Kicker extra point is NO GOOD",
        type: { text: "Extra Point" },
        scoreValue: 0
    });

    assert.ok(!events.includes("MISSED FG"));
});

test("punt distance is not mistaken for return yardage", () => {
    const events = rules.analyzePlay({
        text: "P.Punter punts 52 yards to the end zone, touchback",
        type: { text: "Punt" },
        statYardage: 52
    });

    assert.ok(events.includes("PUNT"));
    assert.ok(!events.includes("RETURN 10+ YDS"));
    assert.ok(!events.includes("RETURN 30+ YDS"));
});

test("overtime and defensive touchdowns use structured context", () => {
    const events = rules.analyzePlay({
        text: "Pass INTERCEPTED and returned for a TOUCHDOWN",
        type: { text: "Interception Return Touchdown" },
        scoringPlay: true,
        scoreValue: 6,
        period: { number: 5 },
        start: { team: { id: "1" } },
        end: { team: { id: "2" } }
    });

    assert.ok(events.includes("DEFENSIVE TD"));
    assert.ok(events.includes("OVERTIME"));
});

/* Section 3: Card-balance tests
 * Guarantee unique, correctly weighted cards and a free center.
 */
test("balanced classic cards contain 16 common, 6 uncommon, and 2 rare squares", () => {
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

test("every catalog square can be emitted or manually called", () => {
    assert.equal(rules.allSquares.length, new Set(rules.allSquares).size);
    assert.ok(rules.allSquares.every(square => typeof square === "string" && square.length > 0));
});
