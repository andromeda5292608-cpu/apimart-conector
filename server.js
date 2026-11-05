'use strict';
// Conector MCP remoto (Streamable HTTP, sin estado) para crear videos con APIMart desde Claude.
// Sin dependencias externas. Secretos solo por variables de entorno:
//   APIMART_API_KEY  clave de APIMart
//   CONNECTOR_TOKEN  parte secreta de la URL del conector (minimo 32 caracteres)

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 10000;
const API_BASE = process.env.APIMART_BASE_URL || 'https://api.apimart.ai';
const API_KEY = (process.env.APIMART_API_KEY || '').trim();
const TOKEN = (process.env.CONNECTOR_TOKEN || '').trim();
const MAX_BODY_BYTES = 1024 * 1024;
const VERSIONES_MCP = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const POLL_MS = Number(process.env.POLL_MS) || 5000;

// Catalogo: solo modelos cuyos parametros se leyeron en docs.apimart.ai.
const FAMILIAS = {
  veo: {
    proporciones: ['16:9', '9:16'],
    resoluciones: ['720p', '1080p', '4k'],
    duracionValida: (d) => d === 8,
    duracionTexto: 'solo 8 segundos',
    sonido: false,
    negativo: false,
    construir(id, a) {
      return {
        model: id,
        prompt: a.prompt,
        duration: 8,
        aspect_ratio: a.proporcion || '16:9',
        resolution: a.resolucion,
        image_urls: a.imagenes,
      };
    },
  },
  kling: {
    proporciones: ['16:9', '9:16', '1:1'],
    resoluciones: ['720p', '1080p', '4k'],
    duracionValida: (d) => d >= 3 && d <= 15,
    duracionTexto: 'de 3 a 15 segundos',
    sonido: true,
    negativo: true,
    construir(id, a) {
      const modos = { '720p': 'std', '1080p': 'pro', '4k': '4k' };
      return {
        model: id,
        prompt: a.prompt,
        duration: a.duracion,
        aspect_ratio: a.proporcion,
        mode: modos[a.resolucion],
        audio: a.con_sonido === true,
        negative_prompt: a.prompt_negativo,
        image_urls: a.imagenes,
      };
    },
  },
  seedance: {
    proporciones: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
    resoluciones: ['480p', '720p'],
    duracionValida: (d) => d >= 4 && d <= 15,
    duracionTexto: 'de 4 a 15 segundos',
    sonido: true,
    negativo: false,
    construir(id, a) {
      return {
        model: id,
        prompt: a.prompt,
        duration: a.duracion,
        size: a.proporcion,
        resolution: a.resolucion,
        generate_audio: a.con_sonido !== false,
        image_urls: a.imagenes,
      };
    },
  },
  wan: {
    proporciones: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    resoluciones: ['720p', '1080p'],
    duracionValida: (d) => d === 5 || d === 10 || d === 15,
    duracionTexto: '5, 10 o 15 segundos',
    sonido: true,
    negativo: true,
    construir(id, a) {
      return {
        model: id,
        prompt: a.prompt,
        duration: a.duracion,
        aspect_ratio: a.proporcion,
        resolution: a.resolucion,
        audio: a.con_sonido,
        negative_prompt: a.prompt_negativo,
        image_urls: a.imagenes,
      };
    },
  },
};

