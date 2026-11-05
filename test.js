'use strict';
// Prueba de extremo a extremo con un APIMart simulado. No toca la API real ni gasta saldo.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLAVE = 'clave-falsa-de-prueba';
const TOKEN = 'a'.repeat(40);
const PUERTO_API = 18101;
const PUERTO = 18102;
const peticiones = [];
let consultas = 0;

const api = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (p) => { cuerpo += p; });
  req.on('end', () => {
    peticiones.push({ url: req.url, auth: req.headers.authorization, cuerpo: cuerpo ? JSON.parse(cuerpo) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1/models')) {
      return res.end(JSON.stringify({ success: true, object: 'list', data: [{ id: 'gemini-test' }, { id: 'gpt-5.2-codex' }, { id: 'claude-sonnet-4-6' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      return res.end(JSON.stringify({ code: 200, data: { model: 'gemini-test', choices: [{ message: { content: 'respuesta de gemini' } }], usage: { total_tokens: 7 } } }));
    }
    if (req.url === '/v1/responses') {
      return res.end(JSON.stringify({ model: 'gpt-5.2-codex', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'respuesta de codex' }] }], usage: { total_tokens: 9 } }));
    }
    if (req.method === 'POST') {
      return res.end(JSON.stringify({ code: 200, data: [{ status: 'submitted', task_id: 'task_123' }] }));
    }
    if (req.url.includes('task_error')) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: `clave ${CLAVE} rechazada` } }));
    }
    consultas += 1;
    if (consultas < 2) return res.end(JSON.stringify({ code: 200, data: { status: 'processing', progress: 40 } }));
    return res.end(JSON.stringify({ code: 200, data: { status: 'completed', progress: 100, cost: 0.5, result: { videos: [{ url: ['https://cdn.test/v.mp4'] }] } } }));
  });
});

async function rpc(method, params, id = 1) {
  const r = await fetch(`http://127.0.0.1:${PUERTO}/mcp/${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return r.json();
}

async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return { ...r.result, datos: (() => { try { return JSON.parse(r.result.content[0].text); } catch { return r.result.content[0].text; } })() };
}

async function main() {
  await new Promise((ok) => api.listen(PUERTO_API, '127.0.0.1', ok));
  const hijo = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PUERTO), APIMART_API_KEY: CLAVE, CONNECTOR_TOKEN: TOKEN, APIMART_BASE_URL: `http://127.0.0.1:${PUERTO_API}`, POLL_MS: '50' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i += 1) {
      try { await fetch(`http://127.0.0.1:${PUERTO}/health`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); }
    }

    const noToken = await fetch(`http://127.0.0.1:${PUERTO}/mcp/incorrecto`, { method: 'POST', body: '{}' });
    assert.equal(noToken.status, 404, 'token incorrecto rechazado');
    const salud = await (await fetch(`http://127.0.0.1:${PUERTO}/health`)).text();
    assert.ok(!salud.includes(CLAVE), 'health no revela la clave');

    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'apimart-video');

    const noti = await fetch(`http://127.0.0.1:${PUERTO}/mcp/${TOKEN}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(noti.status, 202);
    const get = await fetch(`http://127.0.0.1:${PUERTO}/mcp/${TOKEN}`);
    assert.equal(get.status, 405);

    const lista = await rpc('tools/list', {});
    assert.deepEqual(lista.result.tools.map((t) => t.name), ['modelos_texto_apimart', 'chat_apimart', 'modelos_video_apimart', 'crear_video_apimart', 'estado_video_apimart']);

    const catalogo = await tool('modelos_texto_apimart', { filtro: 'GEMINI' });
    assert.deepEqual(catalogo.datos.modelos.map((m) => m.id), ['gemini-test']);

    const antesChat = peticiones.length;
    assert.equal((await tool('chat_apimart', { modelo: 'no-existe', mensaje: 'hola' })).isError, true);
    assert.equal((await tool('chat_apimart', { modelo: 'gemini-test', mensaje: '  ' })).isError, true);
    assert.equal(peticiones.slice(antesChat).some((p) => p.url !== '/v1/models?expand=category'), false, 'un modelo inexistente nunca gasta saldo');

    const g = await tool('chat_apimart', { modelo: 'gemini-test', mensaje: 'hola', sistema: 'breve', max_tokens: 99999 });
    assert.equal(g.datos.respuesta, 'respuesta de gemini');
    assert.equal(g.datos.uso.total_tokens, 7);
    let ult = peticiones.at(-1);
    assert.equal(ult.url, '/v1/chat/completions');
    assert.equal(ult.cuerpo.max_tokens, 4000, 'max_tokens se limita al tope');
    assert.deepEqual(ult.cuerpo.messages, [{ role: 'system', content: 'breve' }, { role: 'user', content: 'hola' }]);

    const c = await tool('chat_apimart', { modelo: 'gpt-5.2-codex', mensaje: 'hola' });
    assert.equal(c.datos.respuesta, 'respuesta de codex');
    ult = peticiones.at(-1);
    assert.equal(ult.url, '/v1/responses');
    assert.equal(ult.cuerpo.input, 'hola');
    assert.ok(!JSON.stringify(g).includes(CLAVE) && !JSON.stringify(c).includes(CLAVE));

    const modelos = await tool('modelos_video_apimart', {});
    assert.equal(modelos.datos.modelos.length, 8);

    // Las validaciones no deben llamar a APIMart: no se gasta saldo.
    const antes = peticiones.length;
    assert.equal((await tool('crear_video_apimart', { prompt: 'x', modelo: 'veo3.1-fast', duracion: 10 })).isError, true);
    assert.equal((await tool('crear_video_apimart', { prompt: 'x', modelo: 'veo3.1-fast', con_sonido: true })).isError, true);
    assert.equal((await tool('crear_video_apimart', { prompt: 'x', modelo: 'seedance-2.0-fast', resolucion: '4k' })).isError, true);
    assert.equal((await tool('crear_video_apimart', { prompt: 'x', modelo: 'veo3.1-lite', imagenes: ['https://i.test/a.png'] })).isError, true);
    assert.equal((await tool('crear_video_apimart', { prompt: 'x', modelo: 'inventado' })).isError, true);
    assert.equal((await tool('crear_video_apimart', { prompt: ' ' })).isError, true);
    assert.equal(peticiones.length, antes, 'una peticion invalida nunca llega a APIMart');

    const auto = await tool('crear_video_apimart', { prompt: 'playa', modelo: 'auto' });
    assert.equal(auto.datos.modelo, 'veo3.1-quality');
    assert.equal(auto.datos.task_id, 'task_123');
    let enviada = peticiones.at(-1);
    assert.equal(enviada.url, '/v1/videos/generations');
    assert.equal(enviada.auth, `Bearer ${CLAVE}`);
    assert.deepEqual(enviada.cuerpo, { model: 'veo3.1-quality', prompt: 'playa', duration: 8, aspect_ratio: '16:9' });

    assert.equal((await tool('crear_video_apimart', { prompt: 'hola', con_sonido: true })).datos.modelo, 'seedance-2.0');
    assert.equal((await tool('crear_video_apimart', { prompt: 'x', objetivo: 'rapido' })).datos.modelo, 'veo3.1-fast');
    assert.equal((await tool('crear_video_apimart', { prompt: 'x', duracion: 12 })).datos.modelo, 'seedance-2.0');
    assert.equal((await tool('crear_video_apimart', { prompt: 'x', proporcion: '1:1' })).datos.modelo, 'seedance-2.0');

    await tool('crear_video_apimart', { prompt: 'x', modelo: 'kling-v3', resolucion: '1080p', con_sonido: true, duracion: 6 });
    enviada = peticiones.at(-1);
    assert.deepEqual(enviada.cuerpo, { model: 'kling-v3', prompt: 'x', duration: 6, mode: 'pro', audio: true });

    await tool('crear_video_apimart', { prompt: 'x', modelo: 'seedance-2.0', con_sonido: false, proporcion: '9:16' });
    enviada = peticiones.at(-1);
    assert.deepEqual(enviada.cuerpo, { model: 'seedance-2.0', prompt: 'x', size: '9:16', generate_audio: false });

    assert.equal((await tool('estado_video_apimart', { task_id: '../secreto' })).isError, true);

    const curso = await tool('estado_video_apimart', { task_id: 'task_123', esperar_segundos: 0 });
    assert.equal(curso.datos.estado, 'processing');
    const fin = await tool('estado_video_apimart', { task_id: 'task_123', esperar_segundos: 5 });
    assert.equal(fin.datos.estado, 'completed');
    assert.deepEqual(fin.datos.video_urls, ['https://cdn.test/v.mp4']);
    assert.equal(fin.datos.costo, 0.5);

    const fallo = await tool('estado_video_apimart', { task_id: 'task_error' });
    assert.equal(fallo.isError, true);
    assert.ok(!fallo.content[0].text.includes(CLAVE), 'los errores no revelan la clave');

    console.log('Todas las pruebas pasaron.');
  } finally {
    hijo.kill();
    api.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
