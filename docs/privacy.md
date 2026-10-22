# Datos que utiliza el complemento

El complemento funciona localmente. No incorpora analítica, publicidad ni un servidor propio. Su conexión de presencia se realiza con el cliente de Discord instalado; Discord procesa esa actividad como parte de su servicio.

Los hooks reciben los eventos de Codex por entrada estándar. El complemento selecciona los datos que necesita para identificar sesiones y construir el estado. No incluye el prompt, el código fuente, las transcripciones, la respuesta del agente ni los argumentos de herramientas en el contenido enviado a Discord.

## Información visible

| Información | Comportamiento |
| --- | --- |
| Estado general de trabajo | Visible cuando hay presencia. |
| Tiempo transcurrido de sesión | Incluido en la presencia. |
| Proyecto | Oculto de forma predeterminada; si lo activas, usa el nombre de carpeta. |
| Modelo | Oculto de forma predeterminada; si lo activas, usa el identificador del modelo de Codex. |
| Nombre de sesión | Oculto de forma predeterminada; si lo activas, publica el título de la conversación. |
| Ruta completa, prompts, código y argumentos de herramientas | No se incluyen en la presencia. |

`--show-session true` permite incluir el nombre de la sesión. Para obtenerlo, el complemento consulta los metadatos locales de la conversación con `thread/read` y `includeTurns: false`, y selecciona únicamente `thread.name`. No lee los turnos para construir un título ni usa `preview`, el primer prompt u otro contenido como alternativa. El nombre se limita y limpia antes de enviarlo a Discord. Un título elegido por el usuario puede contener información privada: esta opción sólo se activa cuando el usuario solicita mostrarlo.

El nombre principal de la actividad lo determina la aplicación de Discord que corresponda al Application ID configurado. Ese identificador no es un token de autenticación. No introduzcas un token de bot o usuario, una contraseña ni una API key de OpenAI en su lugar.

## Almacenamiento y control

Las preferencias y los datos necesarios para controlar el proceso se guardan en el directorio de datos del usuario; `CODEX_DISCORD_DATA_DIR` permite cambiarlo. La configuración debe permanecer fuera del repositorio y del ZIP compartido.

Puedes ocultar proyecto, modelo y nombre de sesión con `configure --show-project false --show-model false --show-session false`, retirar la actividad y detener el proceso con `stop`, o desinstalar el plugin y eliminar su directorio de datos después de detenerlo. Desactivar el plugin evita futuros hooks; detener el proceso retira la presencia actual.

No pegues conversaciones ni credenciales en un issue para diagnosticar la presencia. Comparte únicamente el error necesario y oculta nombres de proyectos si son privados.

Este documento describe el comportamiento del código distribuido. Las preferencias del usuario y las condiciones de Discord determinan quién puede ver la actividad publicada.
