import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { config } from "./config.js";
import { ensureHubKey } from "./keys.js";
import { hostRoutes } from "./routes/hosts.js";
import { enrollRoutes } from "./routes/enroll.js";
import { startHeartbeat } from "./health.js";
import "./db.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(hostRoutes);
await app.register(enrollRoutes);

// In production the built panel is served from the same origin the remotes
// call back to, so there is exactly one address for a novice to remember.
if (fs.existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/i/")) {
      return reply.code(404).send({ error: "Not found." });
    }
    return reply.sendFile("index.html");
  });
}

const { publicKey } = ensureHubKey();
app.log.info({ hubKey: publicKey }, "hub control key ready");

await app.listen({ port: config.port, host: config.host });

// Enrollment proves a machine could reach us. The heartbeat proves we can
// still reach it — which is the thing every other feature depends on.
if (config.heartbeatMs > 0) {
  const stop = startHeartbeat(config.heartbeatMs);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stop();
      void app.close().then(() => process.exit(0));
    });
  }
}
