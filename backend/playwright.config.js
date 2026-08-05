import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'fs';

const baseURL = process.env.FACTLENS_TEST_URL || 'https://factlens-production.up.railway.app';
const chromePath = process.env.CHROME_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((candidate) => existsSync(candidate));
const launchOptions = chromePath ? { executablePath: chromePath } : {};

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    launchOptions,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /studio-smoke\.spec\.js/,
    },
  ],
});
