import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { redactPII } from "@lhic/trace";

import {
  parseMcpHarness,
  renderMcpHarnessConfig,
} from "./mcp-harness-config.js";
import { runInteractiveDemo } from "./interactive-demo.js";
import type { CliPrompter } from "./interactive.js";
import type { GuiCompanionTab } from "./gui-command-options.js";

const loopbackHost = "127.0.0.1";
const maximumRequestBytes = 64 * 1024;

interface GuiDemoStartInput {
  provider: "openai" | "gemini" | "claude";
  endpoint: string;
  apiKey: string;
  model: string;
  websiteUrl: string;
  slowTask: string;
}

interface GuiMcpConfigInput {
  harness: string;
  workspaceRoot: string;
}

type GuiEvent =
  | { type: "status"; message: string }
  | {
      type: "input_required";
      promptId: string;
      message: string;
      defaultValue?: string;
    }
  | { type: "complete"; message: string }
  | { type: "error"; message: string };

export interface GuiCompanionOptions {
  host?: string;
  port?: number;
  initialTab?: GuiCompanionTab;
  workspaceRoot?: string;
  openBrowser?: (url: string) => Promise<void>;
  runDemo?: (prompter: CliPrompter) => Promise<void>;
}

export interface GuiCompanion {
  url: string;
  close(): Promise<void>;
}

/**
 * Starts a local-only browser companion. It never exposes a network listener
 * outside loopback and requires a per-launch capability token for API calls.
 */
