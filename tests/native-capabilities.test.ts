import { expect, it } from "vitest";
import capabilities from "../src-tauri/capabilities/default.json";
it("grants the destroy command used by Tauri's onCloseRequested wrapper", () => {
  expect(capabilities.windows).toContain("main");
  expect(capabilities.permissions).toContain("core:window:allow-destroy");
});
