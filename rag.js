// Motor RAG para la extensión: mismo flujo que la versión en Python.
//   1. INDEXAR  : trocear documentos -> embeddings (Ollama) -> guardar
//   2. RECUPERAR: embedding de la pregunta -> similitud coseno -> top-K
//   3. GENERAR  : prompt con contexto -> /api/chat en streaming

export const OLLAMA_URL = "http://127.0.0.1:11434";
export const EMBED_MODEL = "nomic-embed-text";
export const DEFAULT_CHAT_MODEL = "llama3.2";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH = 16;

export const SYSTEM_PROMPT = `Eres un asistente experto en ciberseguridad defensiva. \
Ayudas a implementar medidas de seguridad (hardening, control de acceso, \
copias de seguridad, redes, aplicaciones web, respuesta a incidentes, etc.).

Reglas:
- Responde en español, de forma clara y con pasos concretos y ordenados.
- Basa tu respuesta en el CONTEXTO proporcionado y menciona la fuente entre corchetes, ej. [hardening.md].
- Si el contexto no cubre la pregunta, dilo explícitamente y después ofrece \
una respuesta general indicando que no procede de la base de conocimiento.
- Si el usuario adjunta imágenes (capturas de correos sospechosos, configuraciones, logs, \
mensajes de error), descríbelas brevemente, analiza lo relevante para la seguridad y \
no inventes lo que no se vea con claridad.
- Solo ofreces ayuda defensiva. Si te piden crear malware o atacar sistemas \
de terceros, rechaza amablemente y ofrece la alternativa defensiva.`;

// ------------------------------ Ollama ------------------------------
export async function listModels() {
  const r = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.models || []).map((m) => m.name);
}

// ¿Admite imágenes el modelo? Se pregunta a Ollama (/api/show -> capabilities);
// si la versión de Ollama no informa de ello, se recurre al nombre del modelo.
const visionCache = new Map();
export function clearVisionCache() { visionCache.clear(); }
export async function isVisionModel(model) {
  if (visionCache.has(model)) return visionCache.get(model);
  let vision = /llava|vision|vl\b|minicpm-v|moondream|bakllava|gemma3/i.test(model);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.capabilities)) vision = j.capabilities.includes("vision");
    }
  } catch { /* se mantiene la heurística por nombre */ }
  visionCache.set(model, vision);
  return vision;
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => Math.round((x / n) * 1e5) / 1e5);
}

export async function embed(texts, model = EMBED_MODEL) {
  const r = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!r.ok) {
    const detalle = await r.text().catch(() => "");
    throw new Error(`Embeddings: HTTP ${r.status} ${detalle}`.trim());
  }
  const j = await r.json();
  return j.embeddings.map(normalize);
}

// Genera la respuesta por trozos (el servidor envía una línea JSON por trozo).
export async function* chatStream({ model, messages, signal }) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!r.ok) {
    const detalle = await r.text().catch(() => "");
    throw new Error(`Chat: HTTP ${r.status} ${detalle}`.trim());
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lineas = buffer.split("\n");
    buffer = lineas.pop();
    for (const linea of lineas) {
      if (!linea.trim()) continue;
      const j = JSON.parse(linea);
      if (j.error) throw new Error(j.error);
      if (j.message?.content) yield j.message.content;
      if (j.done) return;
    }
  }
}

// ------------------------------ Indexado ------------------------------
export function chunkText(texto) {
  const t = texto.trim();
  const paso = CHUNK_SIZE - CHUNK_OVERLAP;
  const out = [];
  for (let i = 0; i < t.length; i += paso) {
    const c = t.slice(i, i + CHUNK_SIZE);
    if (c.trim()) out.push(c);
  }
  return out;
}

export function docsSignature(docs) {
  return EMBED_MODEL + "|" + docs.map((d) => `${d.name}:${d.text.length}`).join("|");
}

export async function buildIndex(docs, onProgress = () => {}) {
  const trozos = [];
  for (const d of docs) {
    for (const t of chunkText(d.text)) trozos.push({ source: d.name, text: t });
  }
  for (let i = 0; i < trozos.length; i += EMBED_BATCH) {
    const lote = trozos.slice(i, i + EMBED_BATCH);
    const vectores = await embed(lote.map((x) => x.text));
    lote.forEach((x, k) => (x.v = vectores[k]));
    onProgress(Math.min(i + EMBED_BATCH, trozos.length), trozos.length);
  }
  return trozos;
}

// ----------------------------- Recuperación ---------------------------
export function retrieve(vectorPregunta, trozos, k) {
  return trozos
    .map((c) => {
      let s = 0;
      for (let i = 0; i < c.v.length; i++) s += c.v[i] * vectorPregunta[i];
      return { source: c.source, text: c.text, score: s };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
