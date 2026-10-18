import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NotifySettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "notify",
    title: "Paseo Watch Notify",
    icon: "BellRing",
    Component: NotifySettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-notify-settings",
    title: "Configure Paseo Watch Notify",
    icon: "BellRing",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("notify");
    },
  });
  return () => {};
}
