# Asistente de Ciberseguridad (Ollama + RAG) — Extensión para Chrome / Edge

Extensión de navegador que abre un **panel lateral** con un asistente de ciberseguridad.
Responde sobre implementación de medidas de seguridad usando **RAG**: antes de contestar busca
en una base de conocimiento (11 documentos incluidos) y se la pasa como contexto a un modelo
que se ejecuta **en local con Ollama**. No se envía ningún dato a servicios externos.

## Requisitos

- Google Chrome, Microsoft Edge o Brave (versión reciente con panel lateral).
- [Ollama](https://ollama.com) instalado y en ejecución.
- Dos modelos descargados:

```
ollama pull llama3.2
ollama pull nomic-embed-text
```

(`llama3.2` genera las respuestas y `nomic-embed-text` convierte textos en vectores para la búsqueda.
Se puede usar cualquier otro modelo de chat ya instalado: aparece en el desplegable de ajustes.)

**Opcional, para analizar imágenes:** un modelo con visión. Por ejemplo (tamaños aproximados):

```
ollama pull gemma3:4b      # ~3 GB, buen equilibrio
ollama pull qwen2.5vl:3b   # ~3 GB
ollama pull llava          # ~5 GB
```
Sin un modelo con visión, todo lo demás funciona igual; solo se desactiva el análisis de imágenes.

## Instalación de la extensión

1. Descomprime el zip en una carpeta. Debe quedar `manifest.json` directamente dentro de ella.
2. Abre `chrome://extensions` (en Edge: `edge://extensions`).
3. Activa el **Modo de desarrollador** (esquina superior derecha).
4. Pulsa **Cargar descomprimida** y selecciona la carpeta que contiene `manifest.json`.
5. Fija el icono del escudo 🛡️ en la barra (icono de puzle → chincheta) y púlsalo: se abre el panel.

La primera vez, la extensión genera el índice de los documentos (unos segundos). Después queda
guardado y las siguientes aperturas son inmediatas.

## Uso

- Escribe una pregunta y pulsa Enter (Mayús+Enter para salto de línea), o usa las preguntas de ejemplo.
- Cada respuesta incluye el desplegable **📚 Fuentes consultadas** con los documentos y fragmentos
  exactos que se han usado, con su puntuación de similitud.
- Botón ⚙️: elegir modelo de chat, número de fragmentos de contexto, **añadir tus propios documentos**
  (.md o .txt), reindexar y borrar la conversación.
- Si la pregunta no está cubierta por los documentos, el asistente lo indica antes de dar una
  respuesta general.

### Enviar imágenes

Se pueden adjuntar hasta 4 imágenes por mensaje de tres formas: botón **📎**, **pegar** desde el
portapapeles (Ctrl+V, por ejemplo una captura de pantalla) o **arrastrarlas** al panel.
Casos útiles: capturas de un correo sospechoso, de una configuración de firewall, de un mensaje de
error o de un log, con preguntas como «¿es un phishing? ¿qué señales ves?» o «¿qué fallos de seguridad
tiene esta configuración?».

- Las imágenes marcadas con 👁️ en el desplegable de modelos admiten imágenes. Si el modelo elegido
  no tiene visión, la extensión usa automáticamente otro instalado que sí la tenga (y lo indica),
  o explica qué modelo instalar.
- Se reducen a 1280 px y se envían solo a Ollama local; no se guardan en disco. Al cerrar el panel
  se conserva el texto de la conversación, pero no las imágenes.
- Las preguntas de seguimiento sobre la última imagen funcionan mientras el panel siga abierto.
- Los modelos de visión pequeños pueden equivocarse al leer texto pequeño o inventar detalles:
  conviene contrastar sus conclusiones.

## Si algo no funciona

| Síntoma | Solución |
|---|---|
| Estado «Sin conexión» | Abre la aplicación Ollama (o ejecuta `ollama serve`) y pulsa Reintentar. |
| Aviso de HTTP 403 | Ollama rechaza el origen de la extensión. La extensión ya reescribe la cabecera `Origin`, pero si aun así falla: define la variable de entorno `OLLAMA_ORIGINS` con el valor `chrome-extension://*` (en Windows: `setx OLLAMA_ORIGINS "chrome-extension://*"`), cierra Ollama del todo (icono de la bandeja → Salir) y vuelve a abrirlo. |
| «Falta el modelo de embeddings» | `ollama pull nomic-embed-text` |
| «No admite imágenes» al adjuntar | Instala un modelo con visión (`ollama pull gemma3:4b`) y pulsa Reintentar. |
| Imagen no aceptada | Usa PNG, JPG o WebP (no HEIC). |
| No hay modelos de chat | `ollama pull llama3.2` |
| Respuestas lentas la primera vez | Ollama está cargando el modelo en memoria; las siguientes son más rápidas. |
| Cambié los documentos y no se nota | Ajustes → Reindexar. |

## Arquitectura

```
kb/docs.json (documentos incluidos) + documentos del usuario
        │  trocear (800 car., solape 150)
        ▼
POST /api/embed (nomic-embed-text) ──► índice guardado en chrome.storage.local
                                                     │
Pregunta ─► embedding ─► similitud coseno ─► top-K ──┘
                                │ (filtro de relevancia ≥ 0.35)
                                ▼
         prompt = sistema + historial + CONTEXTO + pregunta
                                ▼
         POST /api/chat (streaming) ─► respuesta en el panel + fuentes
```

| Archivo | Función |
|---|---|
| `manifest.json` | Manifest V3: permisos (panel lateral, almacenamiento, reglas de red) y acceso solo a Ollama local |
| `background.js` | Abre el panel lateral al pulsar el icono |
| `rules.json` | Regla `declarativeNetRequest` que ajusta la cabecera `Origin` para que Ollama acepte la petición |
| `rag.js` | Motor RAG: troceado, embeddings, similitud coseno, chat en streaming y detección de modelos con visión |
| `sidepanel.html/.css/.js` | Interfaz: estado de conexión, chat con Markdown, fuentes, ajustes y gestión de documentos |
| `kb/docs.json` | Base de conocimiento incluida (hardening, control de acceso, redes, cifrado, phishing, normativas…) |

## Privacidad y seguridad

- Las únicas conexiones de red son a `127.0.0.1:11434` (Ollama en el propio equipo).
- Permisos mínimos: `sidePanel`, `storage`, `unlimitedStorage` (índice de vectores) y
  `declarativeNetRequest` (solo para la cabecera Origin hacia Ollama local).
- No lee páginas web ni pestañas del navegador: solo procesa las imágenes que el usuario adjunta de forma explícita.
- El texto del modelo se escapa antes de mostrarlo, por lo que no puede inyectar HTML en el panel.
- Prompt de sistema defensivo: rechaza ayudar a atacar sistemas de terceros o crear malware.

## Limitaciones y mejoras posibles

- La calidad depende del modelo local elegido y de los documentos cargados.
- No admite PDF directamente (haría falta incluir pdf.js); se pueden convertir a .txt/.md.
- Mejoras: reranking, citas más precisas por párrafo, evaluación automática de respuestas,
  publicación en la Chrome Web Store.
