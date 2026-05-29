import React from "react";
import {Alert, AlertColor, Button, CircularProgress, Link, Stack, Typography} from "@mui/material";
import TextCommitInput from "../util/TextCommitInput";
import MyAccordion from "../util/MyAccordion";
import ConnectionBubble from "./ConnectionBubble";
import {getConnectionBubbleColor} from "../../utils/connectionBubbleColor";
import {useSettingsStateAtom} from "./SettingsStateAtomContext";
import {type PrimitiveAtom, useAtom, useAtomValue} from "jotai";
import {selectAtom} from "jotai/utils";
import {invokeIpc} from "../../ipc";
import {HandyDiagnosticResult} from "../../../common/ipcContract";

interface Props {
    expanded: boolean;
    onChange: (expanded: boolean) => void;
    handyConnectionKeyAtom: PrimitiveAtom<string | undefined>;
    handyApplicationIdAtom: PrimitiveAtom<string | undefined>;
    handyEnabledAtom: PrimitiveAtom<boolean | undefined>;
}

function HandySettingsSection({
    expanded,
    onChange,
    handyConnectionKeyAtom,
    handyApplicationIdAtom,
    handyEnabledAtom,
}: Props) {
    const settingsStateAtom = useSettingsStateAtom();
    const handyConfigured = useAtomValue(
        React.useMemo(() => selectAtom(settingsStateAtom, (state) => state.handyConfigured), [settingsStateAtom]),
    );
    const handyConnected = useAtomValue(
        React.useMemo(() => selectAtom(settingsStateAtom, (state) => state.handyConnected), [settingsStateAtom]),
    );
    const [handyConnectionKey, setHandyConnectionKey] = useAtom(handyConnectionKeyAtom);
    const [handyApplicationId, setHandyApplicationId] = useAtom(handyApplicationIdAtom);
    const [handyEnabled, setHandyEnabled] = useAtom(handyEnabledAtom);
    const enabled = handyEnabled === true;

    const alerts: {severity: AlertColor; content: string}[] = [];
    if (!handyConfigured) {
        alerts.push({
            severity: "warning",
            content: "Enter your Handy connection key and application ID, then click Connect.",
        });
    } else if (!enabled) {
        alerts.push({
            severity: "warning",
            content: "Click Connect to start streaming to your Handy.",
        });
    } else if (!handyConnected) {
        alerts.push({
            severity: "warning",
            content: "Connecting to Handy... Check that the device is online and the connection key is correct.",
        });
    }

    const handleToggle = () => {
        setHandyEnabled(enabled ? false : true);
    };

    const [diagnosticRunning, setDiagnosticRunning] = React.useState(false);
    const [diagnosticResult, setDiagnosticResult] = React.useState<HandyDiagnosticResult | null>(null);
    const [diagnosticError, setDiagnosticError] = React.useState<string | null>(null);

    const handleRunDiagnostic = async () => {
        setDiagnosticRunning(true);
        setDiagnosticError(null);
        setDiagnosticResult(null);
        try {
            const result = await invokeIpc('handy:runDiagnostic');
            if (result.ok) setDiagnosticResult(result.data);
            else setDiagnosticError(result.error);
        } catch (e) {
            setDiagnosticError(e instanceof Error ? e.message : String(e));
        } finally {
            setDiagnosticRunning(false);
        }
    };

    return (
        <MyAccordion
            expanded={expanded}
            onChange={onChange}
            summary={
                <Stack direction="row" spacing={1} alignItems="center">
                    <ConnectionBubble color={getConnectionBubbleColor(alerts)} />
                    <Typography variant="h6">The Handy</Typography>
                </Stack>
            }
        >
            <Stack spacing={2}>
                {alerts.map((alert, index) => (
                    <Alert key={index} severity={alert.severity}>{alert.content}</Alert>
                ))}
                <Typography variant="body2" color="text.secondary">
                    Requires Handy firmware 4 or later with Wi-Fi mode enabled. Get your connection key from{' '}
                    <Link href="https://handyfeeling.com" target="_blank" rel="noreferrer">handyfeeling.com</Link>,
                    and create an application ID at{' '}
                    <Link href="https://user.handyfeeling.com" target="_blank" rel="noreferrer">user.handyfeeling.com</Link>.
                </Typography>
                <TextCommitInput
                    value={handyConnectionKey ?? ''}
                    label="Connection Key"
                    placeholder="Paste your Handy connection key"
                    onCommit={setHandyConnectionKey}
                />
                <TextCommitInput
                    value={handyApplicationId ?? ''}
                    label="Application ID"
                    placeholder="Paste your Handy application ID"
                    onCommit={setHandyApplicationId}
                />
                <Stack direction="row" spacing={1} alignItems="center">
                    <Button
                        variant="contained"
                        color={enabled ? "error" : "primary"}
                        disabled={!enabled && !handyConfigured}
                        onClick={handleToggle}
                    >
                        {enabled ? "Disconnect" : "Connect"}
                    </Button>
                    <Button
                        variant="outlined"
                        disabled={!handyConnected || diagnosticRunning}
                        onClick={handleRunDiagnostic}
                        startIcon={diagnosticRunning ? <CircularProgress size={16} /> : undefined}
                    >
                        {diagnosticRunning ? "Running…" : "Run Diagnostic"}
                    </Button>
                </Stack>
                {diagnosticRunning && (
                    <Typography variant="body2" color="text.secondary">
                        Measuring latency, accuracy and overshoot — the device will stroke through a
                        test pattern for about 13 seconds. Keep clear.
                    </Typography>
                )}
                {diagnosticError && (
                    <Alert severity="error">Diagnostic failed: {diagnosticError}</Alert>
                )}
                {diagnosticResult && !diagnosticRunning && (
                    <Alert severity="info">
                        <Stack spacing={0.5}>
                            <Typography variant="body2">
                                Latency: <strong>{diagnosticResult.latencyMs} ms</strong> (round-trip
                                command-to-motion delay)
                            </Typography>
                            <Typography variant="body2">
                                Accuracy (RMS tracking error): <strong>{diagnosticResult.accuracyRms}%</strong>
                            </Typography>
                            <Typography variant="body2">
                                Overshoot (travel past stroke ends): <strong>{diagnosticResult.overshoot}%</strong>
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                                Lower is better. High latency usually means Bluetooth mode — switch
                                the Handy to Wi-Fi for snappier motion. Some tracking error at the
                                fastest strokes is normal (the device can't keep up and simply
                                under-travels, which feels fine in use).
                            </Typography>
                        </Stack>
                    </Alert>
                )}
            </Stack>
        </MyAccordion>
    );
}

export default React.memo(HandySettingsSection);
