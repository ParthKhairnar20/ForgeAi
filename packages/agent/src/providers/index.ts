import { Logger, ProviderConfig, RouterConfig } from "@forgeai/core";
import { GeminiProvider } from "./gemini";
import { OpenRouterProvider } from "./openrouter";
import { OllamaProvider } from "./ollama";
import { MockProvider, MockResponse } from "./mock";
import { ModelRouter, RouterDecision } from "./model-router";
import { BaseProvider } from "./base-provider";

export { MockProvider, MockResponse } from "./mock";
export { ModelRouter, RouterDecision } from "./model-router";

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
