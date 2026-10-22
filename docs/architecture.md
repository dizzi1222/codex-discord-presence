# Arquitectura

Este complemento funciona en la misma máquina y sesión de usuario que Discord de escritorio.

```text
Codex: hooks de sesión y herramientas
             │ JSON por stdin
             ▼
cli.mjs hook: selecciona campos permitidos
             │ comunicación local
             ▼
Proceso persistente: sesiones, estado y reconexión
             │ Discord IPC: handshake → READY → SET_ACTIVITY
             ▼
Discord de escritorio → tarjeta de actividad del usuario
```

Mantener un proceso persistente evita abrir una conexión de Discord por cada llamada de herramienta. Los hooks son observadores: responden `{}` y no aprueban, rechazan ni cambian herramientas o mensajes de Codex.

Los eventos indican actividad del agente; no indican qué ventana tiene el foco. `SessionEnd` depende del ciclo de vida de Codex y no se emite simplemente por cambiar de chat. La retirada por inactividad permite dejar de publicar la tarjeta aunque la sesión siga abierta. Consulta la implementación para los tiempos de caducidad y agrupación vigentes.

El módulo IPC espera `READY` después del handshake y correlaciona las respuestas por `nonce`. Las pruebas verifican el protocolo con un servidor simulado. Una prueba de protocolo no confirma que una cuenta de Discord concreta publique la tarjeta; eso requiere un cliente real y una aplicación válida.

Los assets del listado y los de la tarjeta se resuelven por separado. `assets/logo.svg` y `assets/composer-icon.svg` pertenecen a la interfaz del complemento. `assets/presence.png` es el logo raster de 1024 × 1024 para Discord. `defaultLargeImage`, en `src/config.mjs`, apunta a su URL HTTPS pública en GitHub. Discord admite tanto claves de assets de la aplicación como URLs públicas, que procesa mediante su proxy de imágenes. Una configuración guardada con `largeImage: ""` conserva la imagen desactivada; cambiar el valor predeterminado del paquete no modifica esa preferencia.

La ruta de configuración es común entre el repositorio y la copia del plugin instalada. `PLUGIN_ROOT` localiza el código de los hooks; los datos personales se guardan en el directorio del usuario o en `CODEX_DISCORD_DATA_DIR`. Los paquetes compartidos no incluyen esa configuración.

## Plataformas y distribución

- Windows: named pipe de Discord.
- Linux y macOS: socket Unix de Discord.
- WSL, contenedores y hosts remotos: no incluyen un puente hacia el Discord de otro entorno.
- Web y móvil: la subida a la cuenta conserva el paquete, pero no ejecuta este componente local.

El repositorio y el ZIP local incluyen el catálogo `.agents/plugins/marketplace.json`. El manifiesto de runtime es `.codex-plugin/plugin.json`, que declara `hooks/hooks.json`. La versión de Codex comprobada da prioridad al formato AgentPlugin cuando encuentra un `plugin.json` portable en la raíz; esa ruta de carga no incorpora los hooks del manifiesto local. Por eso la distribución de runtime no incluye ese archivo raíz.

El paquete portable que se guarda en una cuenta se prepara por separado y excluye el marketplace. Conserva las instrucciones y los assets de listado, pero no sustituye la instalación local del runtime desde GitHub o el release. No se debe copiar su manifiesto raíz sobre la distribución local.

`doctor` comprueba los hooks que el runtime de Codex reconoce, además de la configuración y la conexión con Discord. La presencia de archivos de hook, el estado habilitado del plugin o la disponibilidad de su habilidad no bastan para confirmar esa carga. `sessions: 0` informa de la memoria del daemon y no determina por sí solo si falta confianza, carga del manifiesto o entrega de eventos. Cuando Codex requiera revisión de confianza, debe usarse su interfaz normal; el complemento no modifica registros de confianza.

## Fuentes

- [Hooks de Codex](https://learn.chatgpt.com/docs/hooks)
- [Empaquetado de plugins](https://developers.openai.com/plugins/build/plugins)
- [Discord RPC](https://docs.discord.com/developers/topics/rpc)
- [Imágenes de actividad de Discord](https://docs.discord.com/developers/events/gateway-events#activity-object-activity-asset-image)
- [Framing del SDK oficial de Discord](https://github.com/discord/discord-rpc/blob/master/documentation/hard-mode.md)
