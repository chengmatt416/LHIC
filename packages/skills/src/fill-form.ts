import type { Locator } from "playwright";

import {
  createSkillTrace,
  escapeRegExp,
  skillFailure,
  type SkillContext,
  type SkillResult,
} from "./skill-types.js";

export interface FillFormInput {
  fields: Record<string, string>;
  submit?: boolean;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function firstMatch(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      return candidate.first();
    }
  }
  return undefined;
}

async function findField(
  context: SkillContext,
  key: string,
): Promise<Locator | undefined> {
  const label = context.page.getByLabel(
    new RegExp(`^${escapeRegExp(key)}$`, "i"),
  );
  const directlyMatched = await firstMatch([
    label,
    context.page.getByRole("textbox", {
      name: new RegExp(escapeRegExp(key), "i"),
    }),
    context.page.locator(
      `input[name="${key}"], textarea[name="${key}"], select[name="${key}"]`,
    ),
    context.page.locator(
      `input[placeholder*="${key}" i], textarea[placeholder*="${key}" i]`,
    ),
  ]);
  if (directlyMatched) {
    return directlyMatched;
  }

  const normalizedKey = normalize(key);
  const controls = context.page.locator("input, textarea, select");
  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    const metadata = await control.evaluate((element) => {
      const input = element as HTMLInputElement;
      return [
        element.getAttribute("name"),
        element.getAttribute("placeholder"),
        element.getAttribute("aria-label"),
        input.labels?.[0]?.textContent,
      ]
        .filter(Boolean)
        .join(" ");
    });
    const normalizedMetadata = normalize(metadata);
    if (
      normalizedMetadata.length > 0 &&
      (normalizedMetadata.includes(normalizedKey) ||
        normalizedKey.includes(normalizedMetadata))
    ) {
      return control;
    }
  }
  return undefined;
}

export async function fillForm(
  context: SkillContext,
  input: FillFormInput,
): Promise<SkillResult> {
  const trace = createSkillTrace(context);
  const evidence: string[] = [];
  await trace.emit("fill_form_started", {
    fieldCount: Object.keys(input.fields).length,
  });

  try {
    for (const [key, value] of Object.entries(input.fields)) {
      const field = await findField(context, key);
      if (!field) {
        await trace.emit("fill_form_field_not_found", { field: key });
        return skillFailure(
          trace,
          `No form control matched field ${JSON.stringify(key)}.`,
        );
      }

      if (
        (await field.evaluate((element) => element.tagName === "SELECT")) ===
        true
      ) {
        await field.selectOption(value);
      } else {
        await field.fill(value);
      }
      const observedValue = await field.inputValue();
      if (observedValue !== value) {
        await trace.emit("fill_form_verification_failed", { field: key });
        return skillFailure(
          trace,
          `Field ${JSON.stringify(key)} did not retain the requested value.`,
        );
      }
      evidence.push(`Verified value for ${key}.`);
      await trace.emit("fill_form_field_verified", { field: key });
    }

    if (input.submit) {
      const submit = await firstMatch([
        context.page.locator('button[type="submit"], input[type="submit"]'),
        context.page.getByRole("button", { name: /submit|save|continue/i }),
      ]);
      if (!submit) {
        await trace.emit("fill_form_submit_not_found", {});
        return skillFailure(
          trace,
          "Submit was requested but no submit control was found.",
        );
      }
      await submit.click();
      evidence.push("Clicked submit control.");
      await trace.emit("fill_form_submitted", {});
    }

    await trace.emit("fill_form_completed", {
      verifiedFieldCount: Object.keys(input.fields).length,
    });
    return { success: true, evidence, traces: trace.events };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Form filling failed.";
    await trace.emit("fill_form_failed", { error: message });
    return skillFailure(trace, message);
  }
}
