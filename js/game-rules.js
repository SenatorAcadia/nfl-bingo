/*
 * Filename: js/game-rules.js
 * Purpose: Define, detect, and balance NFL BEANO square events independently of the feed provider.
 * Version: 24.1.0
 */

/* Section 1: Module wrapper
 * Expose the rules in browsers and Node.js tests without requiring a build step.
 */
(function exposeGameRules(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.BeanoRules = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createGameRules() {
    "use strict";

    /* Section 2: Square catalog
     * Keep frequent squares dominant so a multiplayer game has a strong chance of producing a winner.
     */
    const CATALOG = Object.freeze({
        common: Object.freeze([
            "ANY RUSH", "COMPLETE PASS", "INC. PASS", "1ST DOWN",
            "3RD DOWN PLAY", "PUNT", "KICKOFF", "TOUCHBACK",
            "TIMEOUT", "PENALTY FLAG", "SHOTGUN", "RUN 1-4 YDS",
            "RUN 5-9 YDS", "PASS 1-4 YDS", "PASS 5-9 YDS",
            "PASS 10+ YDS", "RED ZONE PLAY", "TFL"
        ]),
        uncommon: Object.freeze([
            "RUN 10+ YDS", "PASS 20+ YDS", "RETURN 10+ YDS", "HOLDING",
            "PASS INT", "TOUCHDOWN", "FIELD GOAL", "INTERCEPTION",
            "FUMBLE", "TURNOVER", "QB SACK", "4TH DOWN PLAY",
            "REVIEW", "MISSED FG"
        ]),
        rare: Object.freeze([
            "RUN 25+ YDS", "PASS 35+ YDS", "RETURN 30+ YDS",
            "DEFENSIVE TD", "SAFETY", "BLOCKED KICK",
            "2-POINT CONVERSION", "OVERTIME"
        ])
    });

    const CARD_MIX = Object.freeze({ common: 16, uncommon: 6, rare: 2 });
    const ALL_SQUARES = Object.freeze(Object.values(CATALOG).flat());

    /* Section 3: Feed normalization
     * Convert ESPN-like play objects and future provider adapters into one stable shape.
     */
    function normalizePlay(play) {
        const source = typeof play === "string" ? { text: play } : (play || {});
        const text = String(source.text || source.description || "");
        const type = String(source.type?.text || source.type || "");
        const yards = firstFiniteNumber(source.statYardage, source.yardsGained, source.yards);
        const period = firstFiniteNumber(source.period?.number, source.period);
        const down = firstFiniteNumber(source.start?.down, source.down);
        const yardsToEndzone = firstFiniteNumber(
            source.start?.yardsToEndzone,
            source.start?.yardsToEndZone,
            source.yardsToEndzone
        );
        const startTeam = String(source.start?.team?.id || source.possessionTeamId || "");
        const endTeam = String(source.end?.team?.id || source.endPossessionTeamId || "");

        return {
            id: String(source.id || source.playId || ""),
            text,
            upperText: text.toUpperCase(),
            upperType: type.toUpperCase(),
            yards,
            period,
            down,
            yardsToEndzone,
            startTeam,
            endTeam,
            scoringPlay: Boolean(source.scoringPlay || source.isScoringPlay),
            scoreValue: firstFiniteNumber(source.scoreValue)
        };
    }

    function firstFiniteNumber(...values) {
        for (const value of values) {
            const number = Number(value);
            if (value !== null && value !== "" && Number.isFinite(number)) return number;
        }
        return null;
    }

    /* Section 4: Event detection
     * Detect only events with an explainable rule and cap overlapping yardage buckets.
     */
    function analyzePlay(play) {
        const p = normalizePlay(play);
        const text = p.upperText;
        const type = p.upperType;
        const events = new Set();

        const isIncomplete = type.includes("INCOMPLETE") || text.includes("INCOMPLETE");
        const isInterception = type.includes("INTERCEPT") || text.includes("INTERCEPT");
        const isSack = type.includes("SACK") || /\bSACKED\b|\bSACK\b/.test(text);
        const isPass = !isSack && (
            type.includes("PASS") || text.includes(" PASS ") || text.includes("COMPLETE TO") || isIncomplete
        );
        const isKick = type.includes("KICK") || type.includes("PUNT") || /\bKICKS?\b|\bPUNTS?\b/.test(text);
        const isRush = !isPass && !isKick && !isSack && (
            type.includes("RUSH") || type.includes("RUN") || /\bLEFT (END|TACKLE|GUARD)\b|\bRIGHT (END|TACKLE|GUARD)\b|\bUP THE MIDDLE\b/.test(text)
        );
        const isCompletePass = isPass && !isIncomplete && !isInterception;
        const isPunt = type.includes("PUNT") || /\bPUNTS?\b/.test(text);
        const isKickoff = type.includes("KICKOFF") || text.includes("KICKS OFF");
        const isReturn = type.includes("RETURN") || /\bRETURN(?:ED|S)?\b/.test(text);
        const isFieldGoalAttempt = type.includes("FIELD GOAL") || text.includes("FIELD GOAL");
        const isNoGood = text.includes("NO GOOD") || text.includes("MISSED");
        const isPenalty = (type.includes("PENALTY") || text.includes("PENALTY") || text.includes("FLAG")) && !text.includes("NO PLAY, NO PENALTY");
        const isDeclined = text.includes("DECLINED") || text.includes("OFFSET");
        const isTouchdown = p.scoringPlay && p.scoreValue === 6 || text.includes("TOUCHDOWN");
        const possessionChanged = Boolean(p.startTeam && p.endTeam && p.startTeam !== p.endTeam);
        const isFumble = type.includes("FUMBLE") || text.includes("FUMBLE");
        const isDefensiveTouchdown = isTouchdown && (isInterception || isFumble) && (possessionChanged || type.includes("RETURN"));

        if (isRush) events.add("ANY RUSH");
        if (isCompletePass) events.add("COMPLETE PASS");
        if (isIncomplete) events.add("INC. PASS");
        if (/\b1ST DOWN\b/.test(text) || text.includes("AUTOMATIC FIRST DOWN") || (p.down && p.down > 1 && play?.end?.down === 1)) events.add("1ST DOWN");
        if (p.down === 3) events.add("3RD DOWN PLAY");
        if (p.down === 4) events.add("4TH DOWN PLAY");
        if (isPunt) events.add("PUNT");
        if (isKickoff) events.add("KICKOFF");
        if (text.includes("TOUCHBACK")) events.add("TOUCHBACK");
        if (type.includes("TIMEOUT") || text.includes("TIMEOUT")) events.add("TIMEOUT");
        if (isPenalty) events.add("PENALTY FLAG");
        if (text.includes("SHOTGUN")) events.add("SHOTGUN");
        if (p.yardsToEndzone !== null && p.yardsToEndzone <= 20) events.add("RED ZONE PLAY");
        if ((isRush && p.yards !== null && p.yards < 0) || text.includes("TACKLED FOR LOSS") || text.includes("LOSS OF")) events.add("TFL");
        if (isSack) events.add("QB SACK");

        addYardageEvents(events, p.yards, { isRush, isCompletePass, isKick, isReturn });

        if (text.includes("HOLDING") && !isDeclined) events.add("HOLDING");
        if ((text.includes("PASS INTERFERENCE") || type.includes("PASS INTERFERENCE")) && !isDeclined) events.add("PASS INT");
        if (isTouchdown) events.add("TOUCHDOWN");
        if (isFieldGoalAttempt && !isNoGood && (p.scoringPlay || text.includes("IS GOOD"))) events.add("FIELD GOAL");
        if (isFieldGoalAttempt && isNoGood) events.add("MISSED FG");
        if (isInterception) {
            events.add("INTERCEPTION");
            events.add("TURNOVER");
        }
        if (isFumble) events.add("FUMBLE");
        if (isFumble && possessionChanged) events.add("TURNOVER");
        if (type.includes("REVIEW") || text.includes("REVIEW") || text.includes("REVERSED")) events.add("REVIEW");
        if (type.includes("SAFETY") || /\bSAFETY\b/.test(text)) events.add("SAFETY");
        if ((isKick || isFieldGoalAttempt) && text.includes("BLOCKED")) events.add("BLOCKED KICK");
        if (isDefensiveTouchdown) events.add("DEFENSIVE TD");
        if ((type.includes("TWO-POINT") || type.includes("TWO POINT") || text.includes("TWO-POINT") || text.includes("TWO POINT")) && (p.scoringPlay || text.includes("CONVERSION IS GOOD"))) events.add("2-POINT CONVERSION");
        if (p.period !== null && p.period > 4) events.add("OVERTIME");

        return Array.from(events);
    }

    function addYardageEvents(events, yards, flags) {
        if (yards === null || yards < 1) return;
        if (flags.isRush) {
            if (yards <= 4) events.add("RUN 1-4 YDS");
            else if (yards <= 9) events.add("RUN 5-9 YDS");
            else events.add("RUN 10+ YDS");
            if (yards >= 25) events.add("RUN 25+ YDS");
        }
        if (flags.isCompletePass) {
            if (yards <= 4) events.add("PASS 1-4 YDS");
            else if (yards <= 9) events.add("PASS 5-9 YDS");
            else events.add("PASS 10+ YDS");
            if (yards >= 20) events.add("PASS 20+ YDS");
            if (yards >= 35) events.add("PASS 35+ YDS");
        }
        if (flags.isKick && flags.isReturn) {
            if (yards >= 10) events.add("RETURN 10+ YDS");
            if (yards >= 30) events.add("RETURN 30+ YDS");
        }
    }

    /* Section 5: Balanced card generation
     * Produce 24 unique events with only two rare squares and a centered free space.
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

    /* Section 6: Public API
     * Publish the small stable surface consumed by the game and automated tests.
     */
    return Object.freeze({
        version: "24.1.0",
        catalog: CATALOG,
        cardMix: CARD_MIX,
        allSquares: ALL_SQUARES,
        normalizePlay,
        analyzePlay,
        createBalancedEvents
    });
}));
