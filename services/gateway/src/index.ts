import { ApnsSender, DryRunSender, type PushSender } from "./apns.js";
import { loadConfig } from "./config.js";
import { DeviceStore } from "./devices.js";
import { createServer, listen } from "./server.js";

function main(): void {
  const config = loadConfig();
  const store = new DeviceStore(config.devicesFile);
  const logger = (message: string, meta?: unknown): void => {
    console.log(`[gateway] ${message}`, meta ?? "");
  };

  const sender: PushSender = config.dryRun
    ? new DryRunSender(logger)
    : new ApnsSender({
        keyPem: config.apns.keyPem,
        keyId: config.apns.keyId,
        teamId: config.apns.teamId,
      });

  if (config.dryRun) {
    logger("DRY_RUN is on; pushes are logged, not sent to APNs");
  }
  if (!config.gatewayToken) {
    console.error("[gateway] PASEO_NOTIFY_GATEWAY_TOKEN is not set; /api/notify is unauthenticated");
  }

  const server = createServer({
    store,
    sender,
    gatewayToken: config.gatewayToken,
    deviceToken: config.deviceToken,
    defaultEnvironment: config.apns.environment,
    defaultTopic: config.apns.topic,
    logger,
  });

  listen(server, config.port)
    .then((port) => {
      console.log(`[gateway] listening on :${port} (APNs ${config.apns.environment}, topic ${config.apns.topic})`);
    })
    .catch((error: unknown) => {
      console.error("[gateway] failed to start", error);
      process.exitCode = 1;
    });
}

main();
