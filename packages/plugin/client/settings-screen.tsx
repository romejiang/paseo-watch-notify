import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { notifySettings, type NotifySettings } from "../shared/settings";
import { sendTestNotification } from "../shared/test-rpc";

interface Draft {
  values: NotifySettings;
  revision: string;
}

type ReadySettings = Extract<SettingsState<typeof notifySettings.schema>, { status: "ready" }>;

function ConnectionEditor({
  settings,
  onDone,
  theme,
}: {
  settings: ReadySettings;
  onDone: () => void;
  theme: PluginSurfaceProps["theme"];
}) {
  const [draft, setDraft] = useState<Draft>(() => ({
    values: settings.values,
    revision: settings.revision,
  }));
  const [windowText, setWindowText] = useState(() => String(settings.values.quietWindowMs));
  const [localError, setLocalError] = useState<string | null>(null);

  const patch = useCallback((values: Partial<NotifySettings>) => {
    setDraft((current) => ({ ...current, values: { ...current.values, ...values } }));
  }, []);

  const save = useCallback(async () => {
    const parsedWindow = Number.parseInt(windowText.trim(), 10);
    if (!Number.isFinite(parsedWindow) || parsedWindow < 0 || parsedWindow > 600_000) {
      setLocalError("Quiet window must be an integer between 0 and 600000 ms.");
      return;
    }
    setLocalError(null);
    const values = { ...draft.values, quietWindowMs: parsedWindow };
    if (await settings.save(values, draft.revision)) {
      onDone();
    }
  }, [draft, windowText, settings, onDone]);

  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);

  return (
    <SettingsCard>
      <SettingsInput
        label="Gateway URL"
        placeholder="https://notify.romejiang.top"
        initialValue={draft.values.gatewayUrl}
        onChangeText={(gatewayUrl) => patch({ gatewayUrl })}
        disabled={settings.saving}
      />
      <SettingsInput
        label="Auth token"
        placeholder="Optional bearer token"
        secureTextEntry
        initialValue={draft.values.authToken}
        onChangeText={(authToken) => patch({ authToken })}
        disabled={settings.saving}
      />
      <SettingsInput
        label="Quiet window (ms)"
        placeholder="15000"
        initialValue={windowText}
        onChangeText={setWindowText}
        disabled={settings.saving}
      />
      <SettingsAction
        label="Save connection settings"
        actionLabel="Save"
        disabled={settings.saving}
        onPress={save}
      />
      <SettingsAction
        label="Discard changes"
        actionLabel="Discard"
        disabled={settings.saving}
        onPress={onDone}
      />
      <SettingsRow label="Note">
        <View>
          <Text style={muted}>
            The auth token is stored as plaintext JSON on the daemon host. Prefer the
            PASEO_NOTIFY_AUTH_TOKEN environment variable for real secrets.
          </Text>
        </View>
      </SettingsRow>
      {localError || settings.saveError ? (
        <SettingsRow label="Error" error={localError ?? settings.saveError}>
          <Text accessibilityRole="alert" style={muted}>
            {localError ?? settings.saveError}
          </Text>
        </SettingsRow>
      ) : null}
    </SettingsCard>
  );
}

export function NotifySettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(notifySettings);
  const sendTest = useRpc(sendTestNotification);
  const [editing, setEditing] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await sendTest({});
      setTestResult(result.ok ? "Test notification sent." : `Test failed: ${result.error}`);
    } catch (error) {
      setTestResult(
        `Test failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setTesting(false);
    }
  }, [sendTest]);

  if (settings.status === "loading") {
    return <Text style={muted}>Loading settings…</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Notify">
        <Text style={muted}>{settings.status === "invalid" ? settings.error : settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Stored settings are invalid"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }

  const toggle = (values: Partial<NotifySettings>) => {
    void settings.save({ ...settings.values, ...values }, settings.revision);
  };
  const closeEditor = () => {
    setEditing(false);
    void settings.reload();
  };

  return (
    <>
      <SettingsSection title="Connection">
        <SettingsRow label="Gateway URL">
          <Text style={muted}>{settings.values.gatewayUrl || "Not configured"}</Text>
        </SettingsRow>
        <SettingsRow label="Quiet window">
          <Text style={muted}>{settings.values.quietWindowMs} ms</Text>
        </SettingsRow>
        <SettingsAction
          label="Connection settings"
          actionLabel={editing ? "Close editor" : "Edit"}
          disabled={settings.saving}
          onPress={() => setEditing((value) => !value)}
        />
      </SettingsSection>
      {editing ? (
        <ConnectionEditor settings={settings} onDone={closeEditor} theme={theme} />
      ) : null}
      <SettingsSection title="When to notify">
        <SettingsCard>
          <SettingsSwitch
            label="Permission requests"
            value={settings.values.notifyOnPermission}
            disabled={settings.saving}
            onValueChange={(notifyOnPermission) => toggle({ notifyOnPermission })}
          />
          <SettingsSwitch
            label="Failed turns"
            value={settings.values.notifyOnFailure}
            disabled={settings.saving}
            onValueChange={(notifyOnFailure) => toggle({ notifyOnFailure })}
          />
          <SettingsSwitch
            label="Subagents"
            value={settings.values.notifySubagents}
            disabled={settings.saving}
            onValueChange={(notifySubagents) => toggle({ notifySubagents })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Test">
        <SettingsCard>
          <SettingsAction
            label="Send a test notification through the gateway"
            actionLabel={testing ? "Sending…" : "Send test"}
            disabled={testing}
            onPress={runTest}
          />
        </SettingsCard>
        {testResult ? <Text style={muted}>{testResult}</Text> : null}
      </SettingsSection>
    </>
  );
}
