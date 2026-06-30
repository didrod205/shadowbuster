import { scanBytes } from "../src/index.js";
import type { ScanResult, Finding } from "../src/index.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $<HTMLDivElement>("drop");
const fileInput = $<HTMLInputElement>("file");
const browse = $<HTMLButtonElement>("browse");
const statusEl = $<HTMLElement>("status");
const resultEl = $<HTMLElement>("result");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const sevEmoji: Record<string, string> = { critical: "🔴", warning: "🟠", info: "🔵" };

const blobUrls: string[] = [];
function imageUrl(mime: string, bytes: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
  blobUrls.push(url);
  return url;
}

function renderRecovered(f: Finding): string {
  if (!f.recovered) return "";
  if (f.recovered.type === "image") {
    const url = imageUrl(f.recovered.mime, f.recovered.bytes);
    return `<div class="reveal img-wrap" data-revealed="false">
      <div class="img-wrap"><img class="payload" src="${url}" alt="recovered image" loading="lazy" /></div>
      <span class="bar"></span>
    </div>`;
  }
  return `<div class="reveal" data-revealed="false">
    <pre class="payload">${esc(f.recovered.text)}</pre>
    <span class="bar"></span>
  </div>`;
}

function renderFinding(f: Finding): string {
  return `<div class="card s-${f.severity}">
    <div class="card-head">
      <span class="ttl">${sevEmoji[f.severity] ?? ""} ${esc(f.title)}</span>
      ${f.location ? `<span class="loc">${esc(f.location)}</span>` : ""}
    </div>
    <div class="desc">${esc(f.summary)}</div>
    ${renderRecovered(f)}
  </div>`;
}

function render(r: ScanResult): void {
  for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u);

  const n = r.findings.length;
  const head = n
    ? `<div class="summary-line"><span class="num">${n}</span> thing${n > 1 ? "s were" : " was"} hidden in <code>${esc(r.fileName)}</code> but never removed.</div>`
    : `<div class="summary-line clean"><span class="num">Clean.</span> Nothing recoverable found in <code>${esc(r.fileName)}</code> by ShadowBuster's checks.</div>`;

  const toolbar = r.findings.some((f) => f.recovered)
    ? `<div class="toolbar"><button id="reveal-all" type="button">🕶️ Reveal everything</button><button id="recover" type="button">⤓ This is my file — show me what to fix</button></div>`
    : "";

  const notes = r.notes.length ? `<div class="notes">${r.notes.map((n) => `· ${esc(n)}`).join("<br>")}</div>` : "";

  resultEl.innerHTML = head + toolbar + r.findings.map(renderFinding).join("") + notes;

  resultEl.querySelectorAll<HTMLElement>(".reveal").forEach((el) => {
    el.addEventListener("click", () => {
      el.dataset["revealed"] = el.dataset["revealed"] === "true" ? "false" : "true";
    });
  });
  const revealAll = document.getElementById("reveal-all");
  revealAll?.addEventListener("click", () => {
    resultEl.querySelectorAll<HTMLElement>(".reveal").forEach((el) => (el.dataset["revealed"] = "true"));
  });
  const recover = document.getElementById("recover");
  recover?.addEventListener("click", () => {
    alert(
      "To truly remove this content before sharing:\n\n• PDF: print/flatten to image, or use a real redaction tool that deletes the text.\n• Excel: right-click → Delete the hidden/very-hidden sheets; clear hidden rows/columns.\n• Word: accept all tracked changes, then Inspect Document → Remove comments & hidden text.\n• PowerPoint: re-crop and compress images (this discards cropped pixels); delete speaker notes.\n• Images: re-export/re-save; don't overwrite a larger file in place.",
    );
  });

  // Auto-peel the first critical reveal for the demo moment.
  const first = resultEl.querySelector<HTMLElement>(".s-critical .reveal");
  if (first) setTimeout(() => (first.dataset["revealed"] = "true"), 850);
}

async function handleFile(name: string, bytes: Uint8Array): Promise<void> {
  statusEl.textContent = `reading ${name} locally…`;
  resultEl.innerHTML = "";
  try {
    const r = await scanBytes(name, bytes);
    statusEl.textContent = "";
    render(r);
  } catch (e) {
    statusEl.textContent = `Could not read ${name}: ${(e as Error).message}`;
  }
}

async function fromFile(file: File): Promise<void> {
  await handleFile(file.name, new Uint8Array(await file.arrayBuffer()));
}

// --- drag & drop ---
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
  }),
);
drop.addEventListener("drop", (e) => {
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) void fromFile(file);
});
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") fileInput.click();
});
browse.addEventListener("click", (e) => {
  e.stopPropagation();
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void fromFile(file);
});

// --- samples ---
document.querySelectorAll<HTMLButtonElement>(".sample").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const name = btn.dataset["file"]!;
    statusEl.textContent = `loading sample ${name}…`;
    try {
      const res = await fetch(`./samples/${name}`, { cache: "force-cache" });
      const bytes = new Uint8Array(await res.arrayBuffer());
      await handleFile(name, bytes);
    } catch (e) {
      statusEl.textContent = `Could not load sample: ${(e as Error).message}`;
    }
  });
});
