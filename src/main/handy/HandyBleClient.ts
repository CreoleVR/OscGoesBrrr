import type {BaseResponse, IHandyClient, SliderState} from "./IHandyClient";

export const HANDY_BLE = {
    namePrefix: "OHD_",
    service: "77834d26-40f7-11ee-be56-0242ac120002",
    cmdChar: "77835032-40f7-11ee-be56-0242ac120002",
    notifyChar: "77835410-40f7-11ee-be56-0242ac120002",
} as const;

const MessageType = {REQUEST: 1, REQUESTS: 2, RESPONSE: 3, NOTIFICATION: 4} as const;
const Mode = {HDSP: 2} as const;
const ReqField = {modeSet: 701, hdspXpTSet: 744} as const;

export function varint(n: number): number[] {
    const out: number[] = [];
    n >>>= 0;
    while (true) {
        const b = n & 0x7f;
        n >>>= 7;
        out.push(n ? b | 0x80 : b);
        if (!n) return out;
    }
}
export function tag(field: number, wire: number): number[] {
    return varint((field << 3) | wire);
}
export function fVarint(field: number, value: number): number[] {
    return [...tag(field, 0), ...varint(value)];
}
export function fBool(field: number, value: boolean): number[] {
    return [...tag(field, 0), value ? 1 : 0];
}
export function fFloat(field: number, value: number): number[] {
    const b = Buffer.alloc(4);
    b.writeFloatLE(value, 0);
    return [...tag(field, 5), ...b];
}
export function fMsg(field: number, data: number[]): number[] {
    return [...tag(field, 2), ...varint(data.length), ...data];
}

export interface DecodedField {
    field: number;
    type: "V" | "S" | "M" | "F32" | "raw";
    value: number | string | DecodedField[];
}
export function decodeProtobuf(buf: Buffer): DecodedField[] {
    const out: DecodedField[] = [];
    let i = 0;
    const readVarint = (): number => {
        let shift = 0, val = 0;
        while (i < buf.length) {
            const x = buf[i++]!;
            val |= (x & 0x7f) << shift;
            if (!(x & 0x80)) break;
            shift += 7;
        }
        return val >>> 0;
    };
    while (i < buf.length) {
        const t = readVarint();
        const field = t >>> 3, wire = t & 7;
        if (wire === 0) {
            out.push({field, type: "V", value: readVarint()});
        } else if (wire === 5) {
            out.push({field, type: "F32", value: buf.readFloatLE(i)}); i += 4;
        } else if (wire === 2) {
            const len = readVarint();
            const chunk = buf.subarray(i, i + len); i += len;
            const printable = chunk.length > 0 && chunk.every(c => c >= 32 && c < 127);
            if (printable) out.push({field, type: "S", value: chunk.toString("utf8")});
            else {
                const sub = decodeProtobuf(chunk);
                out.push(sub.length ? {field, type: "M", value: sub} : {field, type: "raw", value: chunk.toString("hex")});
            }
        } else {
            break;
        }
    }
    return out;
}

function rpcMessage(request: number[]): Buffer {
    return Buffer.from([...fVarint(1, MessageType.REQUEST), ...fMsg(2, request)]);
}
function buildModeSetFrame(id: number, mode: number): Buffer {
    const modeSet = fVarint(1, mode);
    const request = [...fVarint(2, id), ...fMsg(ReqField.modeSet, modeSet)];
    return rpcMessage(request);
}
export function buildHdspXptFrame(id: number, xp: number, t: number, stopOnTarget: boolean): Buffer {
    const inner = [...fFloat(1, xp), ...fVarint(2, Math.round(t)), ...fBool(3, stopOnTarget)];
    const request = [...fVarint(2, id), ...fMsg(ReqField.hdspXpTSet, inner)];
    return rpcMessage(request);
}

export interface BleTransport {
    connect(namePrefix: string, service: string, cmdChar: string, notifyChar: string,
            onNotify: (data: Buffer) => void, onDisconnect: () => void): Promise<void>;
    write(data: Buffer): Promise<void>;
    disconnect(): Promise<void>;
    readonly connected: boolean;
}

