const hasSigningCredential = Boolean(
  process.env.CSC_LINK || process.env.CSC_NAME,
);
const hasNotarizationCredential =
  Boolean(
    process.env.APPLE_API_KEY &&
    process.env.APPLE_API_KEY_ID &&
    process.env.APPLE_API_ISSUER,
  ) ||
  Boolean(
    process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID,
  ) ||
  Boolean(process.env.APPLE_KEYCHAIN_PROFILE);

if (!hasSigningCredential || !hasNotarizationCredential) {
  const missing = [
    ...(hasSigningCredential ? [] : ["CSC_LINK or CSC_NAME"]),
    ...(hasNotarizationCredential
      ? []
      : [
          "APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, Apple ID credentials, or APPLE_KEYCHAIN_PROFILE",
        ]),
  ];
  throw new Error(
    `A notarized macOS release requires ${missing.join(" and ")}.`,
  );
}
