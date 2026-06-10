import { describe, expect, it } from "vitest";
import {
  buildAccountHealthKey,
  classifyGoogleBenchmarkError,
  shouldSkipGoogleAccountHealth,
} from "@/lib/google-ads/account-health";

describe("google account benchmark health", () => {
  it("normalizes customer ids and direct routes into canonical keys", () => {
    expect(buildAccountHealthKey("123-456-7890", null)).toBe("1234567890|direct");
    expect(buildAccountHealthKey("123-456-7890", "999-888-7777")).toBe("1234567890|9998887777");
  });

  it("skips connection-level failures until reconnect when skipUntil is absent", () => {
    expect(shouldSkipGoogleAccountHealth({ errorLevel: "connection", skipUntil: null })).toBe(true);
  });

  it("skips account failures only while skipUntil is in the future", () => {
    const now = new Date("2026-06-10T12:00:00.000Z");
    expect(shouldSkipGoogleAccountHealth({ errorLevel: "account", skipUntil: "2026-06-10T13:00:00.000Z" }, now)).toBe(true);
    expect(shouldSkipGoogleAccountHealth({ errorLevel: "account", skipUntil: "2026-06-10T11:00:00.000Z" }, now)).toBe(false);
  });

  it("classifies invalid grants as connection failures until reconnect", () => {
    const classified = classifyGoogleBenchmarkError(new Error("invalid_grant: Token has been expired or revoked"));
    expect(classified.errorLevel).toBe("connection");
    expect(classified.skipUntil).toBeNull();
  });

  it("classifies disabled customers as long-lived account failures", () => {
    const classified = classifyGoogleBenchmarkError(
      new Error("CUSTOMER_NOT_ENABLED: Customer is not enabled"),
      new Date("2026-06-10T00:00:00.000Z"),
    );
    expect(classified.errorLevel).toBe("account");
    expect(classified.skipUntil).toBe("2026-07-10T00:00:00.000Z");
  });
});
