// Hermes supplies a profile-scoped child environment through its public MCP route.
// This mode never discovers standalone key files or CLI subscription credentials.
export function environmentCredentialsOnly(): boolean {
  return process.env.ASSET_GRABBER_CREDENTIAL_MODE === "environment";
}
