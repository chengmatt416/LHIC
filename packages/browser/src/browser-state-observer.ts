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
      .locator(
        "button, input, select, textarea, canvas, a[href], [role], details, summary, [contenteditable], [tabindex]:not([tabindex='-1'])",
      )
      .evaluateAll((elements) => {
        const siblingPositions = new WeakMap<
          Element,
          { index: number; count: number }
        >();
        const tableHeaders = new WeakMap<Element, Element[]>();
        const rowLabels = new WeakMap<Element, string | undefined>();
        return elements.map((element, index) => {
          const input = element as HTMLInputElement;
          const labelledBy = element.getAttribute("aria-labelledby");
          const labelledText = labelledBy
            ? labelledBy
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent?.trim())
                .filter(Boolean)
                .join(" ")
            : undefined;
          const nativeLabel = input.labels?.[0]?.textContent?.trim();
          const tableLabel = tableContextLabel(element);
          const canvasLabel =
            element.tagName === "CANVAS"
              ? element.parentElement?.previousElementSibling
                  ?.querySelector("label")
                  ?.textContent?.trim()
              : undefined;
          const label =
            labelledText ||
            element.getAttribute("aria-label") ||
            nativeLabel ||
            element.getAttribute("placeholder") ||
            element.getAttribute("name") ||
            canvasLabel ||
            tableLabel ||
            element.textContent?.trim() ||
            undefined;
          const testId = element.getAttribute("data-testid");
          const name = element.getAttribute("name");
          const tagName = element.tagName.toLowerCase();
          const { index: indexWithinType } = siblingPosition(element);
          const selector = element.id
            ? `#${CSS.escape(element.id)}`
            : testId
              ? `[data-testid="${CSS.escape(testId)}"]`
              : name
                ? `${tagName}[name="${CSS.escape(name)}"]`
                : (uniqueSelector(element) ??
                  `${tagName}:nth-of-type(${indexWithinType + 1})`);
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
                      input.type === "search" ||
                      input.type === "password"
                    ? "textbox"
                    : input.type === "number"
                      ? "spinbutton"
                      : element.tagName === "CANVAS"
                        ? "canvas"
                        : input.type === "checkbox"
                          ? "checkbox"
                          : undefined;
          const isPassword = input.type === "password";

          return {
            id: element.id || `ui-${index + 1}`,
            role: element.getAttribute("role") ?? implicitRole,
            label,
            value: "value" in input && !isPassword ? input.value : undefined,
            enabled: !(
              input.disabled || element.getAttribute("aria-disabled") === "true"
            ),
            focused: document.activeElement === element,
            selector,
          };
        });

        function tableContextLabel(element: Element): string | undefined {
          const cell = element.closest("td");
          const row = cell?.parentElement;
          const table = row?.closest("table");
          if (!cell || !row || !table) return undefined;
          const column = Array.prototype.indexOf.call(row.children, cell);
          let headers = tableHeaders.get(table);
          if (!headers) {
            headers = Array.from(table.querySelectorAll("th"));
            tableHeaders.set(table, headers);
          }
          const header = headers[column]?.textContent?.trim();
          let rowLabel: string | undefined;
          if (rowLabels.has(row)) {
            rowLabel = rowLabels.get(row);
          } else {
            rowLabel =
              row.querySelector("input")?.getAttribute("value")?.trim() ||
              row.querySelector("input")?.value?.trim() ||
              Array.from(row.children)
                .map((child) => child.textContent?.trim())
                .find(Boolean);
            rowLabels.set(row, rowLabel);
          }
          return rowLabel && header ? `${rowLabel} ${header}` : header;
        }
        function siblingPosition(element: Element): {
          index: number;
          count: number;
        } {
          const cached = siblingPositions.get(element);
          if (cached) return cached;
          const siblings = element.parentElement?.children;
          if (!siblings) {
            const position = { index: 0, count: 1 };
            siblingPositions.set(element, position);
            return position;
          }
          const matching: Element[] = [];
          for (const sibling of siblings) {
            if (sibling.tagName === element.tagName) matching.push(sibling);
          }
          matching.forEach((sibling, index) => {
            siblingPositions.set(sibling, { index, count: matching.length });
          });
          return siblingPositions.get(element) ?? { index: 0, count: 1 };
        }
        function uniqueSelector(element: Element): string | undefined {
          const parts: string[] = [];
          let current: Element | null = element;
          while (current && current !== document.documentElement) {
            const tag = current.tagName.toLowerCase();
            const position = siblingPosition(current);
            const part =
              position.count > 1
                ? `${tag}:nth-of-type(${position.index + 1})`
                : tag;
            parts.unshift(part);
            const candidate = parts.join(" > ");
            if (document.querySelectorAll(candidate).length === 1) {
              return candidate;
            }
            current = current.parentElement;
          }
          return undefined;
        }
      });
  }
}
