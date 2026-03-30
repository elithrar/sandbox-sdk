/**
 * OpenCode on Cloudflare — with sandboxed code execution
 *
 * Two Sandbox containers:
 *   OPENCODE — runs `opencode serve` with the sandbox plugin
 *   SANDBOX  — isolated code execution (one instance per session)
 *
 * The OpenCodeSandbox DO handles all persistent state:
 *   - Starts opencode serve
 *   - Establishes Cap'n Web WebSocket to the plugin
 *   - Exposes AgentRpcApi so tool calls route to per-session CodeSandbox instances
 */

import { Stagehand } from '@browserbasehq/stagehand';
import type { ResolvedProvider } from '@cloudflare/codemode';
import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { switchPort } from '@cloudflare/containers';
import { endpointURLString } from '@cloudflare/playwright';
import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import {
  createOpencodeServer,
  proxyToOpencode
} from '@cloudflare/sandbox/opencode';
import type { Config } from '@opencode-ai/sdk/v2';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';
import { WorkersAIClient } from './workersAIClient';

export { ContainerProxy } from '@cloudflare/containers';

const BRIDGE_PORT = 3001;

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Derive a sandbox-safe ID from an OpenCode session ID.
 * OpenCode session IDs may contain uppercase letters, which are not allowed in
 * sandbox IDs. We hash the session ID and take the first 8 hex characters.
 */
async function sandboxId(opencodeSessionId: string): Promise<string> {
  const encoded = new TextEncoder().encode(opencodeSessionId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 8);
}

// ── Config ───────────────────────────────────────────────────────

const getConfig = (env: Env): Config => ({
  provider: {
    openai: {
      options: { apiKey: env.OPENAI_API_KEY }
    }
  }
});

// ── Codemode RPC target ──────────────────────────────────────────

// TypeScript declarations injected into the Dynamic Worker's sandbox.
// Returned verbatim by api() so the LLM sees the exact same types it codes against.
const CODEMODE_API_TYPES = `\
// Available inside the async function as \`sandbox.*\`:
declare const sandbox: {
  /** Run a shell command. Returns stdout, stderr, exitCode, success. */
  exec(args: { command: string; timeout?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
  }>;

  /** Write UTF-8 content to a file path in the sandbox. */
  writeFile(args: { path: string; content: string }): Promise<{ ok: boolean; path: string }>;

  /** Read the full text content of a file from the sandbox. */
  readFile(args: { path: string }): Promise<{ content: string }>;

  /** List files and directories at a given path (default: '/'). */
  listFiles(args?: { path?: string }): Promise<{ entries: unknown }>;
};

// Durable R2 storage, namespaced to the current session.
declare const storage: {
  /** Persist a string value under key. Overwrites any existing value. */
  put(args: { key: string; value: string }): Promise<{ ok: boolean }>;
  /** Retrieve a value by key. Returns null if not found. */
  get(args: { key: string }): Promise<{ value: string | null }>;
};

/**
 * Fetch a web page and return its content as Markdown.
 * Uses Stagehand + Cloudflare Browser Rendering to fully render the page
 * (including JavaScript) before extracting readable content.
 */
declare function webfetch(url: string): Promise<string>;`;

/**
 * Per-session codemode handle. Owns both the API description and code execution,
 * keeping all Dynamic Worker logic in one place.
 */
class CodemodeRpcTarget extends RpcTarget {
  #env: Env;
  #sessionId: string;

  constructor(env: Env, sessionId: string) {
    super();
    this.#env = env;
    this.#sessionId = sessionId;
  }

  /** Return the TypeScript interface the LLM writes code against. */
  api(): string {
    return CODEMODE_API_TYPES;
  }

