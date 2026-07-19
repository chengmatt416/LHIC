const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?<!\w)(?:\+?\d[\d().\-\s]{7,}\d)(?!\w)/g;
const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const jwtPattern = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const apiTokenPattern = /\b(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,}\b/gi;
const creditCardPattern = /\b(?:\d[ -]*?){13,16}\b/g;
const ssnPattern = /\b\d{3}-\d{2}-\d{4}\b/g;
const addressPattern =
  /\b\d{1,5}\s+(?:[A-Z0-9.-]+\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Highway|Hwy|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Way|Suite|Ste|Floor|Fl)\b/gi;
const sensitiveKeyPattern =
  /(password|passphrase|pwd|token|secret|api[_-]?key|authorization|cookie)/i;
const sensitiveFieldHintPattern =
  /(password|passphrase|pwd|token|secret|api[_-]?key|authorization|cookie)/i;
const sensitiveUrlParameterPattern =
  /^(?:access[_-]?token|api[_-]?key|authorization|cookie|password|passphrase|pwd|secret|token)$/i;
const httpUrlPattern = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Local Named Entity Recognition (NER) and Contextual Heuristic Parser.
 * Scans text for names, organizations, locations, or sensitive API keys
 * that are missed by generic regular expressions.
 */
function localNERRedact(value: string): string {
  if (process.env.LHIC_DISABLE_LOCAL_NER === "true") {
    return value;
  }
  let redacted = value;

  // 1. Identify common PII names and capitalize patterns in specific sentence contexts
  const introductionPatterns = [
    /\bmy\s+name\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
    /\bI\s+am\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
    /\blogin\s+as\s+([A-Za-z0-9_.-]+)\b/gi,
  ];

  for (const pattern of introductionPatterns) {
    redacted = redacted.replace(pattern, (match, p1) => {
      return match.replace(p1, "[REDACTED_NAME]");
    });
  }

  // 2. Identify potential high-entropy keys/secrets not covered by apiTokenPattern
  const credentialAssignments = [
    /\b(?:secret|password|passwd|key|token|auth)\s*[:=]\s*['"]?([A-Za-z0-9_~+/=-]{8,})['"]?/gi,
  ];

  for (const pattern of credentialAssignments) {
    redacted = redacted.replace(pattern, (match, p1) => {
      if (
        p1.toLowerCase() === "true" ||
        p1.toLowerCase() === "false" ||
        p1.toLowerCase() === "null"
      ) {
        return match;
      }
      return match.replace(p1, "[REDACTED_SECRET]");
    });
  }

  // 3. Organization patterns
  const orgPattern =
    /\b[A-Z][a-zA-Z0-9._&+-]+\s+(?:Inc|Incorporated|Corp|Corporation|LLC|Ltd|Limited)\b\.?/g;
  redacted = redacted.replace(orgPattern, "[REDACTED_ORG]");

  return redacted;
}

function redactString(value: string): string {
  const redactedUrls = value.replace(httpUrlPattern, redactHttpUrl);
  const redacted = redactedUrls
    .replace(emailPattern, "[REDACTED_EMAIL]")
    .replace(phonePattern, "[REDACTED_PHONE]")
    .replace(bearerTokenPattern, "Bearer [REDACTED_TOKEN]")
    .replace(jwtPattern, "[REDACTED_TOKEN]")
    .replace(apiTokenPattern, "[REDACTED_TOKEN]")
    .replace(creditCardPattern, "[REDACTED_CREDIT_CARD]")
    .replace(ssnPattern, "[REDACTED_SSN]")
    .replace(addressPattern, "[REDACTED_ADDRESS]");
  return localNERRedact(redacted);
}

function redactHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    for (const [name] of url.searchParams) {
      if (sensitiveUrlParameterPattern.test(name)) {
        url.searchParams.set(name, "[REDACTED]");
      }
    }
    if (url.hash) {
      const fragment = new URLSearchParams(url.hash.slice(1));
      let changed = false;
      for (const [name] of fragment) {
        if (sensitiveUrlParameterPattern.test(name)) {
          fragment.set(name, "[REDACTED]");
          changed = true;
        }
      }
      if (changed) url.hash = fragment.toString();
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactPII<T>(input: T): T {
  if (typeof input === "string") {
    return redactString(input) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactPII(item)) as T;
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  const record = input as Record<string, unknown>;
  const valueBelongsToSensitiveField = Object.entries(record).some(
    ([key, value]) =>
      ["target", "selector", "field", "label", "name"].includes(key) &&
      typeof value === "string" &&
      sensitiveFieldHintPattern.test(value),
  );

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sensitiveKeyPattern.test(key) ||
      (key === "value" && valueBelongsToSensitiveField)
        ? "[REDACTED]"
        : redactPII(value),
    ]),
  ) as T;
}
