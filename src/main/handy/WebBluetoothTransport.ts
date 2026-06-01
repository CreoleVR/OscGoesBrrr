import {app, BrowserWindow, ipcMain} from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import type {BleTransport} from "./HandyBleClient";

const SCAN_TIMEOUT_MS = 20_000;

const PRELOAD_SOURCE = `
const { contextBridge, ipcRenderer } = require('electron');
const idArg = (process.argv.find(a => a.startsWith('--wbt-id=')) || '').split('=')[1] || '0';
contextBridge.exposeInMainWorld('__wbt', {
  notify: (bytes) => ipcRenderer.send('wbt:notify:' + idArg, bytes),
  disc: () => ipcRenderer.send('wbt:disc:' + idArg),
  onWrite: (cb) => ipcRenderer.on('wbt:write:' + idArg, (_e, d) => cb(d)),
});
`;

let preloadPathCache: string | undefined;
function ensurePreload(): string {
    if (preloadPathCache && fs.existsSync(preloadPathCache)) return preloadPathCache;
    const dir = (() => {
        try { return app.getPath("temp"); } catch { return os.tmpdir(); }
    })();
    const p = path.join(dir, "ogb-wbt-preload.cjs");
    fs.writeFileSync(p, PRELOAD_SOURCE, "utf8");
    preloadPathCache = p;
    return p;
}

function rendererSetup(cfg: {service: string; cmdChar: string; notifyChar: string; scanTimeoutMs: number}) {
    const g = globalThis as any;
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("scan timeout")), cfg.scanTimeoutMs));
    return Promise.race([
        g.navigator.bluetooth.requestDevice({acceptAllDevices: true, optionalServices: [cfg.service]}),
        timeout,
    ]).then(async (device: any) => {
        const gatt = await device.gatt.connect();
        const svc = await gatt.getPrimaryService(cfg.service);
        const cmd = await svc.getCharacteristic(cfg.cmdChar);
        const notify = await svc.getCharacteristic(cfg.notifyChar);
        notify.addEventListener("characteristicvaluechanged", (e: any) => {
            const v = e.target.value;
            const out: number[] = [];
            for (let i = 0; i < v.byteLength; i++) out.push(v.getUint8(i));
            g.__wbt.notify(out);
        });
        await notify.startNotifications();
        g.__wbt.onWrite((arr: number[]) => cmd.writeValueWithResponse(new Uint8Array(arr)).catch(() => undefined));
        device.addEventListener("gattserverdisconnected", () => g.__wbt.disc());
        return true;
    });
}

let nextId = 0;

export class WebBluetoothTransport implements BleTransport {
    private win?: BrowserWindow;
    private readonly id = nextId++;
    private _connected = false;
    private notifyListener?: (event: unknown, bytes: number[]) => void;
    private discListener?: () => void;

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
        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                preload: ensurePreload(),
                additionalArguments: [`--wbt-id=${this.id}`],
                contextIsolation: true,
            },
        });
        this.win = win;

        win.webContents.on("select-bluetooth-device", (event, devices, callback) => {
            event.preventDefault();
            const match = devices.find((d) => (d.deviceName ?? "").startsWith(namePrefix));
            if (match) callback(match.deviceId);
        });

        this.notifyListener = (_e, bytes: number[]) => onNotify(Buffer.from(bytes));
        this.discListener = () => { this._connected = false; onDisconnect(); };
        ipcMain.on(`wbt:notify:${this.id}`, this.notifyListener);
        ipcMain.on(`wbt:disc:${this.id}`, this.discListener);

        await win.loadURL("about:blank");
        const cfg = {
            service: service.toLowerCase(),
            cmdChar: cmdChar.toLowerCase(),
            notifyChar: notifyChar.toLowerCase(),
            scanTimeoutMs: SCAN_TIMEOUT_MS,
        };
        const script = `(${rendererSetup.toString()})(${JSON.stringify(cfg)})`;
        const ok = await win.webContents.executeJavaScript(script, true);
        if (!ok) throw new Error("Web Bluetooth connect failed");
        this._connected = true;
    }

    async write(data: Buffer): Promise<void> {
        if (!this.win || !this._connected) throw new Error("BLE not connected");
        this.win.webContents.send(`wbt:write:${this.id}`, [...data]);
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        if (this.notifyListener) ipcMain.removeListener(`wbt:notify:${this.id}`, this.notifyListener);
        if (this.discListener) ipcMain.removeListener(`wbt:disc:${this.id}`, this.discListener);
        try {
            this.win?.destroy();
        } catch {}
        this.win = undefined;
    }
}
