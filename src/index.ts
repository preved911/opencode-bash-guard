import type { Plugin } from "@opencode-ai/plugin";
import { createBashGuardHooks } from "./adapter.js";

const BashGuardPlugin: Plugin = async (input) => {
  return createBashGuardHooks(input);
};

export default BashGuardPlugin;
