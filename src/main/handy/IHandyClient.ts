export interface HandyError {
    name?: string;
    message?: string;
    code?: number;
}

export interface SliderState {
    position: number;
    position_absolute: number;
    speed_absolute: number;
    dir: boolean;
    motor_temp: number;
}

export interface BaseResponse<T> {
    result?: T;
    error?: HandyError;
}

export interface IHandyClient {
    connect?(onConnectionLost?: () => void): Promise<void>;
    isConnected(): Promise<boolean>;
    hdspXpt(xp: number, t: number, stopOnTarget: boolean, immediateRsp: boolean): Promise<BaseResponse<unknown>>;
    getSliderState(): Promise<SliderState | undefined>;
    setSliderStroke(min?: number, max?: number): Promise<BaseResponse<unknown> | undefined>;
    shutdown?(): Promise<void>;
}
