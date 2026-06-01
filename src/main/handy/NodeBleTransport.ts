import type {BleTransport} from "./HandyBleClient";

type Any = any;

const SCAN_TIMEOUT_MS = 20_000;

export class NodeBleTransport implements BleTransport {
    private destroy?: () => void;
    private device?: Any;
    private cmd?: Any;
    private _connected = false;
    private onDisconnectCb?: () => void;

    get connected(): boolean {
        return this._connected;
    }

    async connect(
        namePrefix: string,
        service: string,
        cmdChar: string,
        notifyChar: string,
        onNotify: (data: Buffer) => void,
        onDisconnect: () => void,
    ): Promise<void> {
        this.onDisconnectCb = onDisconnect;
        const mod: Any = await import("node-ble");
        const createBluetooth = mod.createBluetooth ?? mod.default?.createBluetooth;
        const {bluetooth, destroy} = createBluetooth();
        this.destroy = destroy;

        const adapter = await bluetooth.defaultAdapter();
        if (!(await adapter.isDiscovering())) await adapter.startDiscovery();

        const mac = await this.findDevice(adapter, namePrefix);
        const device = await adapter.getDevice(mac);
        this.device = device;
        device.on?.("disconnect", () => {
            this._connected = false;
            this.onDisconnectCb?.();
        });
        await device.connect();

        const gatt = await device.gatt();
        const svc = await gatt.getPrimaryService(service.toLowerCase());
        const cmd = await svc.getCharacteristic(cmdChar.toLowerCase());
        const notify = await svc.getCharacteristic(notifyChar.toLowerCase());
        this.cmd = cmd;
        notify.on("valuechanged", (buf: Buffer) => onNotify(buf));
        await notify.startNotifications();
        try {
            await adapter.stopDiscovery();
        } catch {}
        this._connected = true;
    }

    async write(data: Buffer): Promise<void> {
        if (!this.cmd || !this._connected) throw new Error("BLE not connected");
        await this.cmd.writeValue(data, {type: "request"});
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        this.onDisconnectCb = undefined;
        try {
            await this.device?.disconnect();
        } catch {}
        try {
            this.destroy?.();
        } catch {}
        this.device = undefined;
        this.cmd = undefined;
    }

    private async findDevice(adapter: Any, namePrefix: string): Promise<string> {
        const deadline = Date.now() + SCAN_TIMEOUT_MS;
        const deviceCache = new Map<string, Any>();
        while (Date.now() < deadline) {
            const macs: string[] = await adapter.devices();
            for (const mac of macs) {
                try {
                    let d = deviceCache.get(mac);
                    if (!d) {
                        d = await adapter.getDevice(mac);
                        deviceCache.set(mac, d);
                    }
                    const name: string = await d.getName();
                    if (typeof name === "string" && name.startsWith(namePrefix)) return mac;
                } catch {}
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("Handy not found over Bluetooth (is it on and in Bluetooth mode?)");
    }
}