export async function startGuiCompanion(
  options: GuiCompanionOptions = {},
): Promise<GuiCompanion> {
  const host = options.host ?? loopbackHost;
  if (!isLoopbackHost(host)) {
    throw new Error("The GUI companion may bind only to a loopback host.");
  }
  const capabilityToken = randomBytes(32).toString("base64url");
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const initialTab = options.initialTab ?? "demo";
  const openBrowser = options.openBrowser ?? openInDefaultBrowser;
  const runDemo =
    options.runDemo ?? ((prompter) => runInteractiveDemo(prompter));
  let activeDemo: GuiDemoSession | undefined;
  const eventClients = new Set<ServerResponse>();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/") {
        writeHtml(
          response,
          renderCompanionHtml({
            capabilityToken,
            initialTab,
            workspaceRoot,
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/demo/events") {
        if (url.searchParams.get("token") !== capabilityToken) {
          writeError(response, 401, "Unauthorized GUI companion request.");
          return;
        }
        writeEventStream(response, activeDemo, eventClients);
        return;
      }
      if (!hasCapability(request, capabilityToken)) {
        writeError(response, 401, "Unauthorized GUI companion request.");
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/mcp/config") {
        const input = await readJsonBody<GuiMcpConfigInput>(request);
        const harness = parseMcpHarness(input.harness);
        if (!harness || !input.workspaceRoot.trim()) {
          writeError(
            response,
            400,
            "Select a supported MCP client and workspace.",
          );
          return;
        }
        writeJson(response, 200, {
          config: renderMcpHarnessConfig(harness, input.workspaceRoot.trim()),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/demo/start") {
        if (activeDemo?.active) {
          writeError(response, 409, "A GUI demo is already running.");
          return;
        }
        const input = await readJsonBody<GuiDemoStartInput>(request);
        const parsedInput = parseDemoStartInput(input);
        const session = new GuiDemoSession(parsedInput);
        activeDemo = session;
        for (const client of eventClients) session.addClient(client);
        void session.run(runDemo).finally(() => {
          if (activeDemo === session) activeDemo = undefined;
        });
        writeJson(response, 202, { sessionId: session.id });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/demo/respond") {
        if (!activeDemo?.active) {
          writeError(response, 409, "There is no pending GUI demo input.");
          return;
        }
        const input = await readJsonBody<{ promptId: string; value: string }>(
          request,
        );
        activeDemo.respond(input.promptId, input.value);
        writeJson(response, 200, { accepted: true });
        return;
      }
      writeError(response, 404, "GUI companion route not found.");
    } catch (error) {
      writeError(response, 400, safeErrorMessage(error));
    }
  });

  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The GUI companion did not receive a TCP address.");
  }
  const port = (address as AddressInfo).port;
  const url = `http://${host}:${port}/?token=${capabilityToken}&tab=${initialTab}`;

  try {
    await openBrowser(url);
  } catch {
    // The terminal still prints the local URL when a platform opener is absent.
  }

  return {
    url,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

class GuiDemoSession implements CliPrompter {
  public readonly id = randomUUID();
  public readonly interactive = true;
  public active = true;

  private readonly clients = new Set<ServerResponse>();
  private readonly history: GuiEvent[] = [];
  private pendingPrompt:
    | {
        id: string;
        resolve: (value: string) => void;
        defaultValue?: string;
      }
    | undefined;
  private readonly initial: GuiDemoStartInput;

  public constructor(input: GuiDemoStartInput) {
    this.initial = { ...input };
  }

  public async run(
    runDemo: (prompter: CliPrompter) => Promise<void>,
  ): Promise<void> {
    this.emit({
      type: "status",
      message:
        "Starting the visible browser demo. API keys and form values are not displayed here.",
    });
    try {
      await runDemo(this);
      this.emit({ type: "complete", message: "Demo completed." });
    } catch (error) {
      this.emit({ type: "error", message: safeErrorMessage(error) });
    } finally {
      this.active = false;
      this.initial.apiKey = "";
      this.initial.slowTask = "";
      this.initial.websiteUrl = "";
      this.initial.endpoint = "";
    }
  }

  public async prompt(message: string, defaultValue?: string): Promise<string> {
    const initialValue = this.initialValueFor(message);
    if (initialValue !== undefined) return initialValue || defaultValue || "";
    const promptId = randomUUID();
    this.emit({
      type: "input_required",
      promptId,
      message: redactPII(message),
      ...(defaultValue ? { defaultValue: redactPII(defaultValue) } : {}),
    });
    return new Promise<string>((resolve) => {
      this.pendingPrompt = {
        id: promptId,
        resolve,
        ...(defaultValue ? { defaultValue } : {}),
      };
    });
  }

  public async promptSecret(message: string): Promise<string> {
    if (!message.includes("API key") || !this.initial.apiKey) {
      throw new Error("The GUI demo requires an API key in its initial form.");
    }
    const apiKey = this.initial.apiKey;
    this.initial.apiKey = "";
    return apiKey;
  }

  public close(): void {
    // The server owns the session lifetime and the visible browser cleanup.
  }

  public addClient(response: ServerResponse): void {
    this.clients.add(response);
    for (const event of this.history) writeEvent(response, event);
    response.on("close", () => this.clients.delete(response));
  }

  public respond(promptId: string, value: string): void {
    const pending = this.pendingPrompt;
    if (!pending || pending.id !== promptId) {
      throw new Error("This GUI input is no longer pending.");
    }
    this.pendingPrompt = undefined;
    pending.resolve(value.trim() || pending.defaultValue || "");
  }

  private initialValueFor(message: string): string | undefined {
    if (message.startsWith("Model provider")) return this.consume("provider");
    if (message.startsWith("Custom model endpoint"))
      return this.consume("endpoint");
    if (message.startsWith("Use the saved")) return "no";
    if (message.startsWith("Model ID for")) return this.consume("model");
    if (message.startsWith("Public HTTPS website URL"))
      return this.consume("websiteUrl");
    if (message.startsWith("Slow Path task prompt"))
      return this.consume("slowTask");
    return undefined;
  }

  private consume(
    key: "provider" | "endpoint" | "model" | "websiteUrl" | "slowTask",
  ): string {
    const value = this.initial[key];
    this.initial[key] = "" as never;
    return value;
  }

  private emit(event: GuiEvent): void {
    this.history.push(event);
    for (const client of this.clients) writeEvent(client, event);
  }
}

function parseDemoStartInput(value: GuiDemoStartInput): GuiDemoStartInput {
  if (
    value.provider !== "openai" &&
    value.provider !== "gemini" &&
    value.provider !== "claude"
  ) {
    throw new Error("Select OpenAI, Gemini, or Claude for the GUI demo.");
  }
  return {
    provider: value.provider,
    endpoint: requiredGuiString(value.endpoint, "Custom endpoint", 2048, true),
    apiKey: requiredGuiString(value.apiKey, "API key", 4096),
    model: requiredGuiString(value.model, "Model ID", 256),
    websiteUrl: requiredGuiString(value.websiteUrl, "Public website URL", 2048),
    slowTask: requiredGuiString(value.slowTask, "Slow Path task", 12_000),
  };
}

function requiredGuiString(
  value: unknown,
  name: string,
  maximumLength: number,
  optional = false,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const normalized = value.trim();
  if (!optional && !normalized) throw new Error(`${name} is required.`);
  if (normalized.length > maximumLength)
    throw new Error(`${name} is too long.`);
  return normalized;
}

function writeEventStream(
  response: ServerResponse,
  session: GuiDemoSession | undefined,
  eventClients: Set<ServerResponse>,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  response.write(": connected\n\n");
  eventClients.add(response);
  response.on("close", () => eventClients.delete(response));
  session?.addClient(response);
}

function writeEvent(response: ServerResponse, event: GuiEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function writeError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  writeJson(response, status, { error: redactPII(message) });
}

function hasCapability(
  request: IncomingMessage,
  capabilityToken: string,
): boolean {
  return request.headers["x-lhic-companion-token"] === capabilityToken;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes)
      throw new Error("GUI request is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new Error("GUI request must contain JSON.");
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactPII(error.message);
  return "The GUI companion could not complete the request.";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const launch =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

function renderCompanionHtml(input: {
  capabilityToken: string;
  initialTab: GuiCompanionTab;
  workspaceRoot: string;
}): string {
  const boot = scriptJson(input);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LHIC Companion</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#09111f;color:#edf4ff}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#1a3157,#09111f 52%)}main{max-width:960px;margin:0 auto;padding:48px 24px}.eyebrow{color:#71d8ff;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase}h1{font-size:clamp(2rem,6vw,4rem);margin:.2rem 0}p{color:#b9c8dd;line-height:1.5}.tabs{display:flex;gap:8px;margin:32px 0 20px}.tab,button{border:0;border-radius:10px;padding:10px 15px;background:#203758;color:#edf4ff;font-weight:650;cursor:pointer}.tab[aria-selected=true],button.primary{background:#4fd1c5;color:#06201e}.panel{display:none;background:#102039cc;border:1px solid #29466e;border-radius:18px;padding:24px;box-shadow:0 20px 60px #0005}.panel.active{display:block}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.wide{grid-column:1/-1}label{display:grid;gap:7px;color:#c8d8ef;font-size:.9rem}input,select,textarea,pre{box-sizing:border-box;width:100%;border:1px solid #38577f;border-radius:9px;background:#081426;color:#f2f7ff;padding:10px;font:inherit}textarea{min-height:92px;resize:vertical}small{color:#93a9c6}.actions{display:flex;align-items:center;gap:12px;margin-top:18px;flex-wrap:wrap}.notice{margin-top:18px;padding:13px;border-radius:10px;background:#0a1729;color:#a8bdd7;white-space:pre-wrap}.notice.error{background:#3b1824;color:#ffc6d1}.notice.done{background:#10352f;color:#bdf5dc}pre{min-height:180px;white-space:pre-wrap}.hidden{display:none!important}@media(max-width:640px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}main{padding:28px 14px}}
</style></head><body><main><div class="eyebrow">Local-only companion</div><h1>LHIC GUI</h1><p>Run the visible learning demo or prepare a reviewed MCP link. This page is served only on loopback; API keys are never displayed in status output.</p>
<div class="tabs" role="tablist"><button class="tab" id="demo-tab" data-tab="demo" role="tab">Demo</button><button class="tab" id="mcp-tab" data-tab="mcp" role="tab">MCP Link Companion</button></div>
<section class="panel" id="demo-panel" role="tabpanel"><h2>Demonstrate a task</h2><p>Enter the public website and task you want to demonstrate, then configure the model credentials you want to use. The portal opens a separate visible Chromium window; credentials stay local and are never shown in status output.</p><form id="demo-form"><div class="grid"><label class="wide">Task to demonstrate<textarea name="slowTask" required autofocus placeholder="For example: Search for a product and add it to the cart."></textarea></label><label class="wide">Public HTTPS website<input name="websiteUrl" type="url" required placeholder="https://example.com"></label><label>Provider<select name="provider"><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="claude">Claude</option></select></label><label>Model ID<input name="model" required value="gpt-5.6" placeholder="gpt-5.6"></label><label class="wide">API key <small>Stored locally in your OS Keychain; never shown in this GUI.</small><input name="apiKey" type="password" required autocomplete="off"></label><label class="wide">Custom endpoint <small>Optional for provider-compatible or local model servers.</small><input name="endpoint" type="url" placeholder="https://models.example.com/v1/responses"></label></div><div class="actions"><button class="primary" type="submit">Start demonstration</button><span id="demo-state">Ready.</span></div></form><div id="dynamic-input" class="notice hidden"><strong id="dynamic-label"></strong><input id="dynamic-value"><div class="actions"><button class="primary" id="dynamic-send">Continue</button></div></div><div id="demo-log" class="notice" aria-live="polite">The demo browser opens after you start.</div></section>
<section class="panel" id="mcp-panel" role="tabpanel"><h2>MCP Link Companion</h2><p>Generate a client-specific local stdio configuration, review it, then copy it into the client’s MCP settings. This companion never edits client configuration files automatically.</p><form id="mcp-form"><div class="grid"><label>MCP client<select name="harness"><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="vscode">VS Code</option><option value="antigravity">Antigravity</option></select></label><label>Workspace root<input name="workspaceRoot" required></label></div><div class="actions"><button class="primary" type="submit">Generate reviewed config</button><button id="copy-config" type="button">Copy config</button></div></form><pre id="mcp-config">Select a client and generate its configuration.</pre></section>
</main><script>const boot=${boot};const token=boot.capabilityToken;const headers={'Content-Type':'application/json','X-LHIC-Companion-Token':token};let pendingPrompt;const log=document.querySelector('#demo-log');const state=document.querySelector('#demo-state');const dynamic=document.querySelector('#dynamic-input');const dynamicLabel=document.querySelector('#dynamic-label');const dynamicValue=document.querySelector('#dynamic-value');function setTab(tab){for(const value of ['demo','mcp']){document.querySelector('#'+value+'-panel').classList.toggle('active',value===tab);const button=document.querySelector('#'+value+'-tab');button.setAttribute('aria-selected',String(value===tab));}}for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>setTab(button.dataset.tab));setTab(new URLSearchParams(location.search).get('tab')=== 'mcp'?'mcp':boot.initialTab);document.querySelector('[name=workspaceRoot]').value=boot.workspaceRoot;new EventSource('/api/demo/events?token='+encodeURIComponent(token)).onmessage=event=>{const update=JSON.parse(event.data);if(update.type==='status'){log.textContent=update.message;log.className='notice';}if(update.type==='input_required'){pendingPrompt=update.promptId;dynamicLabel.textContent=update.message;dynamicValue.value=update.defaultValue||'';dynamic.classList.remove('hidden');dynamicValue.focus();}if(update.type==='complete'){log.textContent=update.message;log.className='notice done';state.textContent='Completed.';dynamic.classList.add('hidden');}if(update.type==='error'){log.textContent=update.message;log.className='notice error';state.textContent='Stopped.';dynamic.classList.add('hidden');}};document.querySelector('#demo-form').addEventListener('submit',async event=>{event.preventDefault();const form=Object.fromEntries(new FormData(event.currentTarget));state.textContent='Starting…';log.textContent='Preparing the local browser demo…';log.className='notice';const response=await fetch('/api/demo/start',{method:'POST',headers,body:JSON.stringify(form)});const body=await response.json();if(!response.ok){log.textContent=body.error;log.className='notice error';state.textContent='Not started.';return;}state.textContent='Running in visible Chromium…';event.currentTarget.querySelector('[name=apiKey]').value='';});document.querySelector('#dynamic-send').addEventListener('click',async()=>{if(!pendingPrompt)return;await fetch('/api/demo/respond',{method:'POST',headers,body:JSON.stringify({promptId:pendingPrompt,value:dynamicValue.value})});dynamic.classList.add('hidden');dynamicValue.value='';});document.querySelector('#mcp-form').addEventListener('submit',async event=>{event.preventDefault();const form=Object.fromEntries(new FormData(event.currentTarget));const response=await fetch('/api/mcp/config',{method:'POST',headers,body:JSON.stringify(form)});const body=await response.json();document.querySelector('#mcp-config').textContent=response.ok?body.config:body.error;});document.querySelector('#copy-config').addEventListener('click',async()=>{const text=document.querySelector('#mcp-config').textContent;await navigator.clipboard.writeText(text);});</script></body></html>`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
