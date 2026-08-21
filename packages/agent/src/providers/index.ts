import { Logger, ProviderConfig, RouterConfig } from "@forgeai/core";
import { GeminiProvider } from "./gemini.js";
import { OpenRouterProvider } from "./openrouter.js";
import { OllamaProvider } from "./ollama.js";
import { MockProvider } from "./mock.js";
import { ModelRouter } from "./model-router.js";
import { BaseProvider } from "./base-provider.js";

export { MockProvider } from "./mock.js";
export type { MockResponse } from "./mock.js";
export { ModelRouter } from "./model-router.js";
export type { RouterDecision } from "./model-router.js";

export function createProvider(config: ProviderConfig | RouterConfig, logger: Logger): BaseProvider {
  if ((config as RouterConfig).primary) {
    const routerConfig = config as RouterConfig;
    return new ModelRouter(routerConfig.primary, routerConfig.fallback || null, logger);
  }

  const providerConfig = config as ProviderConfig;
  switch (providerConfig.type) {
    case "gemini":
      return new GeminiProvider(providerConfig, logger);
    case "openrouter":
      return new OpenRouterProvider(providerConfig, logger);
    case "groq":
      return new OpenRouterProvider({
        ...providerConfig,
        type: "openrouter",
        baseURL: providerConfig.baseURL || "https://api.groq.com/openai/v1",
      }, logger);
    case "ollama":
      return new OllamaProvider(providerConfig, logger);
    case "mock":
      return new MockProvider([], logger);
    default:
      throw new Error(`Unsupported provider type: ${providerConfig.type}`);
  }
}
