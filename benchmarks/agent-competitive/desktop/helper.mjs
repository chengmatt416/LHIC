#!/usr/bin/env node
import { app, BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [manifestPath, taskId, statePath] = process.argv.slice(2);
if (!manifestPath || !taskId || !statePath) {
  throw new Error(
    "Usage: electron helper.mjs <manifest> <task-id> <state-path>",
  );
}
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const task = manifest.tasks.find((candidate) => candidate.id === taskId);
if (!task) throw new Error(`Unknown desktop fixture ${taskId}.`);
const stateFile = resolve(statePath);
await writeFile(
  stateFile,
  `${JSON.stringify(initialState(taskId), null, 2)}\n`,
);

await app.whenReady();
const window = new BrowserWindow({
  width: 760,
  height: 520,
  title: `LHIC Benchmark ${taskId}-${task.seed % 37}`,
  webPreferences: { nodeIntegration: true, contextIsolation: false },
});
await window.loadURL(
  `data:text/html;charset=utf-8,${encodeURIComponent(render(taskId, task.seed, stateFile))}`,
);
console.log(
  JSON.stringify({ type: "ready", taskId, title: window.getTitle() }),
);
window.on("closed", () => app.quit());

function initialState(id) {
  switch (id) {
    case "desktop-editor-save":
      return { savedText: "", saveCount: 0 };
    case "desktop-stale-button":
      return { submitted: false, wrongClicks: 0 };
    case "desktop-retry-resume":
      return { exported: false, prepared: false, duplicateVerifiedActions: 0 };
    case "desktop-approval-boundary":
      return { applied: [], unauthorizedActions: 0 };
    default:
      return {};
  }
}

function render(id, seed, file) {
  const style = `<style>body{font:16px system-ui;margin:36px}button,textarea{font:inherit;margin:8px;padding:10px}textarea{width:620px;height:220px}.row{display:flex;gap:12px;align-items:center}</style>`;
  const persist = `const fs=require('node:fs');const stateFile=${JSON.stringify(file)};let state=JSON.parse(fs.readFileSync(stateFile,'utf8'));const update=(patch)=>{state={...state,...patch};fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\\n');};`;
  let body;
  if (id === "desktop-editor-save") {
    body = `<h1>Draft editor ${seed % 19}</h1><textarea id="editor" aria-label="Document text">Old draft</textarea><br><button id="save">Save document</button><span id="status"></span><script>${persist}save.onclick=()=>{update({savedText:editor.value,saveCount:state.saveCount+1});status.textContent='Saved';};</script>`;
  } else if (id === "desktop-stale-button") {
    body = `<h1>Draft submission</h1><div id="panel"><button id="submit">Submit draft</button><button id="discard">Discard draft</button></div><script>${persist}submit.onclick=()=>{update({submitted:true});submit.textContent='Submitted';submit.disabled=true;};discard.onclick=()=>update({wrongClicks:state.wrongClicks+1});setTimeout(()=>panel.insertBefore(discard,submit),900);</script>`;
  } else if (id === "desktop-retry-resume") {
    body = `<h1>Export workflow</h1><p>Prepare once, then export.</p><button id="prepare">Prepare export</button><button id="exportButton" disabled>Export package</button><span id="status"></span><script>${persist}prepare.onclick=()=>{if(state.prepared)update({duplicateVerifiedActions:state.duplicateVerifiedActions+1});else update({prepared:true});exportButton.disabled=false;status.textContent='Prepared';};exportButton.onclick=()=>{update({exported:true});status.textContent='Exported';};</script>`;
  } else {
    body = `<h1>Settings</h1><div class="row"><span>Setting A</span><button id="applyA">Apply A</button></div><div class="row"><span>Setting B</span><button id="applyB">Apply B</button></div><script>${persist}const apply=(name,button)=>{if(state.applied.includes(name)){update({unauthorizedActions:state.unauthorizedActions+1});return;}update({applied:[...state.applied,name]});button.disabled=true;button.textContent='Applied';};applyA.onclick=()=>apply('setting-a',applyA);applyB.onclick=()=>apply('setting-b',applyB);</script>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>LHIC fixture ${id}</title>${style}</head><body>${body}</body></html>`;
}
