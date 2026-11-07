// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  reporter: 'html',
  use: {
    // headless mặc định để chạy được trên CI / không cần màn hình; đặt HEADED=1 để xem
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 720 },
  },
  timeout: 120000,
  // Tự động bật server static trước khi chạy test (không cần Live Server VS Code)
  webServer: {
    command: 'npx serve . -p 5500',
    port: 5500,
    reuseExistingServer: true, // Không bật lại server nếu đã có
    timeout: 120000, // Chờ server khởi động tối đa 2 phút
  },
});