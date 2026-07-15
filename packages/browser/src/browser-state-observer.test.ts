import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserStateObserver } from "./browser-state-observer.js";

describe("BrowserStateObserver", () => {
  const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  });

  it("normalizes interactive inputs, buttons, and console errors without screenshots", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    const observer = new BrowserStateObserver(page);

    await page.setContent(`
      <title>Fixture</title>
      <label for="email">Email address</label>
      <input id="email" type="email" name="email">
      <button id="save">Save</button>
      <script>console.error('fixture error')</script>
    `);
    const state = await observer.observe();

    expect(state.surface).toBe("browser");
    expect(state.title).toBe("Fixture");
    expect(state.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "textbox",
          label: "Email address",
          selector: "#email",
          source: "dom",
        }),
        expect.objectContaining({
          role: "button",
          label: "Save",
          selector: "#save",
          source: "dom",
        }),
      ]),
    );
    expect(state.signals).toMatchObject({ consoleErrors: 1 });
    observer.dispose();
  });
});
