import { validateCredentialedModelEndpoint } from "@lhic/controller";

export function validateDemoModelEndpoint(value: string): URL {
  return validateCredentialedModelEndpoint(value);
}
