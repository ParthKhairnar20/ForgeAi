export function resolveProviderApiKey(config: { type: string; apiKey?: string }, env: Record<string, string | undefined>): string {
  const type = config.type.toLowerCase();

  if (config.apiKey && config.apiKey.trim()) {
    return config.apiKey.trim();
  }

  const envVarMap: Record<string, string> = {
    gemini: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "OPENROUTER_API_KEY",
    ollama: "OLLAMA_API_KEY",
    mock: "",
  };

  const envVar = envVarMap[type];
  if (!envVar) {
    throw new Error(`Unknown provider type: ${config.type}`);
  }

  const key = env[envVar];
  if (!key) {
    throw new Error(`Missing API key for provider "${config.type}". Set ${envVar} environment variable.`);
  }

  return key;
}

export function redactApiKey(key: string): string {
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
