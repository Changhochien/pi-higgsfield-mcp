/**
 * Higgsfield MCP Extension for pi
 *
 * Connects to the Higgsfield MCP server at https://mcp.higgsfield.ai/mcp
 * using OAuth device flow and Streamable HTTP transport.
 *
 * Commands:
 *   /higgsfield-auth  - Initiate device flow authentication
 *   /higgsfield-status - Show connection/auth status
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────

const MCP_SERVER_URL = "https://mcp.higgsfield.ai/mcp";
const DEVICE_AUTH_URL = "https://fnf-device-auth.higgsfield.ai";
const RESOURCE_METADATA_URL = "https://mcp.higgsfield.ai/.well-known/oauth-protected-resource";

const ENTRY_TYPE_TOKENS = "higgsfield-mcp-tokens";
const ENTRY_TYPE_DISCOVERY = "higgsfield-mcp-discovery";

// ─── Types ───────────────────────────────────────────────────────────────

interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  obtained_at: number;
}

interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── State ───────────────────────────────────────────────────────────────

let tokens: OAuthTokens | null = null;
let mcpSessionId: string | null = null;
let mcpProtocolVersion: string | null = null;
let registeredTools: Map<string, string> = new Map(); // toolName -> piToolName
let initialized = false;

// ─── Helpers ─────────────────────────────────────────────────────────────

function isTokenExpired(t: OAuthTokens): boolean {
  if (!t.expires_in) return false;
  const expiresAt = t.obtained_at + t.expires_in * 1000;
  return Date.now() > expiresAt - 60000; // 1 min buffer
}

function loadTokensFromEntries(ctx: ExtensionContext): void {
  // Try session entries first
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE_TOKENS) {
      tokens = entry.data as OAuthTokens;
      return;
    }
  }

  // Fallback: try file-based token cache
  try {
    const tokenPath = path.join(ctx.cwd, ".pi/state/higgsfield-tokens.json");
    if (fs.existsSync(tokenPath)) {
      const raw = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
      tokens = {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
        expires_in: raw.expires_in,
        token_type: raw.token_type,
        scope: raw.scope,
        obtained_at: Date.now(),
      };
    }
  } catch {
    // Ignore file read errors
  }
}

function saveTokenFile(ctx: ExtensionContext): void {
  if (!tokens) return;
  try {
    const dir = path.join(ctx.cwd, ".pi/state");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "higgsfield-tokens.json"),
      JSON.stringify(tokens, null, 2)
    );
  } catch {
    // Ignore file write errors
  }
}

function persistTokens(pi: ExtensionAPI): void {
  if (tokens) {
    pi.appendEntry(ENTRY_TYPE_TOKENS, tokens);
  }
}

function persistDiscovery(pi: ExtensionAPI): void {
  pi.appendEntry(ENTRY_TYPE_DISCOVERY, {
    sessionId: mcpSessionId,
    protocolVersion: mcpProtocolVersion,
  });
}

// ─── MCP JSON-RPC Client ────────────────────────────────────────────────

let requestId = 0;

async function mcpRequest(
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  requestId++;
  const body: JSONRPCRequest = {
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (tokens?.access_token) {
    headers["Authorization"] = `Bearer ${tokens.access_token}`;
  }
  if (mcpSessionId) {
    headers["mcp-session-id"] = mcpSessionId;
  }

  const res = await fetch(MCP_SERVER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from response headers
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSessionId = sid;

  // Handle 401 - need re-auth
  if (res.status === 401) {
    throw new Error("UNAUTHORIZED: Run /higgsfield-auth to authenticate");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP error ${res.status}: ${text}`);
  }

  // Handle 202 Accepted - response will come via SSE GET stream later
  if (res.status === 202) {
    // Fall back to reading from SSE GET stream
    return await readFromSSEStream();
  }

  // Higgsfield MCP always uses SSE format - parse it
  return await parseSSEResponse(res);
}

async function parseSSEResponse(res: globalThis.Response): Promise<unknown> {
  const text = await res.text();
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const dataStr = line.slice(6);
      try {
        const msg = JSON.parse(dataStr) as JSONRPCResponse;
        if (msg.error) {
          throw new Error(`MCP RPC error: ${msg.error.message} (code ${msg.error.code})`);
        }
        return msg.result;
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }

  // Fallback: try parsing the whole body as JSON (non-SSE response)
  try {
    const data = JSON.parse(text) as JSONRPCResponse;
    if (data.error) {
      throw new Error(`MCP RPC error: ${data.error.message} (code ${data.error.code})`);
    }
    return data.result;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`No matching response in SSE stream: ${text.slice(0, 200)}`);
    }
    throw e;
  }
}

async function readFromSSEStream(): Promise<unknown> {
  // Open a GET SSE stream to receive the response
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };

  if (tokens?.access_token) {
    headers["Authorization"] = `Bearer ${tokens.access_token}`;
  }
  if (mcpSessionId) {
    headers["mcp-session-id"] = mcpSessionId;
  }

  const res = await fetch(MCP_SERVER_URL, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SSE stream error ${res.status}: ${text}`);
  }

  return await parseSSEResponse(res);
}

async function initializeMCP(): Promise<void> {
  const result = (await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
    },
    clientInfo: {
      name: "pi-higgsfield",
      version: "1.0.0",
    },
  })) as { protocolVersion?: string; serverInfo?: unknown; capabilities?: unknown };

  mcpProtocolVersion = result.protocolVersion ?? "2024-11-05";

  // Send initialized notification (no response expected, no id)
  await sendNotification("notifications/initialized", {});

  initialized = true;
}

async function sendNotification(
  method: string,
  params?: Record<string, unknown>
): Promise<void> {
  const body = {
    jsonrpc: "2.0",
    method,
    params,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (tokens?.access_token) {
    headers["Authorization"] = `Bearer ${tokens.access_token}`;
  }
  if (mcpSessionId) {
    headers["mcp-session-id"] = mcpSessionId;
  }

  const res = await fetch(MCP_SERVER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from response headers
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSessionId = sid;
}

async function discoverTools(): Promise<MCPToolDef[]> {
  const result = (await mcpRequest("tools/list", {})) as {
    tools?: MCPToolDef[];
  };
  return result.tools ?? [];
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
  const result = (await mcpRequest("tools/call", {
    name: toolName,
    arguments: args,
  })) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
  return result;
}

// ─── OAuth Device Flow ──────────────────────────────────────────────────

async function startDeviceFlow(): Promise<{
  device_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}> {
  const res = await fetch(`${DEVICE_AUTH_URL}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "pi-higgsfield",
      scope: "openid email offline_access",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device auth failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function pollToken(deviceCode: string): Promise<OAuthTokens> {
  const res = await fetch(`${DEVICE_AUTH_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: "pi-higgsfield",
    }),
  });

  const data = await res.json();

  if (res.ok && data.access_token) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      token_type: data.token_type,
      scope: data.scope,
      obtained_at: Date.now(),
    };
  }

  // Check error format
  const detail = data.detail ?? data.error ?? "";
  if (detail === "authorization_pending") {
    throw new Error("pending");
  }
  if (detail === "slow_down") {
    throw new Error("slow_down");
  }
  if (detail === "access_denied") {
    throw new Error("Access denied by user");
  }
  if (detail === "expired_token") {
    throw new Error("Device code expired. Run /higgsfield-auth again.");
  }

  throw new Error(`Token request failed: ${JSON.stringify(data)}`);
}

// ─── Pi Tool Conversion ────────────────────────────────────────────────

function jsonSchemaToTypeBox(schema: Record<string, unknown>): unknown {
  // Convert JSON Schema to TypeBox schema recursively
  // For simplicity, we handle the most common patterns

  if (!schema || typeof schema !== "object") {
    return Type.Any();
  }

  const s = schema as Record<string, unknown>;

  if (s.type === "string") {
    const desc = typeof s.description === "string" ? s.description : undefined;
    return desc ? Type.String({ description: desc }) : Type.String();
  }
  if (s.type === "number" || s.type === "integer") {
    const desc = typeof s.description === "string" ? s.description : undefined;
    return desc ? Type.Number({ description: desc }) : Type.Number();
  }
  if (s.type === "boolean") {
    const desc = typeof s.description === "string" ? s.description : undefined;
    return desc ? Type.Boolean({ description: desc }) : Type.Boolean();
  }
  if (s.type === "array") {
    const items = s.items ? jsonSchemaToTypeBox(s.items as Record<string, unknown>) : Type.Any();
    const desc = typeof s.description === "string" ? s.description : undefined;
    return desc ? Type.Array(items as never, { description: desc }) : Type.Array(items as never);
  }
  if (s.type === "object") {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    if (s.properties && typeof s.properties === "object") {
      for (const [key, propSchema] of Object.entries(
        s.properties as Record<string, Record<string, unknown>>
      )) {
        properties[key] = jsonSchemaToTypeBox(propSchema);
      }
    }

    if (Array.isArray(s.required)) {
      required.push(...(s.required as string[]));
    }

    const desc = typeof s.description === "string" ? s.description : undefined;
    return Type.Object(properties as never, desc ? { description: desc } : undefined);
  }

  // Enum
  if (Array.isArray(s.enum)) {
    return Type.Union(
      (s.enum as Array<string | number>).map((v) => Type.Literal(v))
    );
  }

  // OneOf / AnyOf / AllOf
  if (Array.isArray(s.oneOf)) {
    return Type.Union(
      (s.oneOf as Record<string, unknown>[]).map((item) =>
        jsonSchemaToTypeBox(item) as never
      )
    );
  }

  return Type.Any();
}

async function registerMCPTools(pi: ExtensionAPI): Promise<void> {
  const tools = await discoverTools();

  for (const tool of tools) {
    const piToolName = `mcp_${tool.name}`;

    // Skip if already registered
    if (registeredTools.has(tool.name)) {
      continue;
    }

    try {
      const paramSchema = tool.inputSchema?.properties
        ? jsonSchemaToTypeBox(tool.inputSchema)
        : Type.Object({});

      pi.registerTool({
        name: piToolName,
        label: `MCP: ${tool.name}`,
        description: tool.description ?? `Higgsfield MCP tool: ${tool.name}`,
        promptSnippet: tool.description ?? `Call ${tool.name} via Higgsfield MCP`,
        parameters: paramSchema as never,
        async execute(_toolCallId, params) {
          try {
            const result = await callTool(tool.name, params as Record<string, unknown>);

            const textContent = result.content
              ?.map((c) => c.text ?? JSON.stringify(c))
              .join("\n") ?? "No result";

            return {
              content: [{ type: "text" as const, text: textContent }],
              details: { raw: result },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.startsWith("UNAUTHORIZED:")) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Authentication required. Run /higgsfield-auth to re-authenticate.
Error: ${msg}`,
                  },
                ],
                details: {},
              };
            }
            throw err;
          }
        },
      });

      registeredTools.set(tool.name, piToolName);
    } catch (err) {
      console.error(`Failed to register tool ${tool.name}:`, err);
    }
  }
}

// ─── Extension Entry Point ──────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // ── Load persisted state on session start ───────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    loadTokensFromEntries(ctx);

    // Auto-connect if we have tokens
    if (tokens && !isTokenExpired(tokens) && !initialized) {
      try {
        if (ctx.hasUI) ctx.ui.setStatus("higgsfield", "Connecting to Higgsfield MCP...");
        await initializeMCP();
        persistDiscovery(pi);
        saveTokenFile(ctx);
        await registerMCPTools(pi);
        if (ctx.hasUI) {
          ctx.ui.setStatus("higgsfield", `Higgsfield MCP (${registeredTools.size} tools)`);
          ctx.ui.notify(
            `✅ Connected to Higgsfield MCP with ${registeredTools.size} tools`,
            "success"
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.setStatus("higgsfield", `Higgsfield: ${msg.slice(0, 40)}`);
      }
    } else if (tokens && initialized) {
      if (ctx.hasUI) ctx.ui.setStatus("higgsfield", `Higgsfield MCP (${registeredTools.size} tools)`);
    } else if (!tokens) {
      if (ctx.hasUI) ctx.ui.setStatus("higgsfield", "Higgsfield: not authenticated");
    }
  });

  // ── /higgsfield-auth command ────────────────────────────────────────
  pi.registerCommand("higgsfield-auth", {
    description: "Authenticate with Higgsfield MCP via device flow",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify("Starting Higgsfield device flow...", "info");

        // Start device flow
        const device = await startDeviceFlow();
        ctx.ui.notify(
          `Authorize here: ${device.verification_uri}`,
          "info"
        );

        ctx.ui.setStatus("higgsfield", "Waiting for authorization...");

        // Poll for token
        const startTime = Date.now();
        const maxWait = (device.expires_in ?? 900) * 1000;

        while (Date.now() - startTime < maxWait) {
          await new Promise((r) => setTimeout(r, (device.interval ?? 5) * 1000));

          try {
            tokens = await pollToken(device.device_code);
            // Success!
            persistTokens(pi);
            saveTokenFile(ctx);
            ctx.ui.notify("✅ Authenticated with Higgsfield!", "success");

            // Initialize MCP connection
            ctx.ui.setStatus("higgsfield", "Initializing MCP...");
            await initializeMCP();
            persistDiscovery(pi);

            // Discover and register tools
            ctx.ui.setStatus("higgsfield", "Discovering tools...");
            await registerMCPTools(pi);

            ctx.ui.setStatus(
              "higgsfield",
              `Higgsfield MCP ready (${registeredTools.size} tools)`
            );
            ctx.ui.notify(
              `Loaded ${registeredTools.size} MCP tools from Higgsfield`,
              "success"
            );
            return;

          } catch (pollErr) {
            const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            if (msg === "pending" || msg === "slow_down") {
              // Keep polling - update status occasionally
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              ctx.ui.setStatus("higgsfield", `Waiting for auth... (${elapsed}s)`);
              continue;
            }

            // Real error
            ctx.ui.notify(`❌ ${msg}`, "error");
            ctx.ui.setStatus("higgsfield", `Auth failed: ${msg.slice(0, 40)}`);

            // If denied/expired, clean up
            if (msg.includes("denied") || msg.includes("expired")) {
              tokens = null;
            }
            return;
          }
        }

        // Timeout
        ctx.ui.notify("❌ Device flow timed out. Run /higgsfield-auth again.", "error");
        ctx.ui.setStatus("higgsfield", "Auth timed out");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`❌ ${msg}`, "error");
        ctx.ui.setStatus("higgsfield", `Error: ${msg.slice(0, 40)}`);
      }
    },
  });

  // ── /higgsfield-status command ─────────────────────────────────────
  pi.registerCommand("higgsfield-status", {
    description: "Show Higgsfield MCP connection and auth status",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      lines.push("── Higgsfield MCP ────────────────");

      if (tokens) {
        lines.push(`  Access token: ${tokens.access_token.slice(0, 10)}...`);
        lines.push(`  Obtained:     ${new Date(tokens.obtained_at).toISOString()}`);
        if (tokens.expires_in) {
          const exp = new Date(tokens.obtained_at + tokens.expires_in * 1000);
          lines.push(`  Expires:      ${exp.toISOString()}`);
          lines.push(`  Status:       ${isTokenExpired(tokens) ? "⚠️ EXPIRED" : "✅ valid"}`);
        }
        if (tokens.scope) {
          lines.push(`  Scope:        ${tokens.scope}`);
        }
      } else {
        lines.push("  Tokens:       ❌ none (run /higgsfield-auth)");
      }

      lines.push(`  MCP URL:      ${MCP_SERVER_URL}`);
      lines.push(`  Initialized:  ${initialized ? "✅ yes" : "❌ no"}`);
      lines.push(`  Session ID:   ${mcpSessionId ? mcpSessionId.slice(0, 12) + "..." : "none"}`);
      lines.push(`  Protocol:     ${mcpProtocolVersion ?? "unknown"}`);
      lines.push(`  Tools loaded: ${registeredTools.size}`);

      if (registeredTools.size > 0) {
        lines.push("  Tools:");
        for (const [mcpName, piName] of registeredTools) {
          lines.push(`    ${mcpName} → /${piName}`);
        }
      }

      lines.push("──────────────────────────────────");

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /higgsfield-disconnect command ─────────────────────────────────
  pi.registerCommand("higgsfield-disconnect", {
    description: "Clear Higgsfield MCP tokens and disconnect",
    handler: async (_args, ctx) => {
      tokens = null;
      mcpSessionId = null;
      mcpProtocolVersion = null;
      initialized = false;
      registeredTools.clear();

      ctx.ui.notify("Disconnected from Higgsfield. Run /higgsfield-auth to reconnect.", "info");
      ctx.ui.setStatus("higgsfield", "Disconnected");
    },
  });
}
