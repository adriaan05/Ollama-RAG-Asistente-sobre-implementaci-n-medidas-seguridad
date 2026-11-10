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

## Si algo no funciona

| Síntoma | Solución |
|---|---|
| Estado «Sin conexión» | Abre la aplicación Ollama (o ejecuta `ollama serve`) y pulsa Reintentar. |
| Aviso de HTTP 403 | Ollama rechaza el origen de la extensión. La extensión ya reescribe la cabecera `Origin`, pero si aun así falla: define la variable de entorno `OLLAMA_ORIGINS` con el valor `chrome-extension://*` (en Windows: `setx OLLAMA_ORIGINS "chrome-extension://*"`), cierra Ollama del todo (icono de la bandeja → Salir) y vuelve a abrirlo. |
| «Falta el modelo de embeddings» | `ollama pull nomic-embed-text` |
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
| `rag.js` | Motor RAG: troceado, embeddings, similitud coseno, chat en streaming |
| `sidepanel.html/.css/.js` | Interfaz: estado de conexión, chat con Markdown, fuentes, ajustes y gestión de documentos |
| `kb/docs.json` | Base de conocimiento incluida (hardening, control de acceso, redes, cifrado, phishing, normativas…) |

## Privacidad y seguridad

- Las únicas conexiones de red son a `127.0.0.1:11434` (Ollama en el propio equipo).
- Permisos mínimos: `sidePanel`, `storage`, `unlimitedStorage` (índice de vectores) y
  `declarativeNetRequest` (solo para la cabecera Origin hacia Ollama local).
- No lee páginas web ni pestañas del navegador.
- El texto del modelo se escapa antes de mostrarlo, por lo que no puede inyectar HTML en el panel.
- Prompt de sistema defensivo: rechaza ayudar a atacar sistemas de terceros o crear malware.

## Limitaciones y mejoras posibles

- La calidad depende del modelo local elegido y de los documentos cargados.
- No admite PDF directamente (haría falta incluir pdf.js); se pueden convertir a .txt/.md.
- Mejoras: reranking, citas más precisas por párrafo, evaluación automática de respuestas,
  publicación en la Chrome Web Store.
