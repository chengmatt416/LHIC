import type { Locator } from "playwright";

import {
  createSkillTrace,
  skillFailure,
  type SkillContext,
  type SkillResult,
} from "./skill-types.js";

export interface LoginInput {
  username?: string;
  password?: string;
  usernameEnvKey?: string;
  passwordEnvKey?: string;
  successText?: string;
  successUrlContains?: string;
}

async function findFirst(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      return candidate.first();
    }
  }
  return undefined;
}

async function requiresHuman(context: SkillContext): Promise<boolean> {
  const prompt = context.page
    .getByText(/captcha|two[ -]?factor|2fa|verification code/i)
    .first();
  return (await prompt.count()) > 0 && (await prompt.isVisible());
}

export async function login(
  context: SkillContext,
  input: LoginInput,
): Promise<SkillResult> {
  const trace = createSkillTrace(context);
  const username =
    input.username ??
    (input.usernameEnvKey ? process.env[input.usernameEnvKey] : undefined);
  const password =
    input.password ??
    (input.passwordEnvKey ? process.env[input.passwordEnvKey] : undefined);
  await trace.emit("login_started", {
    usernameProvided: Boolean(username),
    passwordProvided: Boolean(password),
  });

  if (!password) {
    await trace.emit("login_requires_human", { reason: "missing_password" });
    return skillFailure(
      trace,
      "A password is required from the user or configured environment key.",
      true,
    );
  }
  if (!username) {
    await trace.emit("login_requires_human", { reason: "missing_username" });
    return skillFailure(
      trace,
      "A username is required from the user or configured environment key.",
      true,
    );
  }
  if (await requiresHuman(context)) {
    await trace.emit("login_requires_human", { reason: "captcha_or_2fa" });
    return skillFailure(
      trace,
      "CAPTCHA or 2FA is present; human completion is required.",
      true,
    );
  }

  try {
    const usernameField = await findFirst([
      context.page.getByLabel(/username|email/i),
      context.page.locator(
        'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i]',
      ),
    ]);
    const passwordField = await findFirst([
      context.page.getByLabel(/password/i),
      context.page.locator('input[type="password"]'),
    ]);
    if (!usernameField || !passwordField) {
      await trace.emit("login_requires_human", {
        reason: "credential_fields_missing",
      });
      return skillFailure(
        trace,
        "Login fields could not be located safely.",
        true,
      );
    }

    await usernameField.fill(username);
    await trace.emit("login_username_filled", {});
    await passwordField.fill(password);
    await trace.emit("login_password_filled", {});
    const submit = await findFirst([
      context.page.locator('button[type="submit"], input[type="submit"]'),
      context.page.getByRole("button", {
        name: /sign in|log in|login|continue/i,
      }),
    ]);
    if (!submit) {
      return skillFailure(trace, "Login submit control was not found.");
    }
    await submit.click();
    await trace.emit("login_submitted", {});

    const condition = input.successText
      ? {
          type: "dom" as const,
          description: "Login success text is visible.",
          params: { text: input.successText },
        }
      : input.successUrlContains
        ? {
            type: "url" as const,
            description: "Login success URL is reached.",
            params: { contains: input.successUrlContains },
          }
        : undefined;
    if (!condition) {
      await trace.emit("login_verification_unavailable", {});
      return skillFailure(
        trace,
        "Login submitted, but no successText or successUrlContains verifier was supplied.",
      );
    }
    const verification = await context.verifier.verify(condition);
    if (!verification.success) {
      await trace.emit("login_verification_failed", {
        error: verification.error,
      });
      return skillFailure(
        trace,
        verification.error ?? "Login success could not be verified.",
      );
    }
    await trace.emit("login_verified", {});
    return {
      success: true,
      evidence: verification.evidence,
      traces: trace.events,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed.";
    await trace.emit("login_failed", { error: message });
    return skillFailure(trace, message);
  }
}
