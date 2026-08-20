import { Logger, ProviderConfig, RouterConfig } from "@forgeai/core";
import { GeminiProvider } from "./gemini";
import { OpenRouterProvider } from "./openrouter";
import { OllamaProvider } from "./ollama";
import { MockProvider } from "./mock";
import { ModelRouter } from "./model-router";
import { BaseProvider } from "./base-provider";

export { MockProvider } from "./mock";
export type { MockResponse } from "./mock";
export { ModelRouter } from "./model-router";
export type { RouterDecision } from "./model-router";

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
      return new OpenRouterProvider({ ...providerConfig, type: "openrouter" }, logger);
    case "ollama":
      return new OllamaProvider(providerConfig, logger);
    case "mock":
      return new MockProvider([], logger);
    default:
      throw new Error(`Unsupported provider type: ${providerConfig.type}`);
  }
}
