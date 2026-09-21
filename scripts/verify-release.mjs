const missing = [];
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) missing.push("GH_TOKEN (or GITHUB_TOKEN)");
if (!process.env.CSC_LINK) missing.push("CSC_LINK");
if (!process.env.CSC_KEY_PASSWORD) missing.push("CSC_KEY_PASSWORD");

if (missing.length && process.env.PHOENIX_ALLOW_UNSIGNED_RELEASE !== "1") {
  console.error(
    `Release blocked: missing ${missing.join(", ")}. ` +
    "Set PHOENIX_ALLOW_UNSIGNED_RELEASE=1 only for a deliberate private test release."
  );
  process.exit(1);
}
