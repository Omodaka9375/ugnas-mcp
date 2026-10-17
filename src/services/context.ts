import type { ResolvedNasConfig } from "../config.js";
import type { CommandExecutor } from "../ssh/sshExecutor.js";
import type { ConfirmationTokenService } from "../safety/plan.js";

export type ServiceContext = {
  executor: CommandExecutor;
  config: ResolvedNasConfig;
  confirmations: ConfirmationTokenService;
};
