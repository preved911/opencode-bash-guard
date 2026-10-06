import type { Plugin } from "@opencode-ai/plugin";
import { createBashGuardHooks } from "./adapter.js";

const BashGuardPlugin: Plugin = async (input) => {
  return createBashGuardHooks(input, async ({ sessionID, requestID, reply }) => {
    await input.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID: requestID },
      body: { response: reply },
      throwOnError: true,
    });
  });
};

export default BashGuardPlugin;
