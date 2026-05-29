import {Service} from "typedi";
import ConfigService from "../services/ConfigService";
import LoggerService, {SubLogger} from "../services/LoggerService";
import BackendDataService from "../services/BackendDataService";
import TypedEventEmitter from "../../common/TypedEventEmitter";
import clamp from "../../common/clamp";
import type {DeviceFeature} from "../Buttplug";
import type {ButtplugFeatureInformation, ButtplugInt32, ButtplugUInt32, Device, IntifaceDeviceFeatureSelection} from "../ButtplugSpec";
import {Result} from "../../common/result";
import {HandyDiagnosticResult} from "../../common/ipcContract";
import {HandyClient} from "./HandyClient";
import {runHandyDiagnostic} from "./HandyDiagnostics";

export const HANDY_FEATURE_ID = 'handy';

const SEND_TICK_MS = 16;
const IDLE_TICK_MS = 33;
const IDLE_STOP_MS = 200;
const POSITION_DEAD_ZONE = 1;
const SETTLE_DELTA = 6;
const MIN_MOVE_MS = 16;
const MAX_MOVE_MS = 150;

type HandyEvents = {
    addFeature: (device: DeviceFeature) => void,
    removeFeature: (device: DeviceFeature) => void,
};

@Service()
export default class Handy extends TypedEventEmitter<HandyEvents> {
    private readonly logger: SubLogger;
    private connectionGeneration = 0;
    private currentFeature?: HandyDeviceFeature;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private connecting = false;
    private connected = false;
    private lastConnectionKey?: string;
    private lastApplicationId?: string;
    private lastEnabled = false;

    constructor(
        private readonly configService: ConfigService,
        private readonly backendDataService: BackendDataService,
        loggerService: LoggerService,
    ) {
        super();
        this.logger = loggerService.get('handy');
        const initial = this.configService.getCached();
        this.lastConnectionKey = initial.handyConnectionKey;
        this.lastApplicationId = initial.handyApplicationId;
        this.lastEnabled = initial.handyEnabled === true;
        this.configService.on('changed', (next) => {
            const nextEnabled = next.handyEnabled === true;
            if (next.handyConnectionKey !== this.lastConnectionKey
                || next.handyApplicationId !== this.lastApplicationId
                || nextEnabled !== this.lastEnabled) {
                this.lastConnectionKey = next.handyConnectionKey;
                this.lastApplicationId = next.handyApplicationId;
                this.lastEnabled = nextEnabled;
                this.requestReconnect(0);
            }
        });
        if (this.lastEnabled) this.requestReconnect(0);
    }

    isConnected(): boolean {
        return this.connected;
    }

    async runDiagnostic(): Promise<Result<HandyDiagnosticResult>> {
        const feature = this.currentFeature;
        if (!this.connected || !feature) {
            return {ok: false, error: 'Handy is not connected.'};
        }
        if (feature.diagnosticRunning) {
            return {ok: false, error: 'A diagnostic is already running.'};
        }
        feature.diagnosticRunning = true;
        this.logger.log('Running diagnostic...');
        try {
            const result = await runHandyDiagnostic(feature.client);
            this.logger.log(`Diagnostic done: latency=${result.latencyMs}ms, accuracyRms=${result.accuracyRms}, overshoot=${result.overshoot}`);
            return {ok: true, data: result};
        } catch (e) {
            this.logger.log('Diagnostic failed:', e);
            return {ok: false, error: e instanceof Error ? e.message : String(e)};
        } finally {
            feature.diagnosticRunning = false;
        }
    }

    private clearRetryTimer() {
        if (this.retryTimer !== undefined) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
    }

    private requestReconnect(delayMs: number) {
        this.connectionGeneration++;
        const generation = this.connectionGeneration;
        this.clearRetryTimer();
        this.teardownFeature();
        this.connected = false;
        if (delayMs > 0) {
            this.logger.log(`retrying shortly (${delayMs}ms)`);
        }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.connect(generation);
        }, delayMs);
    }

    private scheduleRetry(generation: number, delayMs: number) {
        if (generation !== this.connectionGeneration) return;
        this.teardownFeature();
        this.connected = false;
        this.clearRetryTimer();
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.connect(generation);
        }, delayMs);
    }

    private teardownFeature() {
        if (this.currentFeature) {
            const feature = this.currentFeature;
            this.currentFeature = undefined;
            this.emit('removeFeature', feature);
            void feature.shutdown().catch(() => undefined);
        }
    }

    private async connect(generation: number) {
        if (generation !== this.connectionGeneration) return;
        if (this.connecting) return;
        const config = this.configService.getCached();
        if (config.handyEnabled !== true) return;
        const connectionKey = (config.handyConnectionKey ?? '').trim();
        const applicationId = (config.handyApplicationId ?? '').trim();
        if (!connectionKey || !applicationId) return;
        this.connecting = true;
        try {
            const client = new HandyClient(connectionKey, applicationId);

            this.logger.log('Checking connection ...');
            const connected = await client.isConnected();
            if (generation !== this.connectionGeneration) return;
            if (!connected) {
                this.logger.log('Handy not connected. Will retry.');
                this.scheduleRetry(generation, 5000);
                return;
            }

            const test = await client.hdspXpt(0.1, 1000, true, false);
            if (generation !== this.connectionGeneration) return;
            if (test.error) {
                const hint = test.error.code === 1001
                    ? ' Make sure it is on firmware 4, online, and the connection key is correct.'
                    : '';
                this.logger.log(`Failed to send HDSP command to device: ${test.error.message ?? ''}${hint}`);
                this.scheduleRetry(generation, 5000);
                return;
            }

            this.connected = true;
            const feature = new HandyDeviceFeature(HANDY_FEATURE_ID, client, this.logger);
            this.currentFeature = feature;
            void this.backendDataService
                .updateDeviceHistory(feature.id, feature.intiface)
                .catch(e => this.logger.log('Failed to update Handy history', e));
            this.logger.log('Handy connected.');
            this.emit('addFeature', feature);
            feature.startSendLoop(generation, () => this.connectionGeneration);
        } catch (e) {
            this.logger.log('Connection error:', e);
            if (generation === this.connectionGeneration) {
                this.scheduleRetry(generation, 5000);
            }
        } finally {
            this.connecting = false;
        }
    }
}