let transportFactory: (() => BleTransport) | undefined;
export function registerBleTransport(factory: () => BleTransport): void {
    transportFactory = factory;
}

export class HandyBleClient implements IHandyClient {
    private transport?: BleTransport;
    private readonly pending = new Map<number, {resolve: (r: BaseResponse<unknown>) => void; timer: ReturnType<typeof setTimeout>}>();

    constructor(_connectionKey?: string) {}

    async connect(onConnectionLost?: () => void): Promise<void> {
        if (!transportFactory) {
            throw new Error("No BLE backend registered (registerBleTransport must be called at startup).");
        }
        this.transport = transportFactory();
        await this.transport.connect(
            HANDY_BLE.namePrefix, HANDY_BLE.service, HANDY_BLE.cmdChar, HANDY_BLE.notifyChar,
            (data) => this.onNotify(data),
            () => { if (onConnectionLost) onConnectionLost(); },
        );
        await this.send(buildModeSetFrame(this.newId(), Mode.HDSP), 2000);
    }

    async isConnected(): Promise<boolean> {
        return this.transport?.connected === true;
    }

    async hdspXpt(xp: number, t: number, stopOnTarget: boolean, _immediateRsp: boolean): Promise<BaseResponse<unknown>> {
        try {
            return await this.send(buildHdspXptFrame(this.newId(), xp, t, stopOnTarget));
        } catch (e) {
            return {error: {message: e instanceof Error ? e.message : String(e), code: -1}};
        }
    }

    async getSliderState(): Promise<SliderState | undefined> {
        return undefined;
    }
    async setSliderStroke(_min?: number, _max?: number): Promise<BaseResponse<unknown> | undefined> {
        return undefined;
    }

    async shutdown(): Promise<void> {
        for (const {timer} of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
        await this.transport?.disconnect().catch(() => undefined);
        this.transport = undefined;
    }

    private newId(): number {
        return 1 + Math.floor(Math.random() * 0xfffffffe);
    }

    private onNotify(data: Buffer): void {
        const msg = decodeProtobuf(data);
        const type = msg.find(f => f.field === 1 && f.type === "V")?.value as number | undefined;
        if (type !== MessageType.RESPONSE) return;
        const response = msg.find(f => f.field === 4 && f.type === "M")?.value as DecodedField[] | undefined;
        if (!response) return;
        const id = response.find(f => f.field === 1 && f.type === "V")?.value as number | undefined;
        if (id === undefined) return;
        const waiter = this.pending.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(id);
        const errMsg = response.find(f => f.field === 2);
        if (errMsg) {
            let message = "device error";
            const walk = (fs: DecodedField[]) => fs.forEach(f => {
                if (f.type === "S") message = f.value as string;
                else if (f.type === "M") walk(f.value as DecodedField[]);
            });
            if (errMsg.type === "M") walk(errMsg.value as DecodedField[]);
            waiter.resolve({error: {message}});
        } else {
            waiter.resolve({result: response});
        }
    }

    private send(frame: Buffer, timeoutMs = 800): Promise<BaseResponse<unknown>> {
        if (!this.transport?.connected) return Promise.reject(new Error("BLE not connected"));
        const id = decodeRequestId(frame);
        return new Promise<BaseResponse<unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (id !== undefined) this.pending.delete(id);
                resolve({error: {message: "BLE response timeout", code: -1}});
            }, timeoutMs);
            if (id !== undefined) this.pending.set(id, {resolve, timer});
            this.transport!.write(frame).catch((e) => {
                clearTimeout(timer);
                if (id !== undefined) this.pending.delete(id);
                reject(e instanceof Error ? e : new Error(String(e)));
            });
        });
    }
}

function decodeRequestId(frame: Buffer): number | undefined {
    const top = decodeProtobuf(frame);
    const request = top.find(f => f.field === 2 && f.type === "M")?.value as DecodedField[] | undefined;
    return request?.find(f => f.field === 2 && f.type === "V")?.value as number | undefined;
}
