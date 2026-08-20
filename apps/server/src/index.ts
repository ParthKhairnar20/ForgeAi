import Fastify from "fastify";
import cors from "@fastify/cors";

import { ForgeAIConfig, resolveProviderApiKey } from "@forgeai/core";
import { AgentLoop } from "@forgeai/agent";

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: true });

let activeLoop: AgentLoop | null = null;

fastify.get("/health", async () => ({
  status: "ok",
  timestamp: Date.now(),
}));

fastify.post("/api/agent/run", async (request, reply) => {
  const body = request.body as { task: string; config: Omit<ForgeAIConfig, "provider"> & { provider: { type: string; model: string } | { primary: { type: string; model: string }; fallback?: { type: string; model: string } } } };
  if (!body?.task || !body?.config) {
    return reply.status(400).send({ error: "Missing 'task' or 'config' in request body." });
  }

  if (activeLoop) {
    return reply.status(409).send({ error: "Another task is already running." });
  }

  let resolvedConfig: ForgeAIConfig;
  try {
    const providerInput = body.config.provider as any;
    if (providerInput.primary) {
      const primaryApiKey = resolveProviderApiKey({ type: providerInput.primary.type, apiKey: "" }, process.env);
      const fallbackApiKey = providerInput.fallback ? resolveProviderApiKey({ type: providerInput.fallback.type, apiKey: "" }, process.env) : undefined;
      resolvedConfig = {
        ...body.config,
        provider: {
          primary: { ...providerInput.primary, apiKey: primaryApiKey },
          fallback: providerInput.fallback ? { ...providerInput.fallback, apiKey: fallbackApiKey } : undefined,
        },
      } as ForgeAIConfig;
    } else {
      const apiKey = resolveProviderApiKey({ type: providerInput.type, apiKey: "" }, process.env);
      resolvedConfig = {
        ...body.config,
        provider: { ...providerInput, apiKey },
      } as ForgeAIConfig;
    }
  } catch (error) {
    return reply.status(400).send({ error: (error as Error).message });
  }

  const providerLabel = (resolvedConfig.provider as any).primary
    ? `${(resolvedConfig.provider as any).primary.type} → ${(resolvedConfig.provider as any).fallback?.type || "none"}`
    : (resolvedConfig.provider as any).type;

  fastify.log.info({ msg: "Starting agent run", provider: providerLabel, model: (resolvedConfig.provider as any).primary?.model || (resolvedConfig.provider as any).model });

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");

  const logger = {
    info: (msg: string) => fastify.log.info(msg),
    warn: (msg: string) => fastify.log.warn(msg),
    error: (msg: string, err?: Error) => fastify.log.error({ msg, err }),
    debug: (msg: string) => fastify.log.debug(msg),
  };

  activeLoop = new AgentLoop(resolvedConfig, logger);

  reply.raw.on("close", () => {
    if (activeLoop) {
      activeLoop.cancel();
      activeLoop = null;
    }
  });

  try {
    for await (const event of activeLoop.run(body.task)) {
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        break;
      }
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      await reply.raw.write(payload);
    }
  } catch (error) {
    fastify.log.error({ msg: "Agent run failed", error });
    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      await reply.raw.write(`data: ${JSON.stringify({ type: "error", error: String(error) })}\n\n`);
    }
  } finally {
    activeLoop = null;
  }

  if (!reply.raw.writableEnded && !reply.raw.destroyed) {
    await reply.raw.write("data: [DONE]\n\n");
    await reply.raw.end();
  }
  return reply;
});

fastify.post("/api/agent/cancel", async () => {
  if (activeLoop) {
    activeLoop.cancel();
    activeLoop = null;
    return { status: "cancelled" };
  }
  return { status: "no_active_task" };
});

fastify.addHook("onClose", async () => {
  if (activeLoop) {
    activeLoop.cancel();
    activeLoop = null;
  }
});

const start = async () => {
  try {
    await fastify.listen({ host: "127.0.0.1", port: 4141 });
    console.log("ForgeAI server running at http://127.0.0.1:4141");
  } catch (err) {
    fastify.log.error({ msg: "Server failed to start", error: err });
    process.exit(1);
  }
};

start();
