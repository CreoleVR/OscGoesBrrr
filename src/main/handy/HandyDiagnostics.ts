import {HandyClient} from "./HandyClient";
import {HandyDiagnosticResult} from "../../common/ipcContract";

interface Sample {
    t: number;
    x: number;
}

const SEND_INTERVAL_MS = 100;
const FEED_INTERVAL_MS = 30;
const POLL_INTERVAL_MS = 75;
const SETTLE_MS = 1000;
const WARMUP_MS = 1000;

const STROKE_BOTTOM = 15;
const STROKE_TOP = 85;
const STROKE_MID = (STROKE_TOP + STROKE_BOTTOM) / 2;
const STROKE_AMP = (STROKE_TOP - STROKE_BOTTOM) / 2;

const STROKE_PERIODS = [900, 700, 550, 450, 350];
const PHASE_MS = 2400;

function patternAt(elapsed: number): number | null {
    let phaseStart = 0;
    for (const period of STROKE_PERIODS) {
        if (elapsed < phaseStart + PHASE_MS) {
            const local = elapsed - phaseStart;
            return STROKE_MID - STROKE_AMP * Math.cos((2 * Math.PI * local) / period);
        }
        phaseStart += PHASE_MS;
    }
    return null;
}

const PATTERN_DURATION_MS = STROKE_PERIODS.length * PHASE_MS;

function interpolate(samples: Sample[], t: number): number | null {
    if (samples.length === 0) return null;
    if (t <= samples[0]!.t) return samples[0]!.x;
    const last = samples[samples.length - 1]!;
    if (t >= last.t) return last.x;
    for (let i = 1; i < samples.length; i++) {
        const c = samples[i]!;
        if (c.t >= t) {
            const p = samples[i - 1]!;
            return p.x + ((c.x - p.x) * (t - p.t)) / (c.t - p.t);
        }
    }
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

export async function runHandyDiagnostic(client: HandyClient): Promise<HandyDiagnosticResult> {
    const sentPoints: Sample[] = [];
    const actualPoints: Sample[] = [];
    const start = Date.now();

    const feed = (async () => {
        let lastSend = -SEND_INTERVAL_MS;
        let lastSentX = -1;
        while (true) {
            const elapsed = Date.now() - start;
            const x = patternAt(elapsed);
            if (x === null) break;
            sentPoints.push({t: elapsed, x});
            if (elapsed - lastSend >= SEND_INTERVAL_MS && Math.round(x) !== lastSentX) {
                lastSend = elapsed;
                lastSentX = Math.round(x);
                void client.hdspXpt(x / 100, SEND_INTERVAL_MS, false, true);
            }
            await sleep(FEED_INTERVAL_MS);
        }
    })();

    const poll = (async () => {
        while (Date.now() - start < PATTERN_DURATION_MS + SETTLE_MS) {
            const pollStart = Date.now();
            const state = await client.getSliderState();
            if (state) {
                const x = Math.max(0, Math.min(1, state.position)) * 100;
                actualPoints.push({t: Date.now() - start, x});
            }
            const wait = POLL_INTERVAL_MS - (Date.now() - pollStart);
            if (wait > 0) await sleep(wait);
        }
    })();

    await Promise.all([feed, poll]);

    void client.hdspXpt(STROKE_BOTTOM / 100, SEND_INTERVAL_MS, true, true);

    return computeResult(sentPoints, actualPoints);
}

function computeResult(sent: Sample[], actual: Sample[]): HandyDiagnosticResult {
    const sentSteady = sent.filter(p => p.t >= WARMUP_MS);
    const actualSteady = actual.filter(p => p.t >= WARMUP_MS);
    if (sentSteady.length === 0 || actualSteady.length < 2) {
        return {latencyMs: 0, accuracyRms: 0, overshoot: 0};
    }

    let bestLag = 0;
    let bestRms = Infinity;
    for (let lag = 0; lag <= 1000; lag += 10) {
        let sumSq = 0;
        let count = 0;
        for (const a of actualSteady) {
            const s = interpolate(sentSteady, a.t - lag);
            if (s === null) continue;
            sumSq += (a.x - s) ** 2;
            count++;
        }
        if (count > 0) {
            const rms = Math.sqrt(sumSq / count);
            if (rms < bestRms) {
                bestRms = rms;
                bestLag = lag;
            }
        }
    }

    let sumSq = 0;
    let count = 0;
    for (const a of actualSteady) {
        const s = interpolate(sentSteady, a.t - bestLag);
        if (s === null) continue;
        sumSq += (a.x - s) ** 2;
        count++;
    }
    const accuracyRms = count > 0 ? Math.sqrt(sumSq / count) : 0;

    let maxActual = -Infinity;
    let minActual = Infinity;
    for (const a of actualSteady) {
        if (a.x > maxActual) maxActual = a.x;
        if (a.x < minActual) minActual = a.x;
    }
    const overTop = Math.max(0, maxActual - STROKE_TOP);
    const overBottom = Math.max(0, STROKE_BOTTOM - minActual);
    const overshoot = Math.max(overTop, overBottom);

    return {
        latencyMs: bestLag,
        accuracyRms: Math.round(accuracyRms * 100) / 100,
        overshoot: Math.round(overshoot * 100) / 100,
    };
}
