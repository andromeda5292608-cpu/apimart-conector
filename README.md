# Conector APIMart para Claude

Servidor MCP remoto que permite crear videos con APIMart escribiendo en un chat de Claude.

## Qué gasta saldo de APIMart

Solo la generación de imagen, video, audio y música. El conector no envía texto a modelos de chat (GPT, Codex, Gemini...): ChatGPT, Codex o Claude conversan con su propio modelo y no gastan tokens de APIMart.

## Variables de entorno

- `APIMART_API_KEY`: clave de APIMart.
- `CONNECTOR_TOKEN`: parte secreta de la URL, con 32 caracteres o mas.

Nunca las escribas en este repositorio.

## Uso

La URL del conector es `https://<servicio>.onrender.com/mcp/<CONNECTOR_TOKEN>`. Quien la tenga puede gastar el saldo de APIMart, así que trátala como una contraseña.

## Pruebas

`npm test` usa un APIMart simulado y no gasta saldo.
