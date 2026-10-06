import type { Plugin } from "@opencode-ai/plugin";
import { createBashGuardHooks } from "./adapter.js";

const BashGuardPlugin: Plugin = async (input) => {
  return createBashGuardHooks(
    input,
    async ({ sessionID, requestID, reply }) => {
      await input.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID: requestID },
        body: { response: reply },
        throwOnError: true,
      });
    },
    async (sessionID) => {
      try {
        const response = await input.client.session.get({ path: { id: sessionID }, throwOnError: true });
        const directory = response.data?.directory;
        return typeof directory === "string" && directory.length > 0 ? directory : null;
      } catch {
        return null;
      }
    },
  );
};

export default BashGuardPlugin;
