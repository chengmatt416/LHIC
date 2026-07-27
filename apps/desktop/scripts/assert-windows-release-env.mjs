const certificate = process.env.WIN_CSC_LINK || process.env.CSC_LINK;
const password =
  process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD;

if (!certificate || !password) {
  throw new Error(
    "A signed Windows release requires WIN_CSC_LINK (or CSC_LINK) and WIN_CSC_KEY_PASSWORD (or CSC_KEY_PASSWORD).",
  );
}

console.log("Windows Authenticode credential names are configured.");
