// Integration check of the freshly-built server against the REAL NAS.
// Uses the same config as the MCP client (~/.ugnas-mcp/config.json).
import { SshExecutor } from "../dist/src/ssh/sshExecutor.js";
import { loadNasConfig } from "../dist/src/config.js";
import { FileService } from "../dist/src/services/fileService.js";
import { BackupService } from "../dist/src/services/backupService.js";
import { ConfirmationTokenService } from "../dist/src/safety/plan.js";

const ctx = {
  config: loadNasConfig(),
  executor: null,
  confirmations: new ConfirmationTokenService()
};
ctx.executor = new SshExecutor(ctx.config);

const files = new FileService(ctx);
const backup = new BackupService(ctx);
let failures = 0;
const check = (name, fn) =>
  fn().then(
    () => console.log(`PASS ${name}`),
    (error) => {
      failures++;
      console.log(`FAIL ${name}: ${error.message}`);
    }
  );

// 1. `.` and `..` are filtered from a real listing (use a dir with content).
await check("files.list filters . and ..", async () => {
  const { entries } = await files.list(".");
  if (entries.some((e) => e.name === "." || e.name === "..")) {
    throw new Error("dot entries leaked");
  }
  if (entries.length === 0) throw new Error("listing was empty");
});

// 2. Deny-list refuses the share root and UGOS-managed dirs — and does NOT plan.
await check("deny-list: /volume1 and @docker refuse", async () => {
  let planned = false;
  try {
    await files.remove({ path: "/volume1" });
    planned = true;
  } catch (error) {
    if (!/share root/.test(error.message)) throw error;
  }
  try {
    await files.remove({ path: "@docker" });
    planned = true;
  } catch (error) {
    if (!/UGOS-managed/.test(error.message)) throw error;
  }
  if (planned) throw new Error("deny-listed path was planned instead of refused");
});

// 3. backup.create warns when archiving into itself (observed on the real box).
await check("backup.create self-archive warning", async () => {
  const plan = await backup.create({ path: "docker", destinationDir: "docker" });
  if (!("warnings" in plan) || !plan.warnings.some((w) => /OUTSIDE the source|is inside the source/.test(w))) {
    throw new Error("no self-archive warning");
  }
});

// 4. A normal plan→confirm round-trip still works (scratch dir, then delete it).
await check("plan->confirm round-trip on live NAS", async () => {
  const plan = await files.makeDirectory({ path: "docker/.ugnas-integration-check" });
  if (!("confirmationToken" in plan)) throw new Error("no token");
  const done = await files.makeDirectory({
    path: "docker/.ugnas-integration-check",
    token: plan.confirmationToken
  });
  if (!done.executed || done.results[0]?.code !== 0) throw new Error("mkdir failed");
  const rmPlan = await files.remove({ path: "docker/.ugnas-integration-check" });
  if (!("confirmationToken" in rmPlan)) throw new Error("no rm token");
  const rmDone = await files.remove({
    path: "docker/.ugnas-integration-check",
    token: rmPlan.confirmationToken
  });
  if (!rmDone.executed) throw new Error("cleanup failed");
});

// 5. Stale-token cross-check: token issued for A refused when called with B.
await check("payload cross-check refuses mismatched token", async () => {
  const plan = await files.makeDirectory({ path: "docker/.ugnas-x" });
  if (!("confirmationToken" in plan)) throw new Error("no token");
  let refused = false;
  try {
    await files.makeDirectory({ path: "docker/.ugnas-y", token: plan.confirmationToken });
  } catch (error) {
    refused = /different arguments/.test(error.message);
  }
  if (!refused) throw new Error("mismatched token was accepted");
});

ctx.executor.close();
console.log(failures === 0 ? "\nALL INTEGRATION CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);