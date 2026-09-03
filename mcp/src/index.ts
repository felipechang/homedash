#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedash, HomedashApiError } from "./client.js";

const server = new McpServer({
  name: "homedash",
  version: "0.1.0",
  title: "homedash",
});

/** Renders a result (or a caught API error) as MCP text content. */
function toResult(value: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function toError(err: unknown) {
  if (err instanceof HomedashApiError) return toResult(`homedash error (${err.status}): ${err.message}`, true);
  return toResult(`homedash error: ${(err as Error).message}`, true);
}

server.registerTool(
  "list_hosts",
  {
    title: "List hosts",
    description:
      "List every host known to homedash (pending enrollments and joined machines), with status, address, " +
      "reachability, and last-seen specs.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      return toResult(await homedash.listHosts());
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "get_host",
  {
    title: "Get host",
    description: "Get full detail for one host by id, including its facts, network config, and health state.",
    inputSchema: { id: z.string().describe("Host id, from list_hosts.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      return toResult(await homedash.getHost(id));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "get_hub_key",
  {
    title: "Get hub SSH public key",
    description: "Get the hub's own SSH public key, the one every enrolled remote authorizes.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return toResult(await homedash.getHubKey());
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "create_host",
  {
    title: "Create a pending host",
    description:
      "Start enrolling a new remote: creates a pending host with a single-use enrollment code and returns the " +
      "`curl | sudo bash` command to run on that machine. Does not touch any remote itself.",
    inputSchema: {
      name: z.string().min(1).describe("A label for this host, e.g. 'nas' or 'plex-box'."),
      wantIp: z.string().optional().describe("Static IP to assign after enrollment, if any."),
      wantGateway: z.string().optional().describe("Gateway to pair with wantIp."),
      wantDns: z.string().optional().describe("DNS server to pair with wantIp."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ name, wantIp, wantGateway, wantDns }) => {
    try {
      return toResult(await homedash.createHost({ name, wantIp, wantGateway, wantDns }));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "reissue_enrollment",
  {
    title: "Reissue enrollment code",
    description: "Issue a fresh enrollment code and command for a host whose previous code expired or was unused.",
    inputSchema: { id: z.string().describe("Host id, from list_hosts.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      return toResult(await homedash.reissueToken(id));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "check_host",
  {
    title: "Check host reachability",
    description:
      "Open a live SSH connection to a joined host to prove the hub can still reach it, and refresh its specs. " +
      "This is the only thing that distinguishes 'enrolled once' from 'actually under control'.",
    inputSchema: { id: z.string().describe("Host id, from list_hosts. Must already be joined.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      return toResult(await homedash.checkHost(id));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "get_host_events",
  {
    title: "Get host events",
    description: "Get the most recent events logged for a host (joins, reachability changes, errors).",
    inputSchema: { id: z.string().describe("Host id, from list_hosts.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      return toResult(await homedash.getHostEvents(id));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "delete_host",
  {
    title: "Delete host",
    description:
      "Permanently remove a host record from homedash. Does not uninstall anything from the remote machine " +
      "itself, and it is free to re-enroll afterward.",
    inputSchema: { id: z.string().describe("Host id, from list_hosts.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      await homedash.deleteHost(id);
      return toResult(`Host ${id} deleted.`);
    } catch (err) {
      return toError(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
