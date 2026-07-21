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

  it("exposes signature canvases and row-scoped table inputs as unique DOM targets", async () => {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    const observer = new BrowserStateObserver(page);

    await page.setContent(`
      <div><div><label>簽名確認</label><button>清除</button></div><div><canvas></canvas></div></div>
      <table>
        <thead><tr><th>商品</th><th>庫存</th></tr></thead>
        <tbody>
          <tr><td><input value="Test"></td><td><input type="number" value="4"></td></tr>
          <tr><td><input value="Other"></td><td><input type="number" value="8"></td></tr>
        </tbody>
      </table>
    `);

    const state = await observer.observe();
    const signature = state.objects.find((object) => object.role === "canvas");
    const stock = state.objects.find((object) => object.label === "Test 庫存");

    expect(signature).toMatchObject({ label: "簽名確認" });
    expect(signature?.selector).toContain("canvas");
    expect(stock).toMatchObject({ role: "spinbutton" });
    expect(stock?.selector).toContain("tr:nth-of-type(1)");
    expect(await page.locator(stock?.selector ?? "missing").count()).toBe(1);
    observer.dispose();
  });
});
