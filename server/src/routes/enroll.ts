import type { FastifyInstance } from "fastify";
import {
  completeEnrollment,
  failEnrollment,
  lookupToken,
  readScript,
  renderInstallScript,
  type EnrollReport,
} from "../enrollment.js";
import { hubUrlFor } from "./hosts.js";

const TOKEN_ERRORS = {
  unknown: "This enrollment code is not recognized.",
  expired: "This enrollment code has expired. Issue a new one from the control panel.",
  used: "This enrollment code has already been used. Issue a new one from the control panel.",
} as const;

export async function enrollRoutes(app: FastifyInstance) {
  /**
   * The fact collector, fetched by install.sh during enrollment. It is a
   * read-only script with nothing host-specific in it, so it needs no token.
   */
  app.get("/facts.sh", async (_req, reply) => {
    reply.type("text/x-shellscript; charset=utf-8");
    return readScript("facts.sh");
  });

  /**
   * The endpoint the one-liner hits. Serves a script rendered for exactly one
   * host, carrying the hub's public key and that host's callback token.
   */
  app.get("/i/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const found = lookupToken(token);

    if (!found.ok) {
      // Delivered as a script that fails loudly: the caller is a shell, not a browser.
      reply.code(410).type("text/x-shellscript");
      return `#!/bin/sh\necho "homedash: ${TOKEN_ERRORS[found.reason]}" >&2\nexit 1\n`;
    }

    reply.type("text/x-shellscript; charset=utf-8");
    return renderInstallScript(found.host, hubUrlFor(req));
  });

  /** Facts callback from a machine that just ran the script. */
  app.post("/api/enroll/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const found = lookupToken(token);
    if (!found.ok) return reply.code(410).send({ error: TOKEN_ERRORS[found.reason] });

    const report = req.body as EnrollReport;
    if (!report?.host_key || !report?.address) {
      return reply.code(400).send({ error: "Report is missing host_key or address." });
    }
    if (report.host_id !== found.host.id) {
      return reply.code(400).send({ error: "Report does not match this enrollment code." });
    }

    const host = completeEnrollment(found.host, report);
    return { ok: true, hostId: host.id, name: host.name };
  });

  /** The script tells us why it gave up, so the panel can show it. */
  app.post("/api/enroll/:token/failed", async (req, reply) => {
    const { token } = req.params as { token: string };
    const found = lookupToken(token);
    if (!found.ok) return reply.code(410).send({ error: TOKEN_ERRORS[found.reason] });

    const { error } = (req.body ?? {}) as { error?: string };
    failEnrollment(found.host, String(error ?? "unknown").slice(0, 2000));
    return { ok: true };
  });
}
