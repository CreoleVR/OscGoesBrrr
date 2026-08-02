import got, {HTTPError, RequestError} from "got";
import type {BaseResponse, IHandyClient, SliderState} from "./IHandyClient";

export type {BaseResponse, HandyError, SliderState} from "./IHandyClient";

const BASE_URI = "https://www.handyfeeling.com/api/handy-rest/v3/";
const DEVICE_CONNECTION_KEY_HEADER = "X-Connection-Key";
const APPLICATION_ID_KEY_HEADER = "X-Api-Key";
const REQUEST_TIMEOUT_MS = 5000;

export interface ConnectionStatusResult {
    connected: boolean;
}

export class HandyClient implements IHandyClient {
    constructor(
        private readonly connectionKey: string,
        private readonly applicationId: string,
    ) {}

    async isConnected(): Promise<boolean> {
        const response = await this.request<ConnectionStatusResult>('GET', 'connected');
        if (response.error || !response.result) return false;
        return response.result.connected === true;
    }

    async hdspXpt(xp: number, t: number, stopOnTarget: boolean, immediateRsp: boolean): Promise<BaseResponse<unknown>> {
        return await this.request<unknown>('PUT', 'hdsp/xpt', {
            xp,
            t,
            stop_on_target: stopOnTarget,
            immediate_rsp: immediateRsp,
        });
    }

    async getSliderState(): Promise<SliderState | undefined> {
        const response = await this.request<SliderState>('GET', 'slider/state');
        if (response.error || !response.result) return undefined;
        return response.result;
    }

    async setSliderStroke(min?: number, max?: number): Promise<BaseResponse<unknown> | undefined> {
        const body: Record<string, number> = {};
        if (min !== undefined) body['min'] = min;
        if (max !== undefined) body['max'] = max;
        if (Object.keys(body).length === 0) return undefined;
        return await this.request<unknown>('PUT', 'slider/stroke', body);
    }

    private async request<T>(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<BaseResponse<T>> {
        try {
            const response = await got(BASE_URI + path, {
                method,
                headers: {
                    accept: 'application/json',
                    [DEVICE_CONNECTION_KEY_HEADER]: this.connectionKey,
                    [APPLICATION_ID_KEY_HEADER]: this.applicationId,
                    ...(body !== undefined ? {'content-type': 'application/json'} : {}),
                },
                ...(body !== undefined ? {json: body} : {}),
                timeout: {request: REQUEST_TIMEOUT_MS},
                retry: {limit: 0},
                http2: false,
            }).json<BaseResponse<T>>();
            return response ?? {};
        } catch (e) {
            if (e instanceof HTTPError) {
                const body = e.response.body;
                if (typeof body === 'string') {
                    try {
                        const parsed = JSON.parse(body) as BaseResponse<T>;
                        return parsed;
                    } catch {}
                }
                return {error: {message: `HTTP ${e.response.statusCode}`}};
            }
            if (e instanceof RequestError) {
                return {error: {message: e.message, code: -1}};
            }
            throw e;
        }
    }
}
