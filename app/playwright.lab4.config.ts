import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
// LAB 4: เหมือน config หลัก + เก็บ results.json, html report และวิดีโอทุก TC (เลือก P1 ไปทำ GIF)
export default defineConfig({
  ...base,
  reporter: [["list"], ["json", { outputFile: "test-report/results.json" }], ["html", { open: "never", outputFolder: "test-report/html" }]],
  outputDir: "test-report/artifacts",
  use: { ...base.use, video: "on" },
});