export class HandyDeviceFeature implements DeviceFeature {
    readonly id: string;
    readonly type = 'linear' as const;
    readonly intiface: IntifaceDeviceFeatureSelection;
    lastLevel = 0;
    diagnosticRunning = false;

    private currentX = -1;
    private lastSentX = -1;
    private lastInputTime = 0;
    private lastSendTime = 0;
    private isSending = false;
    private movementStopped = false;
    private shutdownRequested = false;
    private sendTimer?: ReturnType<typeof setTimeout>;

    constructor(
        id: string,
        readonly client: HandyClient,
        private readonly logger: SubLogger,
    ) {
        this.id = id;
        this.intiface = buildHandyIntifaceSelection();
    }

    setLevel(level: number, _duration = 0): void {
        if (this.shutdownRequested) return;
        const safe = clamp(level, 0, 1);
        this.lastLevel = safe;
        const x = Math.round(safe * 100);
        this.lastInputTime = Date.now();
        if (this.movementStopped && this.lastSentX >= 0 && Math.abs(x - this.lastSentX) < POSITION_DEAD_ZONE) {
            return;
        }
        this.currentX = x;
        this.movementStopped = false;
    }

    startSendLoop(generation: number, getCurrentGeneration: () => number) {
        const tick = async () => {
            if (this.shutdownRequested) return;
            if (generation !== getCurrentGeneration()) return;
            try {
                await this.sendOnce();
            } catch (e) {
                this.logger.log('send exception', e);
            }
            if (this.shutdownRequested) return;
            if (generation !== getCurrentGeneration()) return;
            const delay = this.movementStopped ? IDLE_TICK_MS : SEND_TICK_MS;
            this.sendTimer = setTimeout(() => { void tick(); }, delay);
        };
        void tick();
    }

    private async sendOnce(): Promise<void> {
        if (this.diagnosticRunning) return;
        if (this.currentX < 0 || this.isSending) return;

        if (this.lastInputTime > 0 && Date.now() - this.lastInputTime > IDLE_STOP_MS) {
            await this.stopMovement();
            return;
        }
        if (this.lastSentX >= 0 && Math.abs(this.currentX - this.lastSentX) < POSITION_DEAD_ZONE) {
            await this.stopMovement();
            return;
        }

        const now = Date.now();
        if (this.lastSendTime > 0 && now - this.lastSendTime < SEND_TICK_MS) return;

        this.isSending = true;
        const x = this.currentX;
        const stopOnTarget = Math.abs(x - this.lastSentX) < SETTLE_DELTA;
        const t = this.lastSendTime > 0
            ? clamp(now - this.lastSendTime, MIN_MOVE_MS, MAX_MOVE_MS)
            : MIN_MOVE_MS * 2;
        this.lastSentX = x;
        this.lastSendTime = now;
        try {
            const response = await this.client.hdspXpt(x / 100, t, stopOnTarget, true);
            if (response.error) {
                this.logger.log('hdspXpt error:', response.error.message);
            }
        } finally {
            this.isSending = false;
        }
    }

    private async stopMovement(): Promise<void> {
        if (this.movementStopped || this.lastSentX < 0 || this.isSending) return;
        this.movementStopped = true;
        this.isSending = true;
        try {
            await this.client.hdspXpt(this.lastSentX / 100, 0, true, true);
        } catch {
        } finally {
            this.isSending = false;
        }
    }

    async shutdown(): Promise<void> {
        this.shutdownRequested = true;
        if (this.sendTimer !== undefined) {
            clearTimeout(this.sendTimer);
            this.sendTimer = undefined;
        }
        if (this.lastSentX < 0) return;
        try {
            await this.client.hdspXpt(this.lastSentX / 100, 0, true, true);
        } catch {
        }
    }
}

function buildHandyIntifaceSelection(): IntifaceDeviceFeatureSelection {
    const range: [ButtplugInt32, ButtplugInt32] = [0 as ButtplugInt32, 100 as ButtplugInt32];
    const feature: ButtplugFeatureInformation = {
        FeatureIndex: 0 as ButtplugUInt32,
        FeatureDescription: 'Stroker',
        Output: {Position: {Value: range}},
    };
    const device: Device = {
        DeviceIndex: 0 as ButtplugUInt32,
        DeviceName: 'The Handy',
        DeviceDisplayName: 'The Handy',
        DeviceFeatures: {'0': feature},
    };
    return {
        device,
        feature,
        selectedOutput: 'Position',
    };
}
