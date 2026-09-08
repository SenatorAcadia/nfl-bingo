/*
 * Filename: js/game-rules.js
 * Purpose: Detect evidence-calibrated NFL BEANO events and build balanced game-night cards.
 * Version: 25.0.0
 */

/* Section 1: Module wrapper
 * Expose identical rules to the browser game and Node.js verification tests.
 */
(function exposeGameRules(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.BeanoRules = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createGameRules() {
    "use strict";

    /* Section 2: Empirical square catalog
     * Use thresholds and game developments measured across 285 complete NFL feeds.
     */
    const CATALOG = Object.freeze({
        common: Object.freeze([
            "PASS 20+ YDS", "RUN 10+ YDS", "10+ YARD PENALTY", "THREE AND OUT",
            "PUNT INSIDE THE 20", "PASS 25+ YDS", "3 STRAIGHT RUNS", "2 SACKS TOTAL",
            "3RD & 8+ CONVERSION", "HOLDING", "3 PASSES OF 20+ YDS", "TURNOVER",
            "FUMBLE", "3 RUNS OF 10+ YDS", "RUN 15+ YDS", "3 TOUCHDOWNS TOTAL",
            "PASS 30+ YDS", "BOTH TEAMS SCORE TD"
        ]),
        uncommon: Object.freeze([
            "2 FIELD GOALS TOTAL", "4TH DOWN CONVERSION", "40+ YARD FIELD GOAL",
            "3 SACKS TOTAL", "INTERCEPTION", "3 STRAIGHT COMPLETIONS",
            "2 PUNTS INSIDE THE 20", "PUNT RETURN 10+ YDS", "4TH DOWN STOP",
            "20+ YARD TOUCHDOWN", "2 TURNOVERS TOTAL", "BOTH TEAMS MAKE FG",
            "REVIEW", "PASS INT"
        ]),
        rare: Object.freeze([
            "LEAD CHANGE", "PASS 40+ YDS", "RUN 25+ YDS", "50+ YARD FIELD GOAL",
            "TIE GAME AFTER 0-0", "MISSED FG", "RUN 30+ YDS", "2-POINT CONVERSION",
            "DEFENSIVE TD", "BLOCKED KICK", "OVERTIME", "SAFETY"
        ])
    });

    const CARD_MIX = Object.freeze({ common: 8, uncommon: 8, rare: 8 });
    const ALL_SQUARES = Object.freeze(Object.values(CATALOG).flat());

    /* Section 3: Feed normalization
     * Convert ESPN play objects into one stable shape used by all detectors.
     */
    function firstFiniteNumber(...values) {
        for (const value of values) {
            const number = Number(value);
            if (value !== null && value !== "" && Number.isFinite(number)) return number;
        }
        return null;
    }

    function normalizePlay(play) {
        const source = typeof play === "string" ? { text: play } : (play || {});
        const text = String(source.text || source.description || "");
        const type = String(source.type?.text || source.type || "");
        return {
            source,
            id: String(source.id || source.playId || ""),
            text,
            upperText: text.toUpperCase(),
            upperType: type.toUpperCase(),
            yards: firstFiniteNumber(source.statYardage, source.yardsGained, source.yards),
            period: firstFiniteNumber(source.period?.number, source.period),
            down: firstFiniteNumber(source.start?.down, source.down),
            distance: firstFiniteNumber(source.start?.distance, source.distance),
            endDown: firstFiniteNumber(source.end?.down),
            endYardsToEndzone: firstFiniteNumber(source.end?.yardsToEndzone, source.end?.yardsToEndZone),
            startTeam: String(source.start?.team?.id || source.possessionTeamId || ""),
            endTeam: String(source.end?.team?.id || source.endPossessionTeamId || ""),
            awayScore: firstFiniteNumber(source.awayScore),
            homeScore: firstFiniteNumber(source.homeScore),
            scoringPlay: Boolean(source.scoringPlay || source.isScoringPlay),
            scoreValue: firstFiniteNumber(source.scoreValue)
        };
    }

    /* Section 4: Play classification
     * Derive explainable football facts without depending on undocumented event labels alone.
     */
    function classifyPlay(play) {
        const p = normalizePlay(play);
        const text = p.upperText;
        const type = p.upperType;
        const isNoPlay = text.includes("NO PLAY");
        const isIncomplete = type.includes("INCOMPLETE") || text.includes("INCOMPLETE");
        const isInterception = type.includes("INTERCEPT") || text.includes("INTERCEPT");
        const isSack = type.includes("SACK") || /\bSACKED\b|\bSACK\b/.test(text);
        const isPass = !isSack && (type.includes("PASS") || text.includes(" PASS ") || isIncomplete);
        const isPunt = type.includes("PUNT") || /\bPUNTS?\b/.test(text);
        const isFieldGoalAttempt = type.includes("FIELD GOAL") || text.includes("FIELD GOAL");
        const isKick = type.includes("KICK") || isPunt || isFieldGoalAttempt;
        const isRush = !isPass && !isKick && !isSack && (
            type.includes("RUSH") || type.includes("RUN") ||
            /\bLEFT (END|TACKLE|GUARD)\b|\bRIGHT (END|TACKLE|GUARD)\b|\bUP THE MIDDLE\b|\bSCRAMBLES?\b/.test(text)
        );
        const isCompletePass = isPass && !isIncomplete && !isInterception && !isNoPlay;
        const isPenalty = (Boolean(play?.isPenalty) || type.includes("PENALTY") || text.includes("PENALTY") || text.includes("FLAG")) && !text.includes("NO PLAY, NO PENALTY");
        const isDeclined = text.includes("DECLINED") || text.includes("OFFSET");
        const isTouchdown = (p.scoringPlay && p.scoreValue === 6) || text.includes("TOUCHDOWN");
        const isFumble = type.includes("FUMBLE") || /\bFUMBLES?\b|\bMUFFS?\b/.test(text);
        const possessionChanged = Boolean(p.startTeam && p.endTeam && p.startTeam !== p.endTeam);
        const isTurnover = isInterception || (isFumble && possessionChanged);
        const isDefensiveTouchdown = isTouchdown && isTurnover && (possessionChanged || type.includes("RETURN"));
        const convertedDown = p.down >= 2 && p.endDown === 1 && p.startTeam && p.startTeam === p.endTeam && !isNoPlay;
        const returnMatches = [...text.matchAll(/\bFOR (-?\d+) YARDS?\b/g)];
        const returnYards = returnMatches.length ? Number(returnMatches.at(-1)[1]) : null;

        return {
            ...p, isNoPlay, isIncomplete, isInterception, isSack, isPass, isPunt,
            isFieldGoalAttempt, isRush, isCompletePass, isPenalty, isDeclined,
            isTouchdown, isFumble, isTurnover, isDefensiveTouchdown, convertedDown,
            returnYards
        };
    }

    /* Section 5: Direct event detection
     * Emit only calibrated catalog events that can be decided from a single play.
     */
    function analyzePlay(play) {
        const p = classifyPlay(play);
        const text = p.upperText;
        const events = new Set();

        if (p.isCompletePass && p.yards >= 20) events.add("PASS 20+ YDS");
        if (p.isCompletePass && p.yards >= 25) events.add("PASS 25+ YDS");
        if (p.isCompletePass && p.yards >= 30) events.add("PASS 30+ YDS");
        if (p.isCompletePass && p.yards >= 40) events.add("PASS 40+ YDS");
        if (p.isRush && p.yards >= 10) events.add("RUN 10+ YDS");
        if (p.isRush && p.yards >= 15) events.add("RUN 15+ YDS");
        if (p.isRush && p.yards >= 25) events.add("RUN 25+ YDS");
        if (p.isRush && p.yards >= 30) events.add("RUN 30+ YDS");
        if (p.isPenalty && /(?:1[0-9]|[2-9][0-9]) YARDS?, ENFORCED/.test(text)) events.add("10+ YARD PENALTY");
        if (p.isPunt && p.endYardsToEndzone >= 81) events.add("PUNT INSIDE THE 20");
        if (p.isPunt && p.returnYards >= 10) events.add("PUNT RETURN 10+ YDS");
        if (text.includes("HOLDING") && !p.isDeclined) events.add("HOLDING");
        if (p.isFumble) events.add("FUMBLE");
        if (p.isTurnover) events.add("TURNOVER");
        if (p.isInterception) events.add("INTERCEPTION");
        if (p.down === 3 && p.distance >= 8 && p.convertedDown) events.add("3RD & 8+ CONVERSION");
        if (p.down === 4 && p.convertedDown) events.add("4TH DOWN CONVERSION");
        if (p.down === 4 && !p.convertedDown && !p.isNoPlay && (p.isPass || p.isRush || p.isSack)) events.add("4TH DOWN STOP");
        if (p.isFieldGoalAttempt && /(?:4[0-9]|[5-9][0-9]) YARD FIELD GOAL IS GOOD/.test(text)) events.add("40+ YARD FIELD GOAL");
        if (p.isFieldGoalAttempt && /(?:5[0-9]|[6-9][0-9]) YARD FIELD GOAL IS GOOD/.test(text)) events.add("50+ YARD FIELD GOAL");
        if (p.isFieldGoalAttempt && !text.includes("EXTRA POINT") && (text.includes("NO GOOD") || text.includes("MISSED"))) events.add("MISSED FG");
        if (p.isTouchdown && p.yards >= 20) events.add("20+ YARD TOUCHDOWN");
        if ((text.includes("PASS INTERFERENCE") || p.upperType.includes("PASS INTERFERENCE")) && !p.isDeclined) events.add("PASS INT");
        if (p.upperType.includes("REVIEW") || text.includes("REVIEW") || text.includes("CHALLENGED") || text.includes("REVERSED")) events.add("REVIEW");
        if (p.isDefensiveTouchdown) events.add("DEFENSIVE TD");
        if ((p.isKick || p.isFieldGoalAttempt) && text.includes("BLOCKED")) events.add("BLOCKED KICK");
        if (/\bSAFETY\b/.test(text) || p.upperType.includes("SAFETY")) events.add("SAFETY");
        if ((text.includes("TWO-POINT") || text.includes("TWO POINT") || p.upperType.includes("TWO-POINT")) && (p.scoringPlay || text.includes("IS GOOD"))) events.add("2-POINT CONVERSION");
        if (p.period > 4) events.add("OVERTIME");

        return Array.from(events);
    }

    /* Section 6: Stateful game tracker
     * Convert sequences, cumulative thresholds, drive outcomes, and score changes into calls.
     */
    function createGameTracker() {
        const counts = new Map();
        const touchdownTeams = new Set();
        const fieldGoalTeams = new Set();
        let completionStreak = 0;
        let rushStreak = 0;
        let driveFirstDowns = 0;
        let lastLeader = null;
        let tieCalled = false;

        function increment(name) {
            const value = (counts.get(name) || 0) + 1;
            counts.set(name, value);
            return value;
        }

        function process(play) {
            const p = classifyPlay(play);
            const events = new Set(analyzePlay(play));
            const isScrimmage = p.down >= 1 && p.down <= 4 && !p.isNoPlay && !p.isPunt && !p.isFieldGoalAttempt;

            if (isScrimmage) {
                completionStreak = p.isCompletePass ? completionStreak + 1 : 0;
                rushStreak = p.isRush ? rushStreak + 1 : 0;
            }
            if (completionStreak >= 3) events.add("3 STRAIGHT COMPLETIONS");
            if (rushStreak >= 3) events.add("3 STRAIGHT RUNS");

            if (p.convertedDown) driveFirstDowns += 1;
            if (p.isPunt) {
                if (p.down === 4 && driveFirstDowns === 0) events.add("THREE AND OUT");
                driveFirstDowns = 0;
            }
            if (p.isTurnover || p.isTouchdown || p.isFieldGoalAttempt) driveFirstDowns = 0;

            if (p.isSack) {
                const sacks = increment("SACK");
                if (sacks >= 2) events.add("2 SACKS TOTAL");
                if (sacks >= 3) events.add("3 SACKS TOTAL");
            }
            if (p.isPenalty && !p.isDeclined && increment("PENALTY") >= 5) events.add("5 PENALTIES TOTAL");
            if (events.has("PASS 20+ YDS") && increment("PASS20") >= 3) events.add("3 PASSES OF 20+ YDS");
            if (events.has("RUN 10+ YDS") && increment("RUN10") >= 3) events.add("3 RUNS OF 10+ YDS");
            if (events.has("PUNT INSIDE THE 20") && increment("PUNT_INSIDE20") >= 2) events.add("2 PUNTS INSIDE THE 20");
            if (p.isTurnover && increment("TURNOVER") >= 2) events.add("2 TURNOVERS TOTAL");
            if (p.isTouchdown && increment("TOUCHDOWN") >= 3) events.add("3 TOUCHDOWNS TOTAL");
            if (p.isFieldGoalAttempt && p.upperText.includes("IS GOOD") && increment("FIELD_GOAL") >= 2) events.add("2 FIELD GOALS TOTAL");

            const scoringTeam = p.isDefensiveTouchdown ? p.endTeam : p.startTeam;
            if (p.isTouchdown && scoringTeam) {
                touchdownTeams.add(scoringTeam);
                if (touchdownTeams.size >= 2) events.add("BOTH TEAMS SCORE TD");
            }
            if (p.isFieldGoalAttempt && p.upperText.includes("IS GOOD") && scoringTeam) {
                fieldGoalTeams.add(scoringTeam);
                if (fieldGoalTeams.size >= 2) events.add("BOTH TEAMS MAKE FG");
            }

            if (p.awayScore !== null && p.homeScore !== null) {
                if (!tieCalled && p.awayScore === p.homeScore && p.awayScore > 0) {
                    events.add("TIE GAME AFTER 0-0");
                    tieCalled = true;
                }
                const leader = p.awayScore === p.homeScore ? null : (p.awayScore > p.homeScore ? "away" : "home");
                if (leader && lastLeader && leader !== lastLeader) events.add("LEAD CHANGE");
                if (leader) lastLeader = leader;
            }

            return Array.from(events).filter(event => ALL_SQUARES.includes(event));
        }

        return Object.freeze({ process });
    }

    /* Section 7: Balanced card generation
     * Select eight events from each measured tier and preserve the free center.
     */
    function createBalancedEvents(random = Math.random, includeFree = true) {
        const selected = [
            ...sample(CATALOG.common, CARD_MIX.common, random),
            ...sample(CATALOG.uncommon, CARD_MIX.uncommon, random),
            ...sample(CATALOG.rare, CARD_MIX.rare, random)
        ];
        shuffle(selected, random);
        if (includeFree) selected.splice(12, 0, "FREE");
        else selected.splice(12, 0, sample(CATALOG.common, 1, random, new Set(selected))[0]);
        return selected;
    }

    function sample(source, count, random, excluded = new Set()) {
        const available = source.filter(item => !excluded.has(item));
        shuffle(available, random);
        if (available.length < count) throw new Error(`Not enough unique squares to choose ${count}.`);
        return available.slice(0, count);
    }

    function shuffle(items, random) {
        for (let index = items.length - 1; index > 0; index -= 1) {
            const target = Math.floor(random() * (index + 1));
            [items[index], items[target]] = [items[target], items[index]];
        }
        return items;
    }

    /* Section 8: Public API
     * Publish the stable browser and test surface for version 25.0.0.
     */
    return Object.freeze({
        version: "25.0.0",
        catalog: CATALOG,
        cardMix: CARD_MIX,
        allSquares: ALL_SQUARES,
        normalizePlay,
        analyzePlay,
        createGameTracker,
        createBalancedEvents
    });
}));
