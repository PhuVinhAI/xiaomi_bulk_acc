import { chromium, type Page, type Browser, type BrowserContext } from "playwright";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

const PASSWORD = "tomi1234";
const KEYS_FILE = path.join(process.cwd(), "keys.txt");
const INVITE_FILE = path.join(process.cwd(), "invite.txt");

function askContinue(msg: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n>>> ${msg} (Press Enter to continue...)`, () => {
      rl.close();
      resolve();
    });
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  let workers = 1;
  let loop = false;
  let pairs = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workers" && args[i + 1]) { workers = parseInt(args[++i]) || 1; }
    if (args[i] === "--pairs" && args[i + 1]) { pairs = parseInt(args[++i]) || 1; }
    if (args[i] === "--loop") { loop = true; }
  }
  return { workers, loop, pairs };
}

function appendKey(key: string) {
  fs.appendFileSync(KEYS_FILE, key + "\n");
  console.log(`  Key appended to ${KEYS_FILE}: ${key}`);
}

function generateKeysHtml(keys: string[]) {
  const rows = keys.map((k, i) => `<tr><td>${i + 1}</td><td><code id="key${i}">${k}</code></td><td><button onclick="copyKey('key${i}')">Copy</button></td></tr>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>API Keys</title>
<style>
  body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 40px; }
  h1 { color: #0f3460; font-size: 24px; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; margin-top: 20px; }
  th, td { border: 1px solid #333; padding: 10px 16px; text-align: left; }
  th { background: #16213e; color: #e94560; }
  td { background: #0f3460; }
  code { font-size: 14px; color: #53d769; word-break: break-all; }
  button { background: #e94560; color: white; border: none; padding: 6px 16px; cursor: pointer; border-radius: 4px; font-size: 13px; }
  button:hover { background: #c73e54; }
  .copied { background: #53d769 !important; }
  .count { color: #e94560; font-size: 18px; }
</style>
</head>
<body>
<h1>API Keys <span class="count">(${keys.length})</span></h1>
<table>
<tr><th>#</th><th>Key</th><th>Action</th></tr>
${rows}
</table>
<script>
function copyKey(id) {
  const text = document.getElementById(id).textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById(id).closest('tr').querySelector('button');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}
</script>
</body>
</html>`;
}

function logPrefix(workerId: number, accNum: 1 | 2) {
  return `[W${workerId}-ACC${accNum}]`;
}

async function getTempMailToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    const m = document.cookie.match(/token=([^;]+)/);
    return m ? m[1] : "";
  });
  if (!token) throw new Error("No token found in temp-mail cookies");
  return token;
}

async function getMailbox(page: Page, token: string): Promise<string> {
  const result = await page.evaluate(async (tk: string) => {
    const res = await fetch("https://web2.temp-mail.org/mailbox", {
      headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" },
    });
    return await res.json();
  }, token);
  return (result as any).mailbox;
}

async function getMessages(page: Page, token: string): Promise<any[]> {
  const result = await page.evaluate(async (tk: string) => {
    const res = await fetch("https://web2.temp-mail.org/messages", {
      headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" },
    });
    return await res.json();
  }, token);
  return (result as any).messages || [];
}

async function waitForXiaomiVerificationCode(
  page: Page,
  token: string,
  maxRetries = 60,
  intervalMs = 5000
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const messages = await getMessages(page, token);
    for (const msg of messages) {
      const preview = msg.bodyPreview || msg.body || msg.html || msg.text || "";
      const codeMatch = preview.match(/\b(\d{6})\b/);
      if (codeMatch) return codeMatch[1];
    }
    if (i < maxRetries - 1) {
      console.log(`  Waiting for verification email... (${i + 1}/${maxRetries})`);
      await page.waitForTimeout(intervalMs);
    }
  }
  throw new Error("Verification code not found after max retries");
}

async function setupTempMail(browser: Browser): Promise<{ context: BrowserContext; email: string; token: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("  Opening temp-mail.org...");
  await page.goto("https://temp-mail.org/vi/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(15000);

  const token = await getTempMailToken(page);
  const email = await getMailbox(page, token);
  console.log("  Email:", email);

  return { context, email, token };
}

async function registerXiaomi(
  browser: Browser,
  tempMailContext: BrowserContext,
  email: string,
  token: string,
  prefix: string
): Promise<BrowserContext> {
  const xiaomiContext = await browser.newContext();
  const page = await xiaomiContext.newPage();

  console.log(`${prefix} Opening Xiaomi register page...`);
  await page.goto(
    "https://global.account.xiaomi.com/fe/service/register?_locale=en&_uRegion=VN",
    { waitUntil: "domcontentloaded", timeout: 60000 }
  );
  await page.waitForTimeout(3000);

  console.log(`${prefix} Filling registration form...`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="repassword"]', PASSWORD);

  await page.check('.mi-accept-terms input.ant-checkbox-input');
  await page.waitForTimeout(500);

  const submitBtn = page.locator('button[type="submit"].mi-button--primary');
  await submitBtn.waitFor({ state: "visible", timeout: 10000 });
  await submitBtn.click();

  console.log(`${prefix} Waiting for CAPTCHA to be passed (no timeout)...`);
  await page.waitForSelector('input[name="ticket"]', { timeout: 0 });
  console.log(`${prefix} CAPTCHA passed, verification page loaded.`);

  console.log(`${prefix} Getting verification code from temp-mail...`);
  const tempPage = tempMailContext.pages()[0];
  const code = await waitForXiaomiVerificationCode(tempPage, token);
  console.log(`${prefix} Verification code:`, code);

  await page.fill('input[name="ticket"]', code);
  await page.waitForTimeout(500);

  const submitCodeBtn = page.locator('button[type="submit"].mi-button--primary');
  await submitCodeBtn.waitFor({ state: "visible", timeout: 10000 });
  await submitCodeBtn.click();

  console.log(`${prefix} Registration submitted. Waiting for redirect...`);
  await page.waitForTimeout(5000);

  return xiaomiContext;
}

async function ensurePlatformSession(page: Page, prefix: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch("/api/v1/invitation/code", {
          headers: { Accept: "application/json" },
        });
        return { status: res.status, body: await res.json() };
      } catch (e: any) {
        return { status: 0, body: null };
      }
    });
    if (result.status === 200 && (result.body as any)?.code === 0) {
      console.log(`${prefix} Platform session OK.`);
      return;
    }
    console.log(`${prefix} Platform session not ready (attempt ${i + 1}), reloading...`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
  }
  throw new Error(`${prefix} Failed to establish platform session`);
}

async function handlePlatformProfile(
  xiaomiContext: BrowserContext,
  mode: "getInviteCode" | "enterInviteCode",
  prefix: string,
  inviteCode?: string
): Promise<{ apiKey: string; inviteCode?: string }> {
  const page = xiaomiContext.pages()[0] || await xiaomiContext.newPage();

  console.log(`${prefix} Navigating to platform.xiaomimimo.com/profile...`);
  await page.goto("https://platform.xiaomimimo.com/profile", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);

  const modalVisible = await page.locator('.ant-modal .ant-checkbox-input').count();
  if (modalVisible > 0) {
    console.log(`${prefix} Agreeing to Terms popup...`);
    await page.check('.ant-modal .ant-checkbox-input');
    await page.waitForTimeout(500);

    const confirmBtn = page.locator('.ant-modal-footer button').last();
    await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
    await confirmBtn.click();
    await page.waitForTimeout(2000);
  }

  await ensurePlatformSession(page, prefix);

  if (mode === "getInviteCode") {
    console.log(`${prefix} Getting invite code via API...`);
    const inviteResult = await page.evaluate(async () => {
      const res = await fetch("/api/v1/invitation/code", {
        headers: { Accept: "application/json" },
      });
      return await res.json();
    });
    const extractedCode = (inviteResult as any)?.data?.invitationCode || "";
    console.log(`${prefix} Invite code: ${extractedCode}`);
    fs.writeFileSync(INVITE_FILE, extractedCode);
    console.log(`${prefix} Invite code saved to ${INVITE_FILE}`);

    console.log(`${prefix} Navigating to API Keys page...`);
    await page.goto("https://platform.xiaomimimo.com/console/api-keys", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const apiKey = await createApiKey(page, prefix);
    return { apiKey, inviteCode: extractedCode };
  }

  if (mode === "enterInviteCode" && inviteCode) {
    console.log(`${prefix} ============================================`);
    console.log(`${prefix} INVITE CODE: ${inviteCode}`);
    console.log(`${prefix} Please enter this code manually in the browser.`);
    console.log(`${prefix} 1. Click the "Enter invite code" button`);
    console.log(`${prefix} 2. Type the code: ${inviteCode}`);
    console.log(`${prefix} 3. Click "Redeem"`);
    console.log(`${prefix} ============================================`);

    console.log(`${prefix} Navigating to API Keys page...`);
    await page.goto("https://platform.xiaomimimo.com/console/api-keys", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    await askContinue("After entering invite code in browser, press Enter");

    const apiKey = await createApiKey(page, prefix);
    return { apiKey };
  }

  throw new Error(`${prefix} Invalid mode or missing invite code`);
}

async function createApiKey(page: Page, prefix: string, maxRetries = 5): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`${prefix} Creating API Key (attempt ${attempt}/${maxRetries})...`);

      if (page.url().includes("serviceLogin") || page.url().includes("account.xiaomi.com")) {
        console.log(`${prefix} Session lost, re-navigating...`);
        await page.goto("https://platform.xiaomimimo.com/console/api-keys", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(5000);
      }

      const createBtn = page.locator('button:has-text("Create API Key")');
      await createBtn.waitFor({ state: "visible", timeout: 15000 });
      await createBtn.click();
      await page.waitForTimeout(2000);

      const nameInput = page.locator('input#apiKeyName');
      await nameInput.waitFor({ state: "visible", timeout: 10000 });
      await nameInput.fill("auto-key");
      await page.waitForTimeout(500);

      const confirmBtn = page.locator('.ant-modal button.ant-btn-primary:has-text("Confirm")');
      await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
      await confirmBtn.click();
      await page.waitForTimeout(3000);

      if (page.url().includes("serviceLogin") || page.url().includes("account.xiaomi.com")) {
        console.log(`${prefix} Page reset after confirm. Re-navigating...`);
        await page.goto("https://platform.xiaomimimo.com/console/api-keys", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(5000);
        continue;
      }

      const keyInput = page.locator('.ant-modal input[readonly][disabled]');
      await keyInput.waitFor({ state: "visible", timeout: 10000 });
      const apiKey = await keyInput.inputValue();
      console.log(`${prefix} API Key:`, apiKey);

      const closeBtn = page.locator('.ant-modal button:has-text("Close")');
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
        await page.waitForTimeout(500);
      }

      return apiKey;
    } catch (err: any) {
      console.log(`${prefix} Attempt ${attempt} failed: ${err.message?.substring(0, 100)}`);
      if (attempt < maxRetries) {
        console.log(`${prefix} Retrying in 5s...`);
        await page.waitForTimeout(5000);
        await page.goto("https://platform.xiaomimimo.com/console/api-keys", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(5000);
      }
    }
  }
  throw new Error(`${prefix} Failed to create API key after max retries`);
}

async function runPair(browser: Browser, workerId: number, collectedKeys: string[]): Promise<boolean> {
  const p1 = logPrefix(workerId, 1);
  const p2 = logPrefix(workerId, 2);

  try {
    console.log(`${p1} Setting up temp-mail...`);
    const temp1 = await setupTempMail(browser);

    console.log(`${p1} Registering on Xiaomi...`);
    const xiaomi1 = await registerXiaomi(browser, temp1.context, temp1.email, temp1.token, p1);

    console.log(`${p1} Handling platform (get invite code + API key)...`);
    const result1 = await handlePlatformProfile(xiaomi1, "getInviteCode", p1);
    console.log(`${p1} Done! Key: ${result1.apiKey}, Invite: ${result1.inviteCode}`);
    appendKey(result1.apiKey);
    collectedKeys.push(result1.apiKey);

    await temp1.context.close();
    await xiaomi1.close();

    console.log(`${p2} Setting up temp-mail (new context)...`);
    const temp2 = await setupTempMail(browser);

    console.log(`${p2} Registering on Xiaomi...`);
    const xiaomi2 = await registerXiaomi(browser, temp2.context, temp2.email, temp2.token, p2);

    console.log(`${p2} Handling platform (enter invite code + API key)...`);
    const result2 = await handlePlatformProfile(xiaomi2, "enterInviteCode", p2, result1.inviteCode);
    console.log(`${p2} Done! Key: ${result2.apiKey}`);
    appendKey(result2.apiKey);
    collectedKeys.push(result2.apiKey);

    await temp2.context.close();
    await xiaomi2.close();

    return true;
  } catch (err: any) {
    console.log(`[W${workerId}] Pair failed: ${err.message}`);
    return false;
  }
}

async function main() {
  const { workers, loop, pairs } = parseArgs();

  console.log("=== Xiaomi Bulk Account Registration ===");
  console.log(`  Workers: ${workers} | Pairs: ${loop ? "infinite" : pairs} | Keys file: ${KEYS_FILE}\n`);

  const browser = await chromium.launch({ headless: false });
  const collectedKeys: string[] = [];
  let totalPairs = 0;
  let pairIndex = 0;

  const shouldContinue = () => loop || pairIndex < pairs;

  while (shouldContinue()) {
    pairIndex++;
    const batch = Math.min(workers, loop ? workers : pairs - pairIndex + 1);
    const promises: Promise<any>[] = [];

    for (let w = 0; w < batch; w++) {
      const wid = pairIndex * 10 + w + 1;
      promises.push(runPair(browser, wid, collectedKeys));
    }

    if (promises.length === 1) {
      const ok = await promises[0];
      if (ok) totalPairs++;
    } else {
      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) totalPairs++;
      }
    }

    console.log(`\n=== Batch ${pairIndex} done. Total pairs: ${totalPairs} | Keys: ${collectedKeys.length} ===\n`);

    if (!loop && workers > 1) {
      pairIndex += batch - 1;
    }
  }

  console.log(`\n=== ALL DONE! ${collectedKeys.length} keys written to ${KEYS_FILE} ===`);

  if (collectedKeys.length > 0) {
    const htmlFile = path.join(process.cwd(), "keys.html");
    fs.writeFileSync(htmlFile, generateKeysHtml(collectedKeys));
    console.log(`Opening ${htmlFile} in browser...`);
    const summaryPage = await browser.newPage();
    await summaryPage.goto(`file:///${htmlFile.replace(/\\/g, "/")}`);
  }

  await browser.close();
}

main().catch(console.error);
