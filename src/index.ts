import type { Plugin } from "@opencode-ai/plugin";
import { createBashGuardHooks } from "./adapter.js";

const BashGuardPlugin: Plugin = async (input) => {
  return createBashGuardHooks({
    directory: input.directory,
    replyPermission: async ({ sessionID, requestID, response }) =>
      input.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID: requestID },
        body: { response },
      }),
  });
};

export default BashGuardPlugin;
