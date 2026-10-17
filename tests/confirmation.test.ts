import { describe, expect, it } from "vitest";

import { deterministicService, makePlanForTest } from "./helpers.js";

describe("ConfirmationTokenService", () => {
  it("issues a token bound to the action", () => {
    const service = deterministicService();
    const plan = makePlanForTest("docker.containers.stop", ["docker stop 'web'"]);
    const issued = service.issue(plan);

    expect(issued.confirmationToken).toBeTruthy();
    expect(issued.requiresConfirmation).toBe(true);
    expect(issued.commands).toEqual(["docker stop 'web'"]);
  });

  it("consumes a token exactly once", () => {
    const service = deterministicService();
    const issued = service.issue(makePlanForTest("files.remove", ["rm -rf 'x'"]));

    const pending = service.consume(issued.confirmationToken, "files.remove");
    expect(pending.action).toBe("files.remove");

    expect(() => service.consume(issued.confirmationToken, "files.remove")).toThrow(/Unknown or already-used/);
  });

  it("rejects a token used for a different action", () => {
    const service = deterministicService();
    const issued = service.issue(makePlanForTest("files.copy", ["cp -a 'a' 'b'"]));
    expect(() => service.consume(issued.confirmationToken, "files.remove")).toThrow(/issued for "files.copy"/);
  });

  it("rejects expired tokens", () => {
    const service = deterministicService(1000);
    const issued = service.issue(makePlanForTest("backup.create", ["tar -czf x ."]));
    service.advance(2000);
    expect(() => service.consume(issued.confirmationToken, "backup.create")).toThrow(/expired/);
  });

  it("rejects unknown tokens", () => {
    const service = deterministicService();
    expect(() => service.consume("nope")).toThrow(/Unknown or already-used/);
  });
});
