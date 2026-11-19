import { defineConfig, devices } from '@playwright/test';

/**
 * ชุดทดสอบกลาง TEST-PLAN (51 TC) · baseURL จากตัวแปร BASE_URL
 * ทุก TC ใช้ฐานข้อมูล/นาฬิกาเดียวกันของเว็บ (RESET ทุก TC) → ต้องรันทีละ test (workers = 1)
 *
 * รัน:  BASE_URL=http://localhost:3000 npx playwright test
 * ตัวแปรเสริม: DB_PATH (TC-NFR-04 inspection) · BASE_URL_NO_TEST_MODE (TC-NFR-03 ตรวจว่าปิด hook แล้ว 404)
 */
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