const MODELOS = {
  'veo3.1-quality': { familia: 'veo', maxImagenes: 2, para: 'Alta calidad, pensado para la version final. La documentacion no incluye una opcion de sonido.' },
  'veo3.1-fast': { familia: 'veo', maxImagenes: 3, para: 'Generacion rapida, para previsualizar y probar ideas. La documentacion no incluye una opcion de sonido.' },
  'veo3.1-lite': { familia: 'veo', maxImagenes: 0, para: 'Ligero y de bajo costo, para generar en lote. Sin imagenes de referencia ni opcion de sonido documentada.' },
  'seedance-2.0': { familia: 'seedance', maxImagenes: 9, resoluciones: ['480p', '720p', '1080p', '4k'], para: 'Texto o imagenes a video con audio generado por IA; su documentacion muestra dialogos dentro del prompt. Unica version Seedance con 1080p y 4k.' },
  'seedance-2.0-fast': { familia: 'seedance', maxImagenes: 9, para: 'Mismas funciones que seedance-2.0, mas rapido. Hasta 720p.' },
  'seedance-2.0-mini': { familia: 'seedance', maxImagenes: 9, para: 'Version mini con las mismas funciones. Hasta 720p.' },
  'kling-v3': { familia: 'kling', maxImagenes: 2, para: 'Texto o imagen a video, con audio opcional. Se recomiendan prompts en ingles.' },
  'wan2.6': { familia: 'wan', maxImagenes: 1, para: 'Modelo de Alibaba, con audio opcional. Duraciones fijas de 5, 10 o 15 segundos.' },
};

const CANDIDATOS = {
  sonido: {
    calidad: ['seedance-2.0', 'kling-v3', 'wan2.6'],
    rapido: ['seedance-2.0-fast', 'seedance-2.0', 'kling-v3'],
    economico: ['seedance-2.0-mini', 'seedance-2.0-fast', 'seedance-2.0'],
  },
  mudo: {
    calidad: ['veo3.1-quality', 'veo3.1-fast', 'seedance-2.0', 'kling-v3', 'wan2.6'],
    rapido: ['veo3.1-fast', 'seedance-2.0-fast', 'kling-v3'],
    economico: ['veo3.1-lite', 'veo3.1-fast', 'seedance-2.0-mini'],
  },
};

function limpiar(valor) {
  let texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  for (const secreto of [API_KEY, TOKEN]) {
    if (secreto) texto = texto.split(secreto).join('***');
  }
  return texto;
}

function respuestaTool(datos, esError = false) {
  const resultado = { content: [{ type: 'text', text: limpiar(datos) }] };
  if (esError) resultado.isError = true;
  return resultado;
}

function sinIndefinidos(objeto) {
  return Object.fromEntries(Object.entries(objeto).filter(([, v]) => v !== undefined));
}

function construirPeticion(id, a) {
  const modelo = MODELOS[id];
  if (!modelo) return { error: `Modelo no disponible en este conector: ${id}` };
  const familia = FAMILIAS[modelo.familia];
  const resoluciones = modelo.resoluciones || familia.resoluciones;

  if (a.duracion !== undefined && !familia.duracionValida(a.duracion)) {
    return { error: `${id} admite ${familia.duracionTexto}.` };
  }
  if (a.proporcion !== undefined && !familia.proporciones.includes(a.proporcion)) {
    return { error: `${id} admite estas proporciones: ${familia.proporciones.join(', ')}.` };
  }
  if (a.resolucion !== undefined && !resoluciones.includes(a.resolucion)) {
    return { error: `${id} admite estas resoluciones: ${resoluciones.join(', ')}.` };
  }
  if (a.con_sonido === true && !familia.sonido) {
    return { error: `La documentacion de ${id} no incluye una opcion de sonido.` };
  }
  if (a.prompt_negativo !== undefined && !familia.negativo) {
    return { error: `${id} no admite prompt_negativo.` };
  }
  const imagenes = a.imagenes || [];
  if (imagenes.length > modelo.maxImagenes) {
    return { error: `${id} admite un maximo de ${modelo.maxImagenes} imagenes.` };
  }
  if (modelo.familia === 'wan' && imagenes.length > 0 && a.proporcion !== undefined) {
    return { error: 'wan2.6 no admite proporcion cuando se usa una imagen.' };
  }
  if (modelo.familia === 'seedance' && id !== 'seedance-2.0-mini' && a.prompt.length > 4000) {
    return { error: `${id} admite un prompt de hasta 4000 caracteres.` };
  }
  return { cuerpo: sinIndefinidos(familia.construir(id, a)) };
}

function elegirAutomatico(a) {
  const objetivo = a.objetivo || 'calidad';
  const tipo = a.con_sonido === true ? 'sonido' : 'mudo';
  const motivos = [];
  for (const id of CANDIDATOS[tipo][objetivo]) {
    const intento = construirPeticion(id, a);
    if (intento.cuerpo) {
      const motivo = `Objetivo "${objetivo}"${tipo === 'sonido' ? ' con sonido' : ''}: ${MODELOS[id].para}`;
      return { id, cuerpo: intento.cuerpo, motivo };
    }
    motivos.push(intento.error);
  }
  return { error: `Ningun modelo cumple lo pedido. ${motivos.join(' ')}` };
}

function validarArgumentos(a) {
  if (typeof a.prompt !== 'string' || !a.prompt.trim()) return 'Falta la descripcion del video (prompt).';
  if (a.duracion !== undefined && !Number.isInteger(a.duracion)) return 'La duracion debe ser un numero entero de segundos.';
  if (a.imagenes !== undefined) {
    const validas = Array.isArray(a.imagenes) && a.imagenes.every((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (!validas) return 'imagenes debe ser una lista de enlaces publicos http o https.';
  }
  if (a.objetivo !== undefined && !['calidad', 'rapido', 'economico'].includes(a.objetivo)) {
    return 'objetivo debe ser calidad, rapido o economico.';
  }
  return null;
}

async function llamarApi(ruta, { timeoutMs = 60000, ...opciones } = {}) {
  const respuesta = await fetch(`${API_BASE}${ruta}`, {
    ...opciones,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const texto = await respuesta.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* respuesta no JSON */ }
  return { status: respuesta.status, ok: respuesta.ok, json, texto };
}

function mensajeApi(r) {
  const detalle = r.json?.error?.message || r.json?.message || r.texto.slice(0, 300);
  return `APIMart respondio HTTP ${r.status}: ${detalle}`;
}

function listarModelos() {
  return respuestaTool({
    modelos: Object.entries(MODELOS).map(([id, m]) => {
      const f = FAMILIAS[m.familia];
      return {
        id,
        para_que_sirve: m.para,
        sonido: f.sonido,
        duracion: f.duracionTexto,
        proporciones: f.proporciones,
        resoluciones: m.resoluciones || f.resoluciones,
        imagenes_maximas: m.maxImagenes,
      };
    }),
    recomendacion_automatica: {
      con_voz_o_sonido: 'seedance-2.0',
      calidad_final_sin_sonido: 'veo3.1-quality',
      pruebas_rapidas: 'veo3.1-fast',
      lote_economico: 'veo3.1-lite',
    },
    aviso: 'Las descripciones vienen de la documentacion de APIMart; no son una comparativa independiente de realismo. La documentacion consultada no publica precios de estos modelos: el costo real aparece en estado_video_apimart.',
  });
}

async function crearVideo(a) {
  const invalido = validarArgumentos(a);
  if (invalido) return respuestaTool(invalido, true);
  if (!API_KEY) return respuestaTool('Falta configurar APIMART_API_KEY en Render.', true);

  const pedido = a.modelo && a.modelo !== 'auto' ? a.modelo : 'auto';
  const eleccion = pedido === 'auto'
    ? elegirAutomatico(a)
    : { id: pedido, ...construirPeticion(pedido, a) };
  if (eleccion.error) return respuestaTool(eleccion.error, true);

  let r;
  try {
    r = await llamarApi('/v1/videos/generations', { method: 'POST', body: JSON.stringify(eleccion.cuerpo) });
  } catch (e) {
    return respuestaTool(`No hubo respuesta de APIMart (${e.name}). Puede que la tarea se haya creado y cobrado: revisa tu cuenta antes de repetir.`, true);
  }
  const tarea = r.json?.data?.[0];
  if (!r.ok || !tarea?.task_id) return respuestaTool(mensajeApi(r), true);

  const { prompt, ...parametros } = eleccion.cuerpo;
  return respuestaTool(sinIndefinidos({
    task_id: tarea.task_id,
    estado: tarea.status,
    modelo: eleccion.id,
    por_que_este_modelo: eleccion.motivo,
    parametros,
    siguiente_paso: 'Llama a estado_video_apimart con este task_id hasta que termine.',
  }));
}

function urlsDeVideo(resultado) {
  const videos = resultado?.videos;
  if (!Array.isArray(videos)) return [];
  return videos.flatMap((v) => {
    if (typeof v === 'string') return [v];
    const url = v?.url ?? v?.video_url;
    if (Array.isArray(url)) return url;
    return url ? [url] : [];
  });
}

async function estadoVideo(a) {
  if (typeof a.task_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(a.task_id)) {
    return respuestaTool('task_id no valido.', true);
  }
  if (!API_KEY) return respuestaTool('Falta configurar APIMART_API_KEY en Render.', true);

  const espera = Math.min(Math.max(Number(a.esperar_segundos ?? 30) || 0, 0), 45);
  const limite = Date.now() + espera * 1000;
  for (;;) {
    let r;
    try {
      r = await llamarApi(`/v1/tasks/${a.task_id}?language=es`);
    } catch (e) {
      return respuestaTool(`No hubo respuesta de APIMart (${e.name}). Vuelve a consultar en un momento.`, true);
    }
    if (!r.ok || !r.json?.data) return respuestaTool(mensajeApi(r), true);

    const d = r.json.data;
    const terminal = ['completed', 'failed', 'cancelled'].includes(d.status);
    if (terminal || Date.now() + POLL_MS > limite) {
      const urls = urlsDeVideo(d.result);
      const completado = d.status === 'completed';
      return respuestaTool(sinIndefinidos({
        task_id: a.task_id,
        estado: d.status,
        progreso: d.progress,
        costo: d.cost,
        creditos: d.credits_cost,
        video_urls: completado ? urls : undefined,
        resultado_sin_procesar: completado && urls.length === 0 ? d.result : undefined,
        error: d.error,
        aviso: completado ? 'Los enlaces de video caducan a las 24 horas: guardalo pronto.' : undefined,
      }), d.status === 'failed');
    }
    await new Promise((resolver) => setTimeout(resolver, POLL_MS));
  }
}

// ---- Texto: otros modelos (Gemini, GPT, Codex...) ----
// El catalogo se lee en vivo de APIMart; no hay IDs fijos aqui.
const MAX_TOKENS_TOPE = 4000;
const MAX_TOKENS_DEFECTO = 1000;
const MAX_MENSAJE = 20000;
let catalogoCache = { hasta: 0, modelos: [] };

async function catalogoTexto() {
  if (Date.now() < catalogoCache.hasta) return catalogoCache.modelos;
  const r = await llamarApi('/v1/models?expand=category');
  const lista = r.json?.data;
  if (!r.ok || !Array.isArray(lista)) throw new Error(mensajeApi(r));
  const modelos = lista.filter((m) => typeof m?.id === 'string').map((m) => ({
    id: m.id,
    categoria: m.category,
    endpoints: m.supported_endpoint_types,
  }));
  catalogoCache = { hasta: Date.now() + 5 * 60 * 1000, modelos };
  return modelos;
}

async function modelosTexto(a) {
  if (!API_KEY) return respuestaTool('Falta configurar APIMART_API_KEY en Render.', true);
  let modelos;
  try {
    modelos = await catalogoTexto();
  } catch (e) {
    return respuestaTool(`No se pudo leer el catalogo de APIMart: ${e.message}`, true);
  }
  const filtro = typeof a.filtro === 'string' ? a.filtro.trim().toLowerCase() : '';
  const lista = modelos.filter((m) => !filtro || m.id.toLowerCase().includes(filtro));
  return respuestaTool({
    total_en_catalogo: modelos.length,
    coincidencias: lista.length,
    modelos: lista.slice(0, 200),
    aviso: 'Catalogo en vivo de APIMart. Incluye todo tipo de modelos (imagen, video, audio), no solo texto. Para conversar usa chat_apimart con uno de estos ids.',
  });
}

function textoDeChat(json) {
  const d = json?.data?.choices ? json.data : json;
  return { texto: d?.choices?.[0]?.message?.content, uso: d?.usage, modelo: d?.model };
}

function textoDeResponses(json) {
  const d = json?.data?.output ? json.data : json;
  const partes = (d?.output || [])
    .filter((o) => o?.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text);
  return { texto: partes.join(''), uso: d?.usage, modelo: d?.model };
}

async function chat(a) {
  if (typeof a.modelo !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(a.modelo)) return respuestaTool('modelo no valido.', true);
  if (typeof a.mensaje !== 'string' || !a.mensaje.trim()) return respuestaTool('Falta el mensaje.', true);
  if (a.mensaje.length > MAX_MENSAJE) return respuestaTool(`El mensaje supera ${MAX_MENSAJE} caracteres.`, true);
  if (a.sistema !== undefined && (typeof a.sistema !== 'string' || a.sistema.length > MAX_MENSAJE)) return respuestaTool('sistema no valido.', true);
  if (a.max_tokens !== undefined && !Number.isInteger(a.max_tokens)) return respuestaTool('max_tokens debe ser un entero.', true);
  if (!API_KEY) return respuestaTool('Falta configurar APIMART_API_KEY en Render.', true);
  const maxTokens = Math.min(Math.max(a.max_tokens ?? MAX_TOKENS_DEFECTO, 1), MAX_TOKENS_TOPE);

  // Validar contra el catalogo en vivo antes de gastar.
  let modelos;
  try {
    modelos = await catalogoTexto();
  } catch (e) {
    return respuestaTool(`No se pudo comprobar el catalogo de APIMart: ${e.message}`, true);
  }
  const entrada = modelos.find((m) => m.id === a.modelo);
  if (!entrada) return respuestaTool(`El modelo "${a.modelo}" no esta en el catalogo de APIMart. Usa modelos_texto_apimart para ver los ids.`, true);

  // Los modelos Codex estan documentados solo en /v1/responses.
  const usaResponses = /codex/i.test(a.modelo);
  const cuerpo = usaResponses
    ? { model: a.modelo, input: a.mensaje, max_output_tokens: maxTokens, ...(a.sistema ? { instructions: a.sistema } : {}) }
    : { model: a.modelo, messages: [...(a.sistema ? [{ role: 'system', content: a.sistema }] : []), { role: 'user', content: a.mensaje }], max_tokens: maxTokens, stream: false };

  const rutas = usaResponses ? ['/v1/responses'] : ['/v1/chat/completions', '/api/v1/chat/completions'];
  let r;
  for (const ruta of rutas) {
    try {
      r = await llamarApi(ruta, { method: 'POST', body: JSON.stringify(cuerpo), timeoutMs: 90000 });
    } catch (e) {
      return respuestaTool(`No hubo respuesta de APIMart (${e.name}). Puede que la peticion se haya cobrado: no la repitas sin avisar al usuario.`, true);
    }
    if (r.status !== 404) break; // un 404 significa que la ruta no existe: no se cobro nada.
  }
  if (!r.ok) return respuestaTool(mensajeApi(r), true);

  const { texto, uso, modelo } = usaResponses ? textoDeResponses(r.json) : textoDeChat(r.json);
  if (typeof texto !== 'string' || !texto) {
    return respuestaTool({ aviso: 'APIMart respondio sin texto reconocible.', respuesta_sin_procesar: r.texto.slice(0, 1500) }, true);
  }
  return respuestaTool(sinIndefinidos({ modelo: modelo || a.modelo, endpoint: usaResponses ? 'responses' : 'chat/completions', respuesta: texto, uso }));
}

const HERRAMIENTAS = [
  {
    name: 'modelos_texto_apimart',
    title: 'Modelos de APIMart (catalogo en vivo)',
    description: 'Lee el catalogo en vivo de APIMart y lo filtra por texto (por ejemplo "gemini", "codex" o "gpt"). Sirve para saber que ids existen antes de usar chat_apimart. No gasta saldo.',
    inputSchema: { type: 'object', properties: { filtro: { type: 'string', description: 'Texto a buscar dentro del id del modelo.' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'chat_apimart',
    title: 'Preguntar a otro modelo via APIMart',
    description: 'Envia un mensaje a otro modelo de IA (Gemini, GPT, Codex...) a traves de APIMart y devuelve su respuesta. GASTA SALDO de la cuenta del usuario: usala solo cuando el usuario pida expresamente ese modelo, y no reintentes tras un error. Claude sigue siendo quien conversa con el usuario: envia la pregunta y entrega la respuesta. Un solo turno, sin streaming.',
    inputSchema: {
      type: 'object',
      properties: {
        modelo: { type: 'string', description: 'Id exacto del modelo, tomado de modelos_texto_apimart.' },
        mensaje: { type: 'string', description: 'Pregunta o tarea para el modelo.' },
        sistema: { type: 'string', description: 'Instruccion de sistema opcional.' },
        max_tokens: { type: 'integer', minimum: 1, maximum: MAX_TOKENS_TOPE, description: `Maximo de tokens de respuesta. Por defecto ${MAX_TOKENS_DEFECTO}; tope ${MAX_TOKENS_TOPE}.` },
      },
      required: ['modelo', 'mensaje'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'modelos_video_apimart',
    title: 'Modelos de video de APIMart',
    description: 'Lista los modelos de video de APIMart disponibles, para que sirve cada uno y sus limites. Usala para explicar las opciones al usuario. No gasta saldo.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'crear_video_apimart',
    title: 'Crear video con APIMart',
    description: 'Crea un video con APIMart. GASTA SALDO de la cuenta del usuario. Si el usuario no nombro un modelo ni pidio que lo elijas tu, consulta primero modelos_video_apimart, explicale brevemente las opciones y pregunta. Si dijo "elige tu", "automatico" o similar, usa modelo="auto". No reintentes por tu cuenta tras un error: podria cobrarse dos veces. Despues llama a estado_video_apimart.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Descripcion detallada del video. Para kling-v3, escribela en ingles. Si debe haber dialogo, incluye el texto exacto.' },
        modelo: { type: 'string', enum: ['auto', ...Object.keys(MODELOS)], description: 'ID del modelo, o "auto" para elegirlo segun objetivo y con_sonido.' },
        objetivo: { type: 'string', enum: ['calidad', 'rapido', 'economico'], description: 'Solo con modelo "auto". Por defecto, calidad.' },
        con_sonido: { type: 'boolean', description: 'true si el video debe tener voz o sonido. Seedance genera sonido por defecto salvo que sea false.' },
        duracion: { type: 'integer', description: 'Segundos. Los limites dependen del modelo.' },
        proporcion: { type: 'string', description: 'Por ejemplo 16:9 (horizontal) o 9:16 (vertical).' },
        resolucion: { type: 'string', enum: ['480p', '720p', '1080p', '4k'] },
        imagenes: { type: 'array', items: { type: 'string' }, description: 'Enlaces publicos de imagenes de referencia.' },
        prompt_negativo: { type: 'string', description: 'Lo que debe evitarse. Solo kling-v3 y wan2.6.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'estado_video_apimart',
    title: 'Estado de un video de APIMart',
    description: 'Consulta una tarea de video de APIMart y devuelve estado, costo y enlaces cuando termina. Espera unos segundos antes de responder. Repitela mientras siga en curso y entrega el enlace al usuario. No gasta saldo adicional.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'El task_id devuelto por crear_video_apimart.' },
        esperar_segundos: { type: 'integer', minimum: 0, maximum: 45, description: 'Cuanto esperar a que termine antes de responder. Por defecto, 30.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

const INSTRUCCIONES = 'Crea videos y consulta otros modelos de texto (Gemini, GPT, Codex) con la cuenta de APIMart del usuario. Todo lo que genera gasta saldo. Pregunta el modelo salvo que el usuario lo haya nombrado o pida que lo elijas. Los enlaces caducan a las 24 horas.';

async function atenderRpc(m) {
  switch (m.method) {
    case 'initialize': {
      const pedida = m.params?.protocolVersion;
      return {
        protocolVersion: VERSIONES_MCP.includes(pedida) ? pedida : VERSIONES_MCP[1],
        capabilities: { tools: {} },
        serverInfo: { name: 'apimart-video', title: 'APIMart Video', version: '1.0.0' },
        instructions: INSTRUCCIONES,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: HERRAMIENTAS };
    case 'tools/call': {
      const args = m.params?.arguments || {};
      if (m.params?.name === 'modelos_video_apimart') return listarModelos();
      if (m.params?.name === 'crear_video_apimart') return crearVideo(args);
      if (m.params?.name === 'estado_video_apimart') return estadoVideo(args);
      if (m.params?.name === 'modelos_texto_apimart') return modelosTexto(args);
      if (m.params?.name === 'chat_apimart') return chat(args);
      throw Object.assign(new Error('Herramienta desconocida'), { code: -32602 });
    }
    default:
      throw Object.assign(new Error('Metodo no encontrado'), { code: -32601 });
  }
}

function enviarJson(res, status, datos, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(datos));
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function tokenValido(candidato) {
  if (TOKEN.length < 32 || !candidato) return false;
  const a = Buffer.from(candidato);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function leerCuerpo(req) {
  return new Promise((resolver, rechazar) => {
    const partes = [];
    let total = 0;
    req.on('data', (parte) => {
      total += parte.length;
      if (total > MAX_BODY_BYTES) {
        rechazar(new Error('demasiado grande'));
        req.destroy();
      } else {
        partes.push(parte);
      }
    });
    req.on('end', () => resolver(Buffer.concat(partes).toString('utf8')));
    req.on('error', rechazar);
  });
}

const servidor = http.createServer(async (req, res) => {
  const ruta = new URL(req.url, 'http://localhost').pathname;

  if (ruta === '/health') {
    return enviarJson(res, 200, { ok: true, clave_configurada: Boolean(API_KEY) });
  }
  const coincide = ruta.match(/^\/mcp\/([^/]+)\/?$/);
  if (!coincide || !tokenValido(coincide[1])) {
    return enviarJson(res, 404, { error: 'No encontrado' });
  }
  if (req.method !== 'POST') {
    return enviarJson(res, 405, { error: 'Usa POST' }, { Allow: 'POST' });
  }

  let mensaje;
  try {
    mensaje = JSON.parse(await leerCuerpo(req));
  } catch {
    return enviarJson(res, 400, rpcError(null, -32700, 'JSON no valido'));
  }
  if (!mensaje || Array.isArray(mensaje) || typeof mensaje.method !== 'string') {
    if (mensaje && !Array.isArray(mensaje) && mensaje.method === undefined && mensaje.id !== undefined) {
      res.writeHead(202);
      return res.end();
    }
    return enviarJson(res, 400, rpcError(mensaje?.id, -32600, 'Peticion no valida'));
  }
  if (mensaje.id === undefined) {
    res.writeHead(202);
    return res.end();
  }

  try {
    const result = await atenderRpc(mensaje);
    enviarJson(res, 200, { jsonrpc: '2.0', id: mensaje.id, result });
  } catch (e) {
    const code = Number.isInteger(e.code) ? e.code : -32603;
    enviarJson(res, 200, rpcError(mensaje.id, code, code === -32603 ? 'Error interno' : e.message));
  }
});

servidor.listen(PORT, '0.0.0.0', () => {
  console.log(`Conector APIMart escuchando en el puerto ${PORT}. Clave configurada: ${Boolean(API_KEY)}`);
});
