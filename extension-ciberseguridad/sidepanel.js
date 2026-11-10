import {
  EMBED_MODEL,
  DEFAULT_CHAT_MODEL,
  SYSTEM_PROMPT,
  listModels,
  embed,
  chatStream,
  buildIndex,
  docsSignature,
  retrieve,
} from "./rag.js";

const MIN_SCORE = 0.35; // por debajo, se considera que no hay contexto relevante
const MAX_HISTORY = 6;  // mensajes previos que se recuerdan
const MAX_SAVED_MESSAGES = 30;

const $ = (id) => document.getElementById(id);
const store = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};

const state = {
  settings: { chatModel: DEFAULT_CHAT_MODEL, topK: 4 },
  index: null,     // { signature, chunks }
  messages: [],    // { role, content, sources? }
  ready: false,
  busy: false,
  controller: null,
};

// ------------------------------ Markdown mínimo ------------------------------
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
// Todo el texto se escapa antes de aplicar formato, así que no se puede inyectar HTML.
function renderMarkdown(src) {
  const bloques = [];
  const texto = src.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, codigo) => {
    bloques.push(codigo.replace(/\n$/, ""));
    return `\u0000${bloques.length - 1}\u0000`;
  });
  const out = [];
  let lista = null;
  const cerrar = () => {
    if (lista) { out.push(`</${lista}>`); lista = null; }
  };
  for (const cruda of esc(texto).split("\n")) {
    const linea = cruda.trimEnd();
    let m;
    if (!linea.trim()) { cerrar(); continue; }
    if ((m = linea.match(/^\u0000(\d+)\u0000$/))) {
      cerrar();
      out.push(`<pre><code>${esc(bloques[+m[1]])}</code></pre>`);
      continue;
    }
    if ((m = linea.match(/^#{1,6}\s+(.*)$/))) { cerrar(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if ((m = linea.match(/^\s*[-*•]\s+(.*)$/))) {
      if (lista !== "ul") { cerrar(); out.push("<ul>"); lista = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = linea.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (lista !== "ol") { cerrar(); out.push("<ol>"); lista = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    cerrar();
    out.push(`<p>${inline(linea)}</p>`);
  }
  cerrar();
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre><code>${esc(bloques[+i])}</code></pre>`);
}

// --------------------------------- Interfaz ---------------------------------
function setStatus(online) {
  const el = $("status");
  el.textContent = online ? "● Ollama conectado" : "● Sin conexión";
  el.className = "status " + (online ? "on" : "off");
}

function showBanner(html, { retry = false } = {}) {
  const b = $("banner");
  b.innerHTML = html;
  if (retry) {
    const btn = document.createElement("button");
    btn.textContent = "Reintentar";
    btn.addEventListener("click", () => connect());
    b.appendChild(document.createElement("br"));
    b.appendChild(btn);
  }
  b.classList.remove("hidden");
}
function hideBanner() { $("banner").classList.add("hidden"); }

function scrollAbajo() {
  const m = $("messages");
  m.scrollTop = m.scrollHeight;
}

function addSources(contenedor, fuentes) {
  if (!fuentes || !fuentes.length) return;
  const nombres = [...new Set(fuentes.map((f) => f.source))].sort();
  const det = document.createElement("details");
  det.className = "sources";
  const sum = document.createElement("summary");
  sum.textContent = `📚 Fuentes consultadas: ${nombres.join(", ")}`;
  det.appendChild(sum);
  for (const f of fuentes) {
    const d = document.createElement("div");
    d.className = "frag";
    const small = document.createElement("small");
    small.textContent = `${f.source} · similitud ${f.score.toFixed(2)}`;
    d.appendChild(small);
    d.appendChild(document.createTextNode(f.text));
    det.appendChild(d);
  }
  contenedor.appendChild(det);
}

function addMessage(role, content, sources) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user") bubble.textContent = content;
  else bubble.innerHTML = renderMarkdown(content);
  wrap.appendChild(bubble);
  if (sources) addSources(wrap, sources);
  $("messages").appendChild(wrap);
  scrollAbajo();
  return { wrap, bubble };
}

function renderChat() {
  $("messages").innerHTML = "";
  for (const m of state.messages) addMessage(m.role, m.content, m.sources);
  $("examples").classList.toggle("hidden", state.messages.length > 0);
}

function setBusy(busy) {
  state.busy = busy;
  $("send").disabled = busy;
  $("send").classList.toggle("hidden", busy);
  $("stop").classList.toggle("hidden", !busy);
  $("input").disabled = busy;
  if (!busy) $("input").focus();
}

async function saveChat() {
  await store.set("chat", state.messages.slice(-MAX_SAVED_MESSAGES));
}

// --------------------------- Documentos e índice ----------------------------
async function bundledDocs() {
  const r = await fetch(chrome.runtime.getURL("kb/docs.json"));
  return r.json();
}
async function userDocs() {
  return (await store.get("userDocs")) || [];
}
async function allDocs() {
  return [...(await bundledDocs()), ...(await userDocs())];
}

async function ensureIndex(force = false) {
  const docs = await allDocs();
  const firma = docsSignature(docs);
  let idx = await store.get("index");
  if (!force && idx && idx.signature === firma) {
    state.index = idx;
    return;
  }
  showBanner("Indexando documentos… 0%");
  const chunks = await buildIndex(docs, (hecho, total) =>
    showBanner(`Indexando documentos… ${Math.round((hecho / total) * 100)}% (${hecho}/${total})`)
  );
  idx = { signature: firma, chunks, builtAt: Date.now() };
  await store.set("index", idx);
  state.index = idx;
  hideBanner();
}

async function renderDocList() {
  const ul = $("docList");
  ul.innerHTML = "";
  for (const d of await bundledDocs()) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${esc(d.name)}<span class="tag">incluido</span></span>`;
    ul.appendChild(li);
  }
  for (const d of await userDocs()) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = d.name;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "tuyo";
    span.appendChild(tag);
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Eliminar";
    del.addEventListener("click", async () => {
      const resto = (await userDocs()).filter((x) => x.name !== d.name);
      await store.set("userDocs", resto);
      await renderDocList();
      await reindex();
    });
    li.append(span, del);
    ul.appendChild(li);
  }
}

async function reindex() {
  try {
    await ensureIndex(true);
  } catch (e) {
    showBanner(`Error al indexar: ${esc(e.message)}`, { retry: true });
  }
}

async function addFiles(files) {
  const actuales = await userDocs();
  for (const f of files) {
    const text = await f.text();
    if (!text.trim()) continue;
    const i = actuales.findIndex((d) => d.name === f.name);
    if (i >= 0) actuales[i] = { name: f.name, text };
    else actuales.push({ name: f.name, text });
  }
  await store.set("userDocs", actuales);
  await renderDocList();
  await reindex();
}

// ------------------------------ Conexión Ollama -----------------------------
async function connect() {
  state.ready = false;
  let modelos;
  try {
    modelos = await listModels();
    setStatus(true);
  } catch (e) {
    setStatus(false);
    if (/403/.test(e.message)) {
      showBanner(
        "Ollama rechaza la conexión (HTTP 403). Define la variable de entorno " +
        "<code>OLLAMA_ORIGINS</code> con el valor <code>chrome-extension://*</code>, " +
        "reinicia Ollama y pulsa Reintentar.",
        { retry: true }
      );
    } else {
      showBanner(
        "No se puede conectar con Ollama. Abre la aplicación Ollama (o ejecuta <code>ollama serve</code>) " +
        "y pulsa Reintentar.",
        { retry: true }
      );
    }
    return false;
  }

  if (!modelos.some((m) => m.startsWith(EMBED_MODEL))) {
    showBanner(`Falta el modelo de embeddings. Ejecuta en una terminal: <code>ollama pull ${EMBED_MODEL}</code>`, { retry: true });
    return false;
  }
  const chat = modelos.filter((m) => !m.includes("embed"));
  if (!chat.length) {
    showBanner(`No hay ningún modelo de chat. Ejecuta: <code>ollama pull ${DEFAULT_CHAT_MODEL}</code>`, { retry: true });
    return false;
  }

  const sel = $("modelSelect");
  sel.innerHTML = "";
  for (const m of chat) sel.add(new Option(m, m));
  const elegido = chat.find((m) => m === state.settings.chatModel) ||
                  chat.find((m) => m.startsWith(state.settings.chatModel)) ||
                  chat[0];
  sel.value = elegido;
  state.settings.chatModel = elegido;

  try {
    await ensureIndex();
  } catch (e) {
    showBanner(`Error al indexar: ${esc(e.message)}`, { retry: true });
    return false;
  }
  hideBanner();
  state.ready = true;
  return true;
}

// ---------------------------------- Chat RAG --------------------------------
async function send(texto) {
  texto = texto.trim();
  if (!texto || state.busy) return;
  if (!state.ready && !(await connect())) return;

  $("examples").classList.add("hidden");
  setBusy(true);
  $("input").value = "";
  addMessage("user", texto);
  const { wrap, bubble } = addMessage("assistant", "");
  bubble.classList.add("cursor");

  const controller = new AbortController();
  state.controller = controller;
  let respuesta = "";
  let relevantes = [];

  try {
    const [qv] = await embed([texto]);
    relevantes = retrieve(qv, state.index.chunks, state.settings.topK).filter((f) => f.score >= MIN_SCORE);
    const contexto = relevantes.length
      ? relevantes.map((f) => `[${f.source}]\n${f.text}`).join("\n\n")
      : "(No se encontró contexto relevante en la base de conocimiento.)";

    const historial = state.messages.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content }));
    const mensajes = [
      { role: "system", content: SYSTEM_PROMPT },
      ...historial,
      { role: "user", content: `CONTEXTO:\n${contexto}\n\nPREGUNTA: ${texto}` },
    ];

    for await (const trozo of chatStream({ model: state.settings.chatModel, messages: mensajes, signal: controller.signal })) {
      respuesta += trozo;
      bubble.innerHTML = renderMarkdown(respuesta);
      scrollAbajo();
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      bubble.classList.add("error");
      bubble.textContent = `Error: ${e.message}`;
      setStatus(false);
      state.ready = false;
    }
  } finally {
    bubble.classList.remove("cursor");
    if (respuesta) {
      const fuentes = relevantes.map((f) => ({ source: f.source, text: f.text.slice(0, 400), score: f.score }));
      addSources(wrap, fuentes);
      state.messages.push({ role: "user", content: texto }, { role: "assistant", content: respuesta, sources: fuentes });
      await saveChat();
    }
    state.controller = null;
    setBusy(false);
    scrollAbajo();
  }
}

