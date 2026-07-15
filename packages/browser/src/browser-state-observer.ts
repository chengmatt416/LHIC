import type { Page } from "playwright";

import type { NormalizedUIState, UIObject } from "@lhic/schema";

import { ConsoleNetworkObserver } from "./console-network-observer.js";

interface BrowserObjectSnapshot {
  id: string;
  role?: string | undefined;
  label?: string | undefined;
  value?: string | undefined;
  enabled: boolean;
  focused: boolean;
  selector: string;
}

export class BrowserStateObserver {
  public constructor(
    private readonly page: Page,
    private readonly networkObserver: ConsoleNetworkObserver = new ConsoleNetworkObserver(
      page,
    ),
  ) {}

  public async observe(): Promise<NormalizedUIState> {
    const [title, objects] = await Promise.all([
      this.safeTitle(),
      this.collectObjects(),
    ]);

    return {
      surface: "browser",
      url: this.page.url(),
      ...(title === undefined ? {} : { title }),
      objects: objects.map(
        (object) => ({ ...object, source: "dom" }) as UIObject,
      ),
      signals: { ...this.networkObserver.snapshot() },
      capturedAt: new Date().toISOString(),
    };
  }

  public dispose(): void {
    this.networkObserver.stop();
  }

  private async safeTitle(): Promise<string | undefined> {
    try {
      return await this.page.title();
    } catch {
      return undefined;
    }
  }

  private async collectObjects(): Promise<BrowserObjectSnapshot[]> {
    return this.page
      .locator("button, input, select, textarea, a[href], [role]")
      .evaluateAll((elements) => {
        const labelFor = (element: Element): string | undefined => {
          const labelledBy = element.getAttribute("aria-labelledby");
          if (labelledBy) {
            const labelledText = labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim())
              .filter(Boolean)
              .join(" ");
            if (labelledText) {
              return labelledText;
            }
          }

          const input = element as HTMLInputElement;
          const nativeLabel = input.labels?.[0]?.textContent?.trim();
          return (
            element.getAttribute("aria-label") ??
            nativeLabel ??
            element.getAttribute("placeholder") ??
            element.getAttribute("name") ??
            element.textContent?.trim() ??
            undefined
          );
        };

        const selectorFor = (element: Element): string => {
          if (element.id) {
            return `#${CSS.escape(element.id)}`;
          }
          const testId = element.getAttribute("data-testid");
          if (testId) {
            return `[data-testid="${CSS.escape(testId)}"]`;
          }
          const name = element.getAttribute("name");
          if (name) {
            return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          }
          const tagName = element.tagName.toLowerCase();
          const indexWithinType = Array.from(
            element.parentElement?.children ?? [],
          )
            .filter((sibling) => sibling.tagName.toLowerCase() === tagName)
            .indexOf(element);
          return `${tagName}:nth-of-type(${indexWithinType + 1})`;
        };

        return elements.map((element, index) => {
          const input = element as HTMLInputElement;
          const implicitRole =
            element.tagName === "BUTTON"
              ? "button"
              : element.tagName === "A"
                ? "link"
                : element.tagName === "SELECT"
                  ? "combobox"
                  : element.tagName === "TEXTAREA" ||
                      input.type === "text" ||
                      input.type === "email" ||
                      input.type === "search"
                    ? "textbox"
                    : input.type === "checkbox"
                      ? "checkbox"
                      : undefined;
          const isPassword = input.type === "password";

          return {
            id: element.id || `ui-${index + 1}`,
            role: element.getAttribute("role") ?? implicitRole,
            label: labelFor(element),
            value: "value" in input && !isPassword ? input.value : undefined,
            enabled: !(
              input.disabled || element.getAttribute("aria-disabled") === "true"
            ),
            focused: document.activeElement === element,
            selector: selectorFor(element),
          };
        });
      });
  }
}
