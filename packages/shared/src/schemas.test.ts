import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROCTORING_POLICY,
  EVENT_DEDUP_GROUPS,
  IntegrityEventType,
  proctoringPolicySchema,
} from "./index.js";

describe("@pariksha/shared proctoring defaults and validation", () => {
  it("validates the default proctoring policy with Zod", () => {
    const result = proctoringPolicySchema.safeParse(DEFAULT_PROCTORING_POLICY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.violationThreshold).toBe(2);
      expect(result.data.requireWebcam).toBe(true);
      expect(result.data.requireScreenShare).toBe(true);
    }
  });

  it("maps tab switch and window blur to the same deduplication group", () => {
    expect(EVENT_DEDUP_GROUPS[IntegrityEventType.TAB_SWITCH]).toBe("FOCUS_LOSS");
    expect(EVENT_DEDUP_GROUPS[IntegrityEventType.WINDOW_BLUR]).toBe("FOCUS_LOSS");
  });

  it("rejects out-of-range violation thresholds", () => {
    const invalid = proctoringPolicySchema.safeParse({
      ...DEFAULT_PROCTORING_POLICY,
      violationThreshold: 0,
    });
    expect(invalid.success).toBe(false);
  });
});
