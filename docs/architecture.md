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

La ruta de configuración es común entre el repositorio y la copia del plugin instalada. `PLUGIN_ROOT` localiza el código de los hooks; los datos personales se guardan en el directorio del usuario o en `CODEX_DISCORD_DATA_DIR`. Los paquetes compartidos no incluyen esa configuración.

## Plataformas y distribución

- Windows: named pipe de Discord.
- Linux y macOS: socket Unix de Discord.
- WSL, contenedores y hosts remotos: no incluyen un puente hacia el Discord de otro entorno.
- Web y móvil: la subida a la cuenta conserva el paquete, pero no ejecuta este componente local.

El marketplace del repositorio es un catálogo para instalar el plugin. El ZIP de cuenta contiene el plugin y excluye ese catálogo. Los hooks incluidos necesitan revisión de confianza en Codex tras instalar o cambiar la definición.

## Fuentes

- [Hooks de Codex](https://learn.chatgpt.com/docs/hooks)
- [Empaquetado de plugins](https://developers.openai.com/plugins/build/plugins)
- [Discord RPC](https://docs.discord.com/developers/topics/rpc)
- [Framing del SDK oficial de Discord](https://github.com/discord/discord-rpc/blob/master/documentation/hard-mode.md)
