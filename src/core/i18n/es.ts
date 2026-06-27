// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const ES: Record<string, string> = {
  // ── Pane tabs ──
  Comments: 'Comentarios',
  Appearance: 'Tarjetas y Colores',
  Advanced: 'Avanzado',
  Translation: 'Traducción',

  // ── Aria labels / misc ──
  'Live chat overlay': 'Live chat overlay',
  'Interface language changed to': 'Idioma de interfaz cambiado a: ',

  // ── Section titles ──
  'Text Outline': 'Contorno de texto',
  'Safe Zone': 'Zona segura',
  'Message Rate': 'Frecuencia de mensajes',
  'Depth Layers': 'Capas de profundidad',
  Backlog: 'Historial',
  Timing: 'Temporización',
  Tuning: 'Ajustes',
  'Burst Detection': 'Detección de ráfagas',
  Cache: 'Caché',
  'Author Colors & Visibility': 'Colores y visibilidad',
  'Author colors and visibility': 'Colores y visibilidad',
  Interface: 'Interfaz',
  'Chat Translation': 'Traducción de chat',
  'Translation backend service for processing messages':
    'Servicio de traducción para procesar mensajes',

  // ── Field labels ──
  'Danmaku Mode': 'Modo Danmaku',
  'Font Size (px)': 'Tamaño de fuente (px)',
  'Text Opacity (%)': 'Opacidad del texto (%)',
  'Scroll Speed (px/s)': 'Velocidad (px/s)',
  'Lane Gap (px)': 'Espacio entre líneas (px)',
  'Font Weight': 'Peso de fuente',
  'Font Family': 'Familia tipográfica',
  Enabled: 'Activado',
  // Legacy key 'Width (px)' removed (replaced by 'Outline Width (px)')
  'Outline Width (px)': 'Ancho del contorno (px)',
  'Outline Opacity (%)': 'Opacidad del contorno (%)',
  'SuperChat Opacity (%)': 'Opacidad SuperChat (%)',
  'SuperChat Max Lines': 'Líneas máx. SuperChat',
  'Membership Max Lines': 'Líneas máx. membresía',
  'Preserve User Colors': 'Conservar colores de usuario',
  'Show SuperChat Amount': 'Mostrar monto SuperChat',
  'Top Clear Zone (%)': 'Margen superior (%)',
  'Bottom Clear Zone (%)': 'Margen inferior (%)',
  'Ignore Min Length': 'Ignorar long. mínima',
  'Min Length (chars)': 'Longitud mínima (caracteres)',
  'Backlog Mode': 'Modo de historial',
  'Backlog Opacity (%)': 'Opacidad historial (%)',
  'Author Rate Limit': 'Límite por autor',
  Language: 'Idioma',
  // ── Language names ──
  English: 'Inglés',
  한국어: 'Coreano',
  日本語: 'Japonés',
  Español: 'Español',
  中文: 'Chino',
  'Duration Multiplier (×)': 'Multiplicador de duración (×)',
  'Exit Padding (px)': 'Margen de salida (px)',
  'Min Scroll Duration (ms)': 'Duración mín. desplazamiento (ms)',
  'Max Scroll Duration (ms)': 'Duración máx. desplazamiento (ms)',
  'Top/Bottom Duration (ms)': 'Duración superior/inferior (ms)',
  'Max Queue Depth': 'Tamaño máx. de cola',
  'Tab Trim Target': 'Cola en segundo plano máx.',
  'Max Message Age (ms)': 'Edad máx. de mensaje (ms)',
  'Message Spacing (%)': 'Espacio entre mensajes (%)',
  'Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)':
    'Píxeles extra que un mensaje se desplaza más allá del borde antes de eliminarse (20-400, predeterminado 100)',
  'Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)':
    'Duración mínima de animación de desplazamiento — evita que mensajes cortos pasen demasiado rápido (1000-15000ms, predet. 5000)',
  'Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)':
    'Duración máxima de animación de desplazamiento — evita que mensajes largos vayan muy lento (5-120s, predet. 30000ms)',
  'Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)':
    'Duración fija de visualización para mensajes en modo superior/inferior (1000-30000ms, predet. 4000)',
  'Maximum pending queue depth before messages are dropped (50-1000, default 200)':
    'Profundidad máxima de cola pendiente antes de descartar mensajes (50-1000, predet. 200)',
  'Target active message count when trimming background tab (10-500, default 50)':
    'Objetivo de mensajes activos al recortar pestaña en segundo plano (10-500, predet. 50)',
  'Maximum message age before fade-out removal (10-300s, default 60000ms)':
    'Edad máxima del mensaje antes de eliminación por desvanecimiento (10-300s, predet. 60000ms)',
  'Gap between consecutive messages as percentage of message width (2-30%, default 8)':
    'Espacio entre mensajes consecutivos como porcentaje del ancho (2-30%, predet. 8)',
  'Enable Translation': 'Activar traducción',
  Service: 'Servicio',
  'Source Language': 'Idioma de origen',
  'Target Language': 'Idioma de destino',
  'Display Mode': 'Modo de visualización',
  'Near Speed (%)': 'Velocidad cerca (%)',
  'Far Speed (%)': 'Velocidad lejos (%)',
  'Far Opacity (%)': 'Opacidad lejos (%)',

  // ── Select options ──
  'Scroll (RTL)': 'Desplazar (der.→izq.)',
  'Reverse (LTR)': 'Inverso (izq.→der.)',
  'Top Fixed': 'Fijo arriba',
  'Bottom Fixed': 'Fijo abajo',
  'Bold (700)': 'Negrita (700)',
  'Normal (400)': 'Normal (400)',
  'Playback-based (recommended)': 'Basado en reproducción (recomendado)',
  'Recent only': 'Solo recientes',
  'Full (show all)': 'Completo (mostrar todo)',
  'None (skip backlog)': 'Ninguno (omitir historial)',
  Off: 'Apagado',
  'Normal (5 msg / 5s)': 'Normal (5 msg / 5s)',
  'Strict (2 msg / 5s)': 'Estricto (2 msg / 5s)',
  'Auto (Browser)': 'Automático (Navegador)',
  'Auto-detect': 'Detección automática',
  'Auto (Chrome built-in)': 'Automático (integrado en Chrome)',
  'Dual (original + translation)': 'Dual (original + traducción)',
  'Replace (translation only)': 'Reemplazar (solo traducción)',

  // ── Tooltips ──
  'Vertical gap between comment rows (negative = overlap)':
    'Espacio vertical entre filas (negativo = superposición)',
  'Text weight: Bold is more readable, Normal uses less GPU memory':
    'Negrita es más legible, Normal usa menos memoria de GPU',
  'CSS font-family value, e.g. "Noto Sans KR", sans-serif. Falls back to system default if not found.':
    'Valor CSS font-family, ej. "Noto Sans KR", sans-serif. Si no se encuentra, usa la fuente del sistema.',
  'Background opacity of Super Chat cards': 'Opacidad del fondo de tarjetas Super Chat',
  'Max body text lines before truncation (2-10)': 'Máximo de líneas antes de truncar (2-10)',
  'Max body text lines for membership messages (1-5)':
    'Máximo de líneas para mensajes de membresía (1-5)',
  'Display the purchase amount badge on Super Chat cards':
    'Mostrar la insignia de monto de compra en tarjetas Super Chat',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'Usar el color de texto del autor en lugar del predeterminado',
  'Keep top N% of video free of comments': 'Mantener el N% superior del video sin comentarios',
  'Keep bottom N% of video free of comments': 'Mantener el N% inferior del video sin comentarios',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length':
    'Mostrar todos los mensajes sin importar la longitud mínima',
  'Minimum character count': 'Cantidad mínima de caracteres',
  'Opacity of past messages relative to real-time messages':
    'Opacidad de mensajes pasados respecto a los actuales',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    'Cuánto más tiempo permanecen visibles los mensajes de moderador y propietario (1.0 = igual, 2.0 = el doble)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    'Traduce mensajes de chat en tiempo real (requiere Chrome 138+ con traducción integrada)',
  'Speed-based depth perception: fast messages appear near, slow messages appear far':
    'Percepción de profundidad por velocidad: mensajes rápidos cerca, lentos lejos',
  'Speed boost for near-layer messages': 'Aumento de velocidad para mensajes cercanos',
  'Speed reduction for far-layer messages': 'Reducción de velocidad para mensajes lejanos',
  'Opacity dimming for far-layer messages': 'Reducción de opacidad para mensajes lejanos',
  'How fast comments scroll across the screen in pixels per second':
    'Velocidad a la que los comentarios cruzan la pantalla (píxeles/segundo)',
  "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.":
    'Idioma de los mensajes de chat entrantes. La detección automática usa la detección de idioma integrada de Chrome.',
  'Language to translate chat messages into. Auto detects from browser settings.':
    'Idioma al que traducir los mensajes. Auto detecta desde la configuración del navegador.',
  'Limits how frequently messages from the same author appear':
    'Limita la frecuencia con la que aparecen mensajes del mismo autor',
  'Sets the overlay user interface language (does not filter comments by language)':
    'Establece el idioma de la interfaz (no filtra comentarios por idioma)',

  // ── New Performance / Developer section titles ──
  Performance: 'Rendimiento',
  Developer: 'Desarrollador',

  // ── New field labels ──
  'Max Concurrent Messages': 'Máx. mensajes',
  'Fade Duration (ms)': 'Duración fundido (ms)',
  'Min Poll Interval (ms)': 'Intervalo mín. sondeo (ms)',
  'Max Poll Interval (ms)': 'Intervalo máx. sondeo (ms)',
  'Max Injection Rate (msg/s)': 'Velocidad máx. (msg/s)',
  'Backlog Speed (×)': 'Multiplicador velocidad',
  'Recent Window (min)': 'Ventana (min)',
  'Log Level': 'Nivel de registro',
  'Debug Overlay': 'Superposición depuración',
  'Enable WebGL2': 'Habilitar WebGL2',

  // ── New select options ──
  'Warnings only': 'Solo avisos',
  Info: 'Información',
  'Debug (verbose)': 'Depuración (detallado)',

  // ── New tooltips ──
  'Maximum number of messages visible on screen at once (30-300)':
    'Número máximo de mensajes visibles en pantalla a la vez (30-300)',
  'How long messages take to fade out (0 = instant, 50-1000)':
    'Tiempo de desvanecimiento de los mensajes (0 = instantáneo, 50-1000)',
  'Minimum chat polling interval in milliseconds (50-5000)':
    'Intervalo mínimo de sondeo del chat en milisegundos (50-5000)',
  'Maximum chat polling interval in milliseconds (1000-30000)':
    'Intervalo máximo de sondeo del chat en milisegundos (1000-30000)',
  'Maximum backlog message injection rate per second (0-50)':
    'Velocidad máxima de inyección de mensajes del historial por segundo (0-50)',
  'Animation speed multiplier for backlog messages (1-5)':
    'Multiplicador de velocidad de animación para mensajes del historial (1-5)',
  'Time window in minutes for recent-only backlog mode (1-30)':
    'Ventana de tiempo en minutos para el modo de solo recientes (1-30)',
  'Console diagnostic output verbosity': 'Verbosidad de la salida de diagnóstico',
  'Show performance debug overlay on the video player':
    'Mostrar superposición de depuración de rendimiento en el reproductor de video',

  // ── New tooltips (added 2026-05-28) ──
  'Text size in pixels (14-50)': 'Tamaño del texto en píxeles (14-50)',
  'Text outline stroke width in pixels (0-8)': 'Ancho del contorno de texto en píxeles (0-8)',
  'Text outline stroke opacity (0-100%)': 'Opacidad del contorno de texto (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'Globally enable or disable the chat overlay on YouTube live streams':
    'Activa o desactiva la superposición de chat en las transmisiones en vivo de YouTube',
  'Comment display direction and behavior': 'Dirección y comportamiento de los comentarios',
  'Overall opacity of comment text (50-100%)':
    'Opacidad general del texto de comentarios (50-100%)',
  'Add a dark outline stroke around text for better readability':
    'Añade un contorno oscuro alrededor del texto para mejorar la legibilidad',
  'How past chat messages are displayed relative to live playback':
    'Cómo se muestran los mensajes antiguos en relación con la reproducción en vivo',
  'Dual shows original above translation, Replace shows translation only':
    'Dual muestra el original encima de la traducción, Reemplazar muestra solo la traducción',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'Emoji Cache (MB)': 'Caché de emojis (MB)',
  'Photo Cache (MB)': 'Caché de fotos (MB)',
  'Sticker Cache (MB)': 'Caché de stickers (MB)',
  'Text Cache (MB)': 'Caché de texto (MB)',
  'Translation Batch Size': 'Tamaño de lote de traducción',
  'Emoji Fetch Limit': 'Límite de obtención de emojis',
  'Failed Emoji Retry (min)': 'Reintento de emoji fallido (min)',
  'Max memory for emoji image cache (1-20 MB, default 3)':
    'Memoria máxima para caché de emojis (1-20 MB, predet. 3)',
  'Max memory for author photo cache (1-20 MB, default 2)':
    'Memoria máxima para caché de fotos (1-20 MB, predet. 2)',
  'Max memory for sticker image cache (1-20 MB, default 1)':
    'Memoria máxima para caché de stickers (1-20 MB, predet. 1)',
  'Max memory for text bitmap cache (1-20 MB, default 4)':
    'Memoria máxima para caché de texto (1-20 MB, predet. 4)',
  'Max translations applied per frame to avoid spikes (1-20, default 5)':
    'Traducciones máximas por fotograma (1-20, predet. 5)',
  'Max concurrent emoji fetch operations (1-20, default 6)':
    'Operaciones simultáneas máximas de emojis (1-20, predet. 6)',
  'How long to wait before retrying failed emoji fetches (1-60 min, default 5)':
    'Tiempo de espera antes de reintentar emojis fallidos (1-60 min, predet. 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'Burst Sample Window': 'Ventana de muestra de ráfaga',
  'Elevated Burst (msg/s)': 'Ráfaga elevada (msg/s)',
  'High Burst (msg/s)': 'Ráfaga alta (msg/s)',
  'Extreme Burst (msg/s)': 'Ráfaga extrema (msg/s)',
  'Backlog Injection Max': 'Inyección máx. historial',
  'Backlog Density Ramp (ms)': 'Rampa de densidad historial (ms)',
  'Live Poll Fallback (ms)': 'Sondeo alternativo (ms)',
  'Poll Failure Limit': 'Límite fallos sondeo',
  'Speed Boost Threshold': 'Umbral aumento velocidad',
  'Backlog Pause (%)': 'Pausar historial (%)',
  'Backlog Resume (%)': 'Reanudar historial (%)',
  'Activity Timeout (ms)': 'Tiempo de espera (ms)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'Burst rate sample window size': 'Tamaño de la ventana de muestreo de la tasa de ráfaga',
  'Messages per second threshold for elevated burst level':
    'Umbral de mensajes por segundo para el nivel de ráfaga elevado',
  'Messages per second threshold for high burst level':
    'Umbral de mensajes por segundo para el nivel de ráfaga alto',
  'Messages per second threshold for extreme burst level':
    'Umbral de mensajes por segundo para el nivel de ráfaga extremo',
  'Maximum backlog injection rate cap': 'Límite máximo de velocidad de inyección del historial',
  'Density ramp duration for backlog injection in milliseconds':
    'Duración de la rampa de densidad para la inyección del historial en milisegundos',
  'Live poll fallback delay in milliseconds':
    'Retraso alternativo del sondeo en vivo en milisegundos',
  'Consecutive poll failures before circuit breaker trips':
    'Fallos consecutivos de sondeo antes de que se active el interruptor',
  'Pending messages to trigger speed boost':
    'Mensajes pendientes para activar el aumento de velocidad',
  'Lane utilization ratio to pause backlog injection':
    'Relación de uso de carril para pausar la inyección del historial',
  'Lane utilization ratio to resume backlog injection':
    'Relación de uso de carril para reanudar la inyección del historial',
  'Chat activity timeout in milliseconds': 'Tiempo de espera de actividad del chat en milisegundos',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'Stagger Max Delay (ms)': 'Retardo máx. escalonado (ms)',
  'Stagger Medium Delay (ms)': 'Retardo escalonado medio (ms)',
  'Emoji Fetch Timeout (ms)': 'Tiempo de espera de emoji (ms)',
  'Backlog Density Ramp Max (ms)': 'Rampa densidad historial máx. (ms)',
  'Backlog Injection Rate Min (msg/s)': 'Inyección historial mín.',
  'Speed Boost Max': 'Aumento velocidad máx.',
  'Speed Boost Denominator': 'Denom. aumento velocidad',
  'Backlog Toggle Cooldown (ms)': 'Enfriamiento alternar historial (ms)',
  'Replay Prefetch Pages': 'Páginas precarga repetición',
  'Replay Batch Limit': 'Límite lotes repetición',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'Max stagger delay for messages in same batch':
    'Retardo máximo escalonado para mensajes en el mismo lote',
  'Medium stagger delay when queue depth is medium':
    'Retardo escalonado medio cuando la cola está a media capacidad',
  'Timeout for emoji fetch operations': 'Tiempo de espera para operaciones de obtención de emojis',
  'Max density ramp duration for backlog injection':
    'Duración máxima de la rampa de densidad para la inyección del historial',
  'Minimum backlog injection rate (msg/s)': 'Tasa mínima de inyección del historial (msg/s)',
  'Max speed boost factor for burst compensation':
    'Factor máximo de aumento de velocidad para compensación de ráfagas',
  'Speed boost denominator for EMA rate scaling':
    'Denominador de aumento de velocidad para escalado de tasa EMA',
  'Cooldown between backlog pause toggles': 'Enfriamiento entre cambios de pausa del historial',
  'Max pages to prefetch in replay mode': 'Máximo de páginas a precargar en modo repetición',
  'Max batches to fetch in replay initialization':
    'Máximo de lotes a obtener en la inicialización de repetición',

  // ── Modal chrome ──
  'Chat Overlay': 'Superposición de Chat',
  'Close settings': 'Cerrar configuración',
  'Settings categories': 'Categorías',
  'Overlay Enabled': 'Superposición activada',
  'Value adjusted to': 'Valor ajustado a ',
  Reset: 'Restablecer',
  Export: 'Exportar',
  Import: 'Importar',
  Close: 'Cerrar',
  'Reset all settings to defaults?':
    '¿Restablecer todas las opciones a los valores predeterminados?',
  Cancel: 'Cancelar',
  'Import failed: invalid settings format': 'Error de importación: formato no válido',
  'Settings imported successfully': 'Configuración importada correctamente',
  'Import failed: invalid JSON': 'Error de importación: JSON no válido',
  'Chat overlay settings': 'Configuración de superposición de chat',
  'Reset overlay settings': 'Restablecer superposición',
  'WebGL2 Renderer': 'Renderizador WebGL2',
  'Use WebGL2 GPU-accelerated rendering for higher performance (requires page reload)':
    'Usar renderizado WebGL2 acelerado por GPU para mayor rendimiento (requiere recargar la página)',
  'Reload overlay': 'Recargar superposición',

  // ── Author grid ──
  Color: 'Color',
  'Name Color': 'Color del nombre',
  Show: 'Mostrar',
  'Show Name': 'Mostrar nombre',
  Normal: 'Normal',
  Member: 'Miembro',
  Moderator: 'Moderador',
  Owner: 'Propietario',
  Verified: 'Verificado',
  SuperChat: 'SuperChat',
  'Loading chat history...': 'Cargando historial de chat...',
  'Short messages shown regardless of length': 'Mostrar mensajes cortos sin importar la longitud',

  // ── Toast / sync messages ──
  'Settings updated from another tab': 'Configuración actualizada desde otra pestaña',
  'Settings exported successfully': 'Configuración exportada correctamente',

  // ── Translation unsupported ──
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    'La traducción requiere un navegador con IA integrada. Usa Chrome 138+ o Edge 143+ Canary.',
};
