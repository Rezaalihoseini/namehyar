// Shared browser selection for Windows development and Linux CI.
export const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
export const CHROME_ARGS = process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
