import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Client-triggered test notification. Sends a synthetic payload through the same delivery path so
 * a user can verify their gateway and watch setup end to end.
 */
export const sendTestNotification = defineRpc({
  name: "notify.test",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
  }),
});
