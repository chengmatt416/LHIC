#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [manifestPath, taskId, statePath, requestedPort = "0"] =
  process.argv.slice(2);
if (!manifestPath || !taskId || !statePath) {
  throw new Error(
    "Usage: fixture-server.mjs <manifest> <task-id> <state-path> [port]",
  );
}
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const task = manifest.tasks.find((candidate) => candidate.id === taskId);
if (!task) throw new Error(`Unknown browser fixture ${taskId}.`);
let state = initialState(taskId);
await persist();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(render(taskId, task.seed));
    return;
  }
  if (request.method === "GET" && url.pathname === "/state") {
    json(response, 200, state);
    return;
  }
  if (request.method === "POST" && url.pathname === "/state") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const patch = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state = merge(state, patch);
    await persist();
    json(response, 200, state);
    return;
  }
  json(response, 404, { error: "Not found" });
});

server.listen(Number(requestedPort), "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server did not bind TCP.");
  console.log(
    JSON.stringify({ type: "ready", url: `http://127.0.0.1:${address.port}/` }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function persist() {
  await writeFile(resolve(statePath), `${JSON.stringify(state, null, 2)}\n`);
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function merge(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return current;
  return { ...current, ...patch };
}

function initialState(id) {
  switch (id) {
    case "browser-semantic-search":
      return { query: "", selected: "" };
    case "browser-form-validation":
      return { saved: false, validationErrors: 0 };
    case "browser-stale-list":
      return { archived: [], wrongArchives: 0 };
    case "browser-dialog-recovery":
      return { enabled: false, confirmed: false };
    default:
      return {};
  }
}

function render(id, seed) {
  const wrapper = `fixture-${seed % 97}`;
  const common = `<style>body{font:16px system-ui;margin:40px;max-width:760px}button,input{font:inherit;margin:6px;padding:8px}dialog{padding:24px}.row{display:flex;gap:12px;align-items:center}</style>`;
  const post = `const post=(patch)=>fetch('/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});`;
  let body;
  if (id === "browser-semantic-search") {
    body = `<main class="${wrapper}"><h1>Knowledge search</h1><label>Query <input id="query" aria-label="Search query"></label><button id="search">Search</button><section id="results" aria-live="polite"></section></main><script>${post}search.onclick=()=>{post({query:query.value});results.innerHTML='<button data-id="preview">Stable preview</button><div><button data-id="stable">Stable release notes</button></div><button data-id="beta">Beta release notes</button>';results.querySelectorAll('button').forEach(button=>button.onclick=()=>post({selected:button.dataset.id}));};</script>`;
  } else if (id === "browser-form-validation") {
    body = `<main class="${wrapper}"><h1>Profile</h1><div id="fields"><label>Email <input id="email" aria-label="Email"></label><label>Name <input id="name" aria-label="Name"></label></div><button id="save">Save profile</button><p id="error" role="alert"></p></main><script>${post}if(${seed}%2)fields.prepend(fields.lastElementChild);save.onclick=()=>{const errors=/^[^@]+@[^@]+$/.test(email.value)&&name.value.trim()?0:1;error.textContent=errors?'Enter a name and valid email.':'';post({saved:errors===0,validationErrors:errors});};</script>`;
  } else if (id === "browser-stale-list") {
    body = `<main class="${wrapper}"><h1>Invoices</h1><div id="list"></div></main><script>${post}let order=['INV-201','INV-204','INV-207'];const draw=()=>{list.innerHTML=order.map(id=>'<div class="row"><span>'+id+'</span><button aria-label="Archive '+id+'" data-id="'+id+'">Archive</button></div>').join('');list.querySelectorAll('button').forEach(button=>button.onclick=()=>{const id=button.dataset.id;post(id==='INV-204'?{archived:['INV-204']}:{wrongArchives:1});button.closest('.row').remove();});};draw();setTimeout(()=>{order=['INV-207','INV-201','INV-204'];draw();},900);</script>`;
  } else {
    body = `<main class="${wrapper}"><h1>Experimental setting</h1><button id="enable">Enable feature</button><dialog id="confirmDialog"><p id="question">Confirm feature activation?</p><button id="confirm">Confirm</button><button onclick="confirmDialog.close()">Cancel</button></dialog></main><script>${post}enable.onclick=()=>confirmDialog.showModal();setTimeout(()=>question.textContent='Approve requested setting?',700);confirm.onclick=()=>{post({enabled:true,confirmed:true});confirmDialog.close();enable.textContent='Enabled';enable.disabled=true;};</script>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>LHIC benchmark ${id}</title>${common}</head><body>${body}</body></html>`;
}