  /** Execute LLM-generated JavaScript in an isolated Dynamic Worker. */
  async run(
    code: string
  ): Promise<{ resultJson: string; logs: string[]; error?: string }> {
    const sb = getSandbox(this.#env.SANDBOX, await sandboxId(this.#sessionId));

    const sandboxFns: Record<string, (...args: unknown[]) => Promise<unknown>> =
      {
        exec: async (...args: unknown[]) => {
          const { command, timeout } = args[0] as {
            command: string;
            timeout?: number;
          };
          const r = await sb.exec(command, { timeout });
          return {
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
            success: r.success
          };
        },
        writeFile: async (...args: unknown[]) => {
          const { path, content } = args[0] as {
            path: string;
            content: string;
          };
          await sb.writeFile(path, content);
          return { ok: true, path };
        },
        readFile: async (...args: unknown[]) => {
          const { path } = args[0] as { path: string };
          const r = await sb.readFile(path);
          return { content: r.content };
        },
        listFiles: async (...args: unknown[]) => {
          const { path = '/' } = (args[0] ?? {}) as { path?: string };
          const entries = await sb.listFiles(path);
          return { entries };
        }
      };

    const bucket = this.#env.STORAGE;
    const prefix = await sandboxId(this.#sessionId);
    const storageFns: Record<string, (...args: unknown[]) => Promise<unknown>> =
      {
        put: async (...args: unknown[]) => {
          const { key, value } = args[0] as { key: string; value: string };
          await bucket.put(`${prefix}/${key}`, value);
          return { ok: true };
        },
        get: async (...args: unknown[]) => {
          const { key } = args[0] as { key: string };
          const obj = await bucket.get(`${prefix}/${key}`);
          return { value: obj ? await obj.text() : null };
        }
      };

    const executor = new DynamicWorkerExecutor({
      loader: this.#env.CODEMODE_LOADER
    });
    const result = await executor.execute(code, [
      { name: 'sandbox', fns: sandboxFns },
      { name: 'storage', fns: storageFns }
    ]);

    return {
      resultJson: JSON.stringify(result.result ?? null),
      logs: result.logs ?? [],
      error: result.error
    };
  }
}

// ── Plugin RPC interface ─────────────────────────────────────────

/** Methods the Worker can call on the plugin over Cap'n Web. */
interface PluginApi {
  ping(): Promise<string>;
}

// ── Agent RPC target ─────────────────────────────────────────────

/**
 * Exposed to the plugin inside the OpenCode container via Cap'n Web.
 * Each method takes a sessionId to route to the correct per-session resource.
 */
class AgentRpcApi extends RpcTarget {
  #env: Env;

  constructor(env: Env) {
    super();
    this.#env = env;
  }

  async sandbox(sessionId: string): Promise<ReturnType<typeof getSandbox>> {
    return getSandbox(this.#env.SANDBOX, await sandboxId(sessionId));
  }

  codemode(sessionId: string) {
    return new CodemodeRpcTarget(this.#env, sessionId);
  }

  /**
   * Fetch a web page and return its content as Markdown.
   * Uses Stagehand + Cloudflare Browser Rendering to fully render the page
   * (including JavaScript) before extracting readable content.
   */
  async webfetch(url: string): Promise<string> {
    const stagehand = new Stagehand({
      env: 'LOCAL',
      localBrowserLaunchOptions: {
        cdpUrl: endpointURLString(this.#env.BROWSER)
      },
      llmClient: new WorkersAIClient(this.#env.AI),
      verbose: 0
    });

    await stagehand.init();
    try {
      await stagehand.page.goto(url, { waitUntil: 'networkidle' });

      const { extraction } = await stagehand.page.extract(
        'Summarize the main body of this page'
      );

      return extraction ?? '';
    } finally {
      await stagehand.close();
    }
  }
}

// ── OpenCodeSandbox DO ───────────────────────────────────────────

/**
 * Sandbox subclass that runs OpenCode and manages the Cap'n Web bridge.
 * All persistent WebSocket / RPC state lives here in the DO, not in the Worker.
 */
export class OpenCodeSandbox extends Sandbox<Env> {
  private bridgeConnected = false;
  requiredPorts = [BRIDGE_PORT];

  override async onStart() {
    super.onStart();
    console.log('[opencode-do] container started, connecting bridge');
    this.connectBridge().catch((err) =>
      console.error('[bridge] connection failed:', err)
    );
  }

  public async waitUntilReady(): Promise<void> {
    await this.waitForPort({ portToCheck: BRIDGE_PORT, waitInterval: 1000 });
  }

  /**
   * Connect to the plugin's WebSocket server and establish Cap'n Web RPC.
   * Runs inside the DO so the WebSocket persists across Worker requests.
   */
  private async connectBridge() {
    if (this.bridgeConnected) return;

    await this.waitUntilReady();

    const req = new Request(`http://localhost:${BRIDGE_PORT}`, {
      headers: { Upgrade: 'Websocket', Connection: 'upgrade' }
    });
    const res = await super.fetch(switchPort(req, BRIDGE_PORT));
    const socket = res.webSocket;

    if (!socket) {
      throw new Error('WebSocket upgrade to plugin port failed');
    }

    socket.accept();

    const agentApi = new AgentRpcApi(this.env);
    const plugin = newWebSocketRpcSession<PluginApi>(socket, agentApi);
    const pong = await plugin.ping();

    this.bridgeConnected = true;
    console.log(`[opencode-do] Cap'n Web bridge established (${pong})`);
  }
}

// ── CodeSandbox DO ───────────────────────────────────────────────

export class CodeSandbox extends Sandbox {}

// ── Log streaming ────────────────────────────────────────────────

async function streamLogsToConsole(
  sandbox: ReturnType<typeof getSandbox>,
  processId: string
) {
  try {
    const stream = await sandbox.streamProcessLogs(processId);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (buffer.includes('\n')) {
        const newlineIdx = buffer.indexOf('\n');
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith('data: ')) continue;

        const payload = line.slice(6);
        try {
          const event = JSON.parse(payload);
          if (event.data) {
            process.stdout.write(`[opencode] ${event.data}`);
          }
        } catch {
          if (payload.trim()) {
            console.log(`[opencode] ${payload}`);
          }
        }
      }
    }

    if (buffer.trim()) {
      console.log(`[opencode] ${buffer}`);
    }
  } catch (err) {
    console.error('[opencode] log stream error:', err);
  }
}

// ── Worker (stateless — just proxies to the DO) ──────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const opencode = getSandbox(env.OPENCODE, 'opencode');

    // Start the OpenCode server (idempotent — reuses if already running)
    const server = await createOpencodeServer(opencode, {
      directory: '/home/user/project',
      config: getConfig(env),
      onStart: async ({ process: proc }) => {
        console.log(`[opencode] process started (id=${proc.id})`);
        streamLogsToConsole(opencode, proc.id);
      }
    });
    await opencode.waitUntilReady();

    // Proxy everything to OpenCode (handles SPA, API, ?url= redirect)
    return proxyToOpencode(request, opencode, server);
  }
};