// ----------------------------------- Inicio ---------------------------------
async function init() {
  const guardados = await store.get("settings");
  if (guardados) Object.assign(state.settings, guardados);
  state.messages = (await store.get("chat")) || [];

  $("topK").value = state.settings.topK;
  $("topKValue").textContent = state.settings.topK;

  $("btnSettings").addEventListener("click", () => $("settings").classList.toggle("hidden"));
  $("send").addEventListener("click", () => send($("input").value));
  $("stop").addEventListener("click", () => state.controller?.abort());
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send($("input").value);
    }
  });
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.textContent)));

  $("modelSelect").addEventListener("change", async (e) => {
    state.settings.chatModel = e.target.value;
    await store.set("settings", state.settings);
  });
  $("topK").addEventListener("input", async (e) => {
    state.settings.topK = +e.target.value;
    $("topKValue").textContent = e.target.value;
    await store.set("settings", state.settings);
  });
  $("fileInput").addEventListener("change", async (e) => {
    await addFiles([...e.target.files]);
    e.target.value = "";
  });
  $("btnReindex").addEventListener("click", reindex);
  $("btnClear").addEventListener("click", async () => {
    state.messages = [];
    await saveChat();
    renderChat();
  });

  renderChat();
  await renderDocList();
  await connect();
}

init();
