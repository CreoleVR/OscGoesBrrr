import {withBindings} from "@stoprocent/noble";
import type {Characteristic, Noble, Peripheral} from "@stoprocent/noble";
import type {BleTransport} from "./HandyBleClient";

const SCAN_TIMEOUT_MS = 20_000;

function normalizeUuid(uuid: string): string {
    return uuid.replaceAll("-", "").toLowerCase();
}

export class WindowsBleTransport implements BleTransport {
    private noble?: Noble;
    private peripheral?: Peripheral;
    private cmd?: Characteristic;
    private notify?: Characteristic;
    private notifyListener?: (data: Buffer, isNotification: boolean) => void;
    private disconnectListener?: () => void;
    private _connected = false;

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
        const noble = withBindings("win");
        this.noble = noble;
        await noble.waitForPoweredOnAsync(5000);

        const peripheral = await this.findDevice(noble, namePrefix);
        this.peripheral = peripheral;
        this.disconnectListener = () => {
            const wasConnected = this._connected;
            this._connected = false;
            if (wasConnected) onDisconnect();
        };
        peripheral.on("disconnect", this.disconnectListener);
        await peripheral.connectAsync();

        const serviceUuid = normalizeUuid(service);
        const cmdUuid = normalizeUuid(cmdChar);
        const notifyUuid = normalizeUuid(notifyChar);
        const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
            [serviceUuid],
            [cmdUuid, notifyUuid],
        );
        const cmd = result.characteristics.find((characteristic) => characteristic.uuid === cmdUuid);
        const notify = result.characteristics.find((characteristic) => characteristic.uuid === notifyUuid);
        if (!cmd || !notify) throw new Error("The Handy Bluetooth service is incomplete");

        this.cmd = cmd;
        this.notify = notify;
        this.notifyListener = (data, isNotification) => {
            if (isNotification) onNotify(Buffer.from(data));
        };
        notify.on("data", this.notifyListener);
        await notify.subscribeAsync();
        this._connected = true;
    }

    async write(data: Buffer): Promise<void> {
        if (!this.cmd || !this._connected) throw new Error("BLE not connected");
        await this.cmd.writeAsync(data, false);
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        const notify = this.notify;
        const peripheral = this.peripheral;
        const noble = this.noble;
        if (notify && this.notifyListener) notify.removeListener("data", this.notifyListener);
        if (peripheral && this.disconnectListener) peripheral.removeListener("disconnect", this.disconnectListener);
        try {
            await notify?.unsubscribeAsync();
        } catch {}
        try {
            await peripheral?.disconnectAsync();
        } catch {}
        try {
            await noble?.stopScanningAsync();
        } catch {}
        try {
            noble?.stop();
        } catch {}
        this.noble = undefined;
        this.peripheral = undefined;
        this.cmd = undefined;
        this.notify = undefined;
        this.notifyListener = undefined;
        this.disconnectListener = undefined;
    }

    private async findDevice(noble: Noble, namePrefix: string): Promise<Peripheral> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let discoverListener: ((peripheral: Peripheral) => void) | undefined;
        const found = new Promise<Peripheral>((resolve, reject) => {
            discoverListener = (peripheral) => {
                const name = peripheral.advertisement.localName ?? "";
                if (name.startsWith(namePrefix)) resolve(peripheral);
            };
            noble.on("discover", discoverListener);
            timer = setTimeout(
                () => reject(new Error("Handy not found over Bluetooth (is it on and in Bluetooth mode?)")),
                SCAN_TIMEOUT_MS,
            );
        });

        try {
            // Windows may report the address before the device name, so keep
            // duplicate advertisements enabled until a named one arrives.
            await noble.startScanningAsync([], true);
            return await found;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (discoverListener) noble.removeListener("discover", discoverListener);
            try {
                await noble.stopScanningAsync();
            } catch {}
        }
    }
}
