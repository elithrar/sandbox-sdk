/**
 * Codemode tools for OpenCode
 *
 * Two tools that work together:
 *
 *   getCodeAPI  — calls codemode(sessionId).api() on the Worker to retrieve
 *                 the TypeScript interface for the sandbox and storage APIs.
 *                 Call this first to learn what methods are available.
 *
 *   runCode     — calls codemode(sessionId).run(code) to execute an async
 *                 JavaScript function in an isolated Dynamic Worker. The Worker
 *                 owns both the API types and the execution runtime.
 */
import { tool } from '@opencode-ai/plugin';
import { getSandbox } from '../cloudflare-sandbox/rpc';

export const getCodeAPI = tool({
  description:
    'Return the TypeScript interface for the sandbox code API. ' +
    'Call this before runCode to see what methods are available and their exact signatures.',
  args: {},
  async execute(_args, context) {
    const api = await getSandbox();
    const cm = await api.codemode(context.sessionID);
    return cm.api();
  }
});

export const runCode = tool({
  description: `\
Execute a block of JavaScript code that calls the sandbox API to complete a task.
Use this when you need to chain multiple sandbox operations — writing files,
running commands, reading outputs — without a round-trip per step.

Call getCodeAPI first to see the full typed interface.

The code must be an async arrow function expression. The \`sandbox\` and \`storage\`
objects are pre-wired to the current session. External \`fetch()\` and network
access are blocked.

Log intermediate values with \`console.log\` — they will be returned alongside
the result. Return the final value from the function.

Example:

\`\`\`javascript
async () => {
  await sandbox.writeFile({ path: '/main.js', content: 'console.log(42)' });
  const r = await sandbox.exec({ command: 'node /main.js' });
  await storage.put({ key: 'output.txt', value: r.stdout });
  return r.stdout;
}
\`\`\``,

  args: {
    code: tool.schema
      .string()
      .describe(
        'An async arrow function expression that uses the sandbox and storage APIs. ' +
          'Must start with `async () => {` or `async () =>`. ' +
          'No TypeScript syntax — plain JavaScript only.'
      )
  },

  async execute(args, context) {
    const api = await getSandbox();
    const cm = await api.codemode(context.sessionID);
    const result = await cm.run(args.code);

    const parts: string[] = [];

    if (result.logs && result.logs.length > 0) {
      parts.push(`Logs:\n${result.logs.map((l) => `  ${l}`).join('\n')}`);
    }

    if (result.error) {
      parts.push(`Error: ${result.error}`);
      return parts.join('\n\n') || `Error: ${result.error}`;
    }

    let resultStr: string;
    try {
      const parsed = JSON.parse(result.resultJson);
      resultStr =
        parsed === null
          ? '(no return value)'
          : typeof parsed === 'string'
            ? parsed
            : JSON.stringify(parsed, null, 2);
    } catch {
      resultStr = result.resultJson;
    }

    parts.push(`Result:\n${resultStr}`);
    return parts.join('\n\n');
  }
});
