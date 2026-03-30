import type { ISandbox } from '@cloudflare/sandbox';
import { newBunWebSocketRpcSession, type RpcPromise, RpcTarget } from 'capnweb';
import type Logger from './logger';

export interface PluginApi {
  ping(): RpcPromise<string>;
}

class PluginRpcTarget extends RpcTarget {
  ping(): string {
    return 'pong';
  }
}

export interface RunCodeResult {
  resultJson: string;
  logs: string[];
  error?: string;
}

export interface ICodemode {
  /** Return the TypeScript interface the LLM writes code against. */
  api(): RpcPromise<string>;
  /**
   * Execute an async arrow function in an isolated Dynamic Worker.
   * The function has access to `sandbox.*` and `storage.*` namespaces:
   *
   *   async () => {
   *     await sandbox.writeFile({ path: '/main.js', content: '...' });
   *     const r = await sandbox.exec({ command: 'node /main.js' });
   *     await storage.put({ key: 'output.txt', value: r.stdout });
   *     return r.stdout;
   *   }
   */
  run(code: string): RpcPromise<RunCodeResult>;
}

export interface AgentApi {
  sandbox(sessionId: string): RpcPromise<ISandbox>;
  /** Returns a session-scoped codemode handle with api() and run(code). */
  codemode(sessionId: string): RpcPromise<ICodemode>;
  /**
   * Fetch a web page and return its content as Markdown.
   * The page is fully rendered by a headless browser (Stagehand + Browser
   * Rendering) before conversion, so JavaScript-heavy pages work correctly.
   */
  webfetch(url: string): RpcPromise<string>;
}

const { promise, resolve, reject } = Promise.withResolvers<AgentApi>();

export async function getSandbox(): Promise<AgentApi> {
  return promise;
}

export const setSandbox = resolve;

export function createRPCSocket({ logger }: { logger: Logger }) {
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: 3001,

    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response('WebSocket server running', { status: 200 });
    },

    websocket: {
      open(ws) {
        const { stub, transport } = newBunWebSocketRpcSession(
          ws,
          new PluginRpcTarget()
        );
        ws.data = { transport };
        resolve(stub as unknown as AgentApi);
      },
      message(ws, msg) {
        (ws.data as any).transport.dispatchMessage(msg);
      },
      close(ws, code, reason) {
        (ws.data as any).transport.dispatchClose(code, reason);
        reject(new Error(`WebSocket closed: code=${code} reason=${reason}`));
      },
      error(ws, err) {
        (ws.data as any).transport.dispatchError(err);
        reject(err);
      }
    }
  });

  logger.info(`WebSocket server listening on port ${server.port}`);
  return server;
}
