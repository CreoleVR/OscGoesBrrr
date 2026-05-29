import {Service} from "typedi";
import {handleIpc} from "./ipc";

interface AvailableUpdateInfo {
    version?: string;
    downloadUrl?: string;
    status: 'downloading' | 'installIpc' | 'download' | 'error';
}

@Service()
export default class Updater {
    private availableUpdate?: AvailableUpdateInfo;

    constructor() {
        handleIpc('updater:install', async () => {
            await this.installAvailableUpdate();
        });
    }

    getAvailableUpdate() {
        return this.availableUpdate;
    }

    async installAvailableUpdate() {
        throw new Error("Automatic updates are disabled in this build");
    }
}
