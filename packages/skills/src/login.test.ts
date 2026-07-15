import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { VerifierEngine } from "@lhic/verifier";

import { login } from "./login.js";

describe("login", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  });

  it("logs in with verifier evidence without writing the password to traces", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent(`
      <form><label>Email <input type="email"></label><label>Password <input type="password"></label><button type="submit">Sign in</button></form>
      <p id="result"></p>
      <script>document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); document.querySelector('#result').textContent = 'Welcome'; });</script>
    `);
    const directory = await mkdtemp(join(tmpdir(), "lhic-login-"));
    try {
      const result = await login(
        {
          page,
          verifier: new VerifierEngine({ page }),
          taskId: "login",
          traceFilePath: join(directory, "events.jsonl"),
        },
        {
          username: "person@example.com",
          password: "do-not-log",
          successText: "Welcome",
        },
      );

      expect(result.success).toBe(true);
      const trace = await readFile(join(directory, "events.jsonl"), "utf8");
      expect(trace).not.toContain("do-not-log");
      expect(trace).not.toContain("person@example.com");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("asks a human to complete CAPTCHA or 2FA", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent("<p>Two-factor verification code required</p>");
    const directory = await mkdtemp(join(tmpdir(), "lhic-login-2fa-"));
    try {
      const result = await login(
        {
          page,
          verifier: new VerifierEngine({ page }),
          taskId: "login-2fa",
          traceFilePath: join(directory, "events.jsonl"),
        },
        { username: "user", password: "secret", successText: "Welcome" },
      );

      expect(result).toMatchObject({ success: false, askUser: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
