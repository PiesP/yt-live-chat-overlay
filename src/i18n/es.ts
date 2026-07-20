// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const ES: Record<string, string> = {
  // ── Pane tabs ──
  Comments: 'Comentarios',
  Appearance: 'Tarjetas y Colores',
  Advanced: 'Avanzado',
  Translation: 'Traducción',

  // ── Aria labels / misc ──
  'app.name': 'Live chat overlay',
  Paused: 'Pausado',
  'app.langChanged': 'Idioma de interfaz cambiado a: ',

  // ── Canvas connection status ──
  'status.connecting': 'Conectando…',
  'status.unstable': 'Conexión inestable',
  'status.disconnected': 'Desconectado — Haz clic para recargar',
  'status.waiting': 'Esperando transmisión en vivo…',

  // ── Section titles ──
  Cards: 'Tarjetas',
  'appearance.outline': 'Contorno de texto',
  'danmaku.safeZone': 'Zona segura',
  'advanced.messageRate': 'Frecuencia de mensajes',
  'advanced.depthLayers': 'Capas de profundidad',
  Font: 'Fuente',
  Backlog: 'Historial',
  Timing: 'Temporización',
  Tuning: 'Ajustes',
  'advanced.burst': 'Detección de ráfagas',
  Cache: 'Caché',
  'appearance.authors': 'Colores y visibilidad',
  Interface: 'Interfaz',
  'translation.chat': 'Traducción de chat',
  'translation.serviceDesc': 'Servicio de traducción para procesar mensajes',

  // ── Field labels ──
  'advanced.authorRateLimit': 'Límite por autor',
  'advanced.backlogMode': 'Modo de historial',
  'advanced.backlogOpacity': 'Opacidad historial (%)',
  Bold: 'Negrita',
  'danmaku.bottomClearZone': 'Margen inferior (%)',
  'danmaku.fontCustom': 'Fuente personalizada…',
  'danmaku.mode': 'Modo Danmaku',
  Enabled: 'Activado',
  Family: 'Familia',
  'advanced.ignoreMinLength': 'Ignorar long. mínima',
  'danmaku.laneGap': 'Espacio entre líneas (px)',
  Language: 'Idioma',
  'appearance.membershipMaxLines': 'Líneas máx. membresía',
  'advanced.minLength': 'Longitud mínima (caracteres)',
  'appearance.outlineOpacity': 'Opacidad del contorno (%)',
  'appearance.outlineWidth': 'Ancho del contorno (px)',
  'appearance.preserveUserColors': 'Conservar colores de usuario',
  Regular: 'Normal',
  'danmaku.scrollSpeed': 'Velocidad (px/s)',
  'appearance.showSuperchatAmount': 'Mostrar monto SuperChat',
  'danmaku.fontSize': 'Tamaño (px)',
  'appearance.superchatMaxLines': 'Líneas máx. SuperChat',
  'appearance.superchatOpacity': 'Opacidad SuperChat (%)',
  'danmaku.textOpacity': 'Opacidad del texto (%)',
  'danmaku.topClearZone': 'Margen superior (%)',
  Weight: 'Peso',
  // ── Language names ──
  English: 'Inglés',
  한국어: 'Coreano',
  日本語: 'Japonés',
  Español: 'Español',
  中文: 'Chino',
  العربية: 'Árabe',
  'danmaku.durationMul': 'Multiplicador de duración (×)',
  'danmaku.exitPadding': 'Margen de salida (px)',
  'danmaku.minScrollDuration': 'Duración mín. desplazamiento (ms)',
  'danmaku.maxScrollDuration': 'Duración máx. desplazamiento (ms)',
  'danmaku.topBottomDuration': 'Duración superior/inferior (ms)',
  'advanced.maxQueueDepth': 'Tamaño máx. de cola',
  'advanced.tabTrimTarget': 'Cola en segundo plano máx.',
  'advanced.maxMessageAge': 'Edad máx. de mensaje (ms)',
  'danmaku.messageSpacing': 'Espacio entre mensajes (%)',
  'danmaku.exitPaddingDesc':
    'Píxeles extra que un mensaje se desplaza más allá del borde antes de eliminarse (20-400, predeterminado 100)',
  'danmaku.minScrollDurationDesc':
    'Duración mínima de animación de desplazamiento — evita que mensajes cortos pasen demasiado rápido (1000-15000ms, predet. 5000)',
  'danmaku.maxScrollDurationDesc':
    'Duración máxima de animación de desplazamiento — evita que mensajes largos vayan muy lento (5-120s, predet. 30000ms)',
  'danmaku.topBottomDurationDesc':
    'Duración fija de visualización para mensajes en modo superior/inferior (1000-30000ms, predet. 4000)',
  'advanced.maxQueueDepthDesc':
    'Profundidad máxima de cola pendiente antes de descartar mensajes (50-1000, predet. 200)',
  'advanced.tabTrimTargetDesc':
    'Objetivo de mensajes activos al recortar pestaña en segundo plano (10-500, predet. 50)',
  'advanced.maxMessageAgeDesc':
    'Edad máxima del mensaje antes de eliminación por desvanecimiento (10-300s, predet. 60000ms)',
  'danmaku.messageSpacingDesc':
    'Espacio entre mensajes consecutivos como porcentaje del ancho (2-30%, predet. 8)',
  'translation.enable': 'Activar traducción',
  Service: 'Servicio',
  'translation.source': 'Idioma de origen',
  'translation.target': 'Idioma de destino',
  'translation.displayMode': 'Modo de visualización',
  'advanced.depthNearSpeed': 'Velocidad cerca (%)',
  'advanced.depthFarSpeed': 'Velocidad lejos (%)',
  'advanced.depthFarOpacity': 'Opacidad lejos (%)',

  // ── Select options ──
  'danmaku.scroll': 'Desplazar (der.→izq.)',
  'danmaku.reverse': 'Inverso (izq.→der.)',
  'danmaku.top': 'Fijo arriba',
  'danmaku.bottom': 'Fijo abajo',
  'advanced.backlogPlayback': 'Basado en reproducción (recomendado)',
  'advanced.backlogRecent': 'Solo recientes',
  'advanced.backlogFull': 'Completo (mostrar todo)',
  'advanced.backlogNone': 'Ninguno (omitir historial)',
  Off: 'Apagado',
  'advanced.authorRateLimitNormal': 'Normal (5 msg / 5s)',
  'advanced.authorRateLimitStrict': 'Estricto (2 msg / 5s)',
  'translation.languageAuto': 'Automático (Navegador)',
  'translation.sourceAuto': 'Detección automática',
  'translation.serviceAuto': 'Automático (integrado en Chrome)',
  'translation.displayModeDual': 'Dual (original + traducción)',
  'translation.displayModeReplace': 'Reemplazar (solo traducción)',

  // ── Tooltips ──
  'danmaku.laneGapDesc': 'Espacio vertical entre filas (0 = filas adyacentes)',
  'danmaku.fontWeightDesc': 'Negrita es más legible, Normal usa menos memoria de GPU',
  'danmaku.fontFamilyDesc': 'Familia tipográfica del texto',
  'danmaku.fontCustomDesc':
    'Valor CSS font-family, ej. "Noto Sans KR", sans-serif. Si no se encuentra, usa la fuente del sistema.',
  'appearance.superchatOpacityDesc': 'Opacidad del fondo de tarjetas Super Chat',
  'appearance.superchatMaxLinesDesc': 'Máximo de líneas antes de truncar (2-10)',
  'appearance.membershipMaxLinesDesc': 'Máximo de líneas para mensajes de membresía (1-5)',
  'appearance.showSuperchatAmountDesc':
    'Mostrar la insignia de monto de compra en tarjetas Super Chat',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'Usar el color de texto del autor en lugar del predeterminado',
  'danmaku.topClearZoneDesc': 'Mantener el N% superior del video sin comentarios',
  'danmaku.bottomClearZoneDesc': 'Mantener el N% inferior del video sin comentarios',
  'advanced.ignoreMinLengthDesc': 'Mostrar todos los mensajes sin importar la longitud mínima',
  'advanced.minLengthDesc': 'Cantidad mínima de caracteres',
  'advanced.backlogOpacityDesc': 'Opacidad de mensajes pasados respecto a los actuales',
  'danmaku.durationMulDesc':
    'Cuánto más tiempo permanecen visibles los mensajes de moderador y propietario (1.0 = igual, 2.0 = el doble)',
  'translation.enableDesc':
    'Traduce mensajes de chat en tiempo real (requiere Chrome 138+ con traducción integrada)',
  'advanced.depthLayersDesc':
    'Percepción de profundidad por velocidad: mensajes rápidos cerca, lentos lejos',
  'advanced.depthNearSpeedDesc': 'Aumento de velocidad para mensajes cercanos',
  'advanced.depthFarSpeedDesc': 'Reducción de velocidad para mensajes lejanos',
  'advanced.depthFarOpacityDesc': 'Reducción de opacidad para mensajes lejanos',
  'danmaku.scrollSpeedDesc':
    'Velocidad a la que los comentarios cruzan la pantalla (píxeles/segundo)',
  "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.":
    'Idioma de los mensajes de chat entrantes. La detección automática usa la detección de idioma integrada de Chrome.',
  'translation.sourceDesc':
    'Idioma al que traducir los mensajes. Auto detecta desde la configuración del navegador.',
  'advanced.authorRateLimitDesc':
    'Limita la frecuencia con la que aparecen mensajes del mismo autor',
  'translation.languageDesc':
    'Establece el idioma de la interfaz (no filtra comentarios por idioma)',

  // ── New Performance / Developer section titles ──
  Performance: 'Rendimiento',
  Developer: 'Desarrollador',

  // ── New field labels ──
  'advanced.maxConcurrent': 'Máx. mensajes',
  'advanced.fadeDuration': 'Duración fundido (ms)',
  'advanced.minPollInterval': 'Intervalo mín. sondeo (ms)',
  'advanced.maxPollInterval': 'Intervalo máx. sondeo (ms)',
  'advanced.backlogInjectionRate': 'Velocidad máx. (msg/s)',
  'advanced.backlogSpeed': 'Multiplicador velocidad',
  'advanced.backlogRecentWindow': 'Ventana (min)',
  'advanced.logLevel': 'Nivel de registro',
  'advanced.debugOverlay': 'Superposición depuración',

  // ── New select options ──
  'advanced.logLevelWarn': 'Solo avisos',
  Info: 'Información',
  'advanced.logLevelDebug': 'Depuración (detallado)',

  // ── New tooltips ──
  'advanced.maxConcurrentDesc': 'Número máximo de mensajes visibles en pantalla a la vez (30-300)',
  'advanced.fadeDurationDesc':
    'Tiempo de desvanecimiento de los mensajes (0 = instantáneo, 50-1000)',
  'advanced.minPollIntervalDesc': 'Intervalo mínimo de sondeo del chat en milisegundos (50-5000)',
  'advanced.maxPollIntervalDesc':
    'Intervalo máximo de sondeo del chat en milisegundos (1000-30000)',
  'advanced.backlogInjectionRateDesc':
    'Velocidad máxima de inyección de mensajes del historial por segundo (0-50)',
  'advanced.backlogSpeedDesc':
    'Multiplicador de velocidad de animación para mensajes del historial (1-5)',
  'advanced.backlogRecentWindowDesc':
    'Ventana de tiempo en minutos para el modo de solo recientes (1-30)',
  'advanced.logLevelDesc': 'Verbosidad de la salida de diagnóstico',
  'advanced.debugOverlayDesc':
    'Mostrar superposición de depuración de rendimiento en el reproductor de video',

  // ── New tooltips (added 2026-05-28) ──
  'danmaku.fontSizeDesc': 'Tamaño del texto en píxeles (14-50)',
  'appearance.outlineWidthDesc': 'Ancho del contorno de texto en píxeles (0-8)',
  'appearance.outlineOpacityDesc': 'Opacidad del contorno de texto (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'app.enabledDesc':
    'Activa o desactiva la superposición de chat en las transmisiones en vivo de YouTube',
  'danmaku.modeDesc': 'Dirección y comportamiento de los comentarios',
  'danmaku.textOpacityDesc': 'Opacidad general del texto de comentarios (50-100%)',
  'appearance.outlineEnabledDesc':
    'Añade un contorno oscuro alrededor del texto para mejorar la legibilidad',
  'advanced.backlogModeDesc':
    'Cómo se muestran los mensajes antiguos en relación con la reproducción en vivo',
  'translation.displayModeDesc':
    'Dual muestra el original encima de la traducción, Reemplazar muestra solo la traducción',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'advanced.emojiCache': 'Caché de emojis (MB)',
  'advanced.photoCache': 'Caché de fotos (MB)',
  'advanced.stickerCache': 'Caché de stickers (MB)',
  'advanced.textCache': 'Caché de texto (MB)',
  'advanced.translationBatchSize': 'Tamaño de lote de traducción',
  'advanced.emojiFetchLimit': 'Límite de obtención de emojis',
  'advanced.emojiRetryMin': 'Reintento de emoji fallido (min)',
  'advanced.emojiCacheDesc': 'Memoria máxima para caché de emojis (1-20 MB, predet. 3)',
  'advanced.photoCacheDesc': 'Memoria máxima para caché de fotos (1-20 MB, predet. 2)',
  'advanced.stickerCacheDesc': 'Memoria máxima para caché de stickers (1-20 MB, predet. 1)',
  'advanced.textCacheDesc': 'Memoria máxima para caché de texto (1-20 MB, predet. 4)',
  'advanced.translationBatchSizeDesc': 'Traducciones máximas por fotograma (1-20, predet. 5)',
  'advanced.emojiFetchLimitDesc': 'Operaciones simultáneas máximas de emojis (1-20, predet. 6)',
  'advanced.emojiRetryMinDesc':
    'Tiempo de espera antes de reintentar emojis fallidos (1-60 min, predet. 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'advanced.burstSampleWindow': 'Ventana de muestra de ráfaga',
  'advanced.burstElevated': 'Ráfaga elevada (msg/s)',
  'advanced.burstHigh': 'Ráfaga alta (msg/s)',
  'advanced.burstExtreme': 'Ráfaga extrema (msg/s)',
  'advanced.tuningBacklogInjectionMax': 'Inyección máx. historial',
  'advanced.tuningDensityRamp': 'Rampa de densidad historial (ms)',
  'advanced.tuningPollFallback': 'Sondeo alternativo (ms)',
  'advanced.tuningPollFailureLimit': 'Límite fallos sondeo',
  'advanced.tuningSpeedBoostThreshold': 'Umbral aumento velocidad',
  'advanced.tuningBacklogPause': 'Pausar historial (%)',
  'advanced.tuningBacklogResume': 'Reanudar historial (%)',
  'advanced.tuningActivityTimeout': 'Tiempo de espera (ms)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'advanced.burstSampleWindowDesc': 'Tamaño de la ventana de muestreo de la tasa de ráfaga',
  'advanced.burstElevatedDesc': 'Umbral de mensajes por segundo para el nivel de ráfaga elevado',
  'advanced.burstHighDesc': 'Umbral de mensajes por segundo para el nivel de ráfaga alto',
  'advanced.burstExtremeDesc': 'Umbral de mensajes por segundo para el nivel de ráfaga extremo',
  'advanced.tuningBacklogInjectionMaxDesc': 'Límite máximo de velocidad de inyección del historial',
  'advanced.tuningDensityRampDesc':
    'Duración de la rampa de densidad para la inyección del historial en milisegundos',
  'advanced.tuningPollFallbackDesc': 'Retraso alternativo del sondeo en vivo en milisegundos',
  'advanced.tuningPollFailureLimitDesc':
    'Fallos consecutivos de sondeo antes de que se active el interruptor',
  'advanced.tuningSpeedBoostThresholdDesc':
    'Mensajes pendientes para activar el aumento de velocidad',
  'advanced.tuningBacklogPauseDesc':
    'Relación de uso de carril para pausar la inyección del historial',
  'advanced.tuningBacklogResumeDesc':
    'Relación de uso de carril para reanudar la inyección del historial',
  'advanced.tuningActivityTimeoutDesc': 'Tiempo de espera de actividad del chat en milisegundos',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'advanced.tuningStaggerMax': 'Retardo máx. escalonado (ms)',
  'advanced.tuningStaggerMedium': 'Retardo escalonado medio (ms)',
  'advanced.tuningEmojiTimeout': 'Tiempo de espera de emoji (ms)',
  'advanced.tuningDensityRampMax': 'Rampa densidad historial máx. (ms)',
  'advanced.tuningInjectionRateMin': 'Inyección historial mín.',
  'advanced.tuningSpeedBoostMax': 'Aumento velocidad máx.',
  'advanced.tuningSpeedBoostDenom': 'Denom. aumento velocidad',
  'advanced.tuningToggleCooldown': 'Enfriamiento alternar historial (ms)',
  'advanced.replayPrefetchPages': 'Páginas precarga repetición',
  'advanced.replayBatchLimit': 'Límite lotes repetición',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'advanced.tuningStaggerMaxDesc': 'Retardo máximo escalonado para mensajes en el mismo lote',
  'advanced.tuningStaggerMediumDesc':
    'Retardo escalonado medio cuando la cola está a media capacidad',
  'advanced.tuningEmojiTimeoutDesc': 'Tiempo de espera para operaciones de obtención de emojis',
  'advanced.tuningDensityRampMaxDesc':
    'Duración máxima de la rampa de densidad para la inyección del historial',
  'advanced.tuningInjectionRateMinDesc': 'Tasa mínima de inyección del historial (msg/s)',
  'advanced.tuningSpeedBoostMaxDesc':
    'Factor máximo de aumento de velocidad para compensación de ráfagas',
  'advanced.tuningSpeedBoostDenomDesc':
    'Denominador de aumento de velocidad para escalado de tasa EMA',
  'advanced.tuningToggleCooldownDesc': 'Enfriamiento entre cambios de pausa del historial',
  'advanced.replayPrefetchPagesDesc': 'Máximo de páginas a precargar en modo repetición',
  'advanced.replayBatchLimitDesc': 'Máximo de lotes a obtener en la inicialización de repetición',

  // ── Modal chrome ──
  'app.title': 'Superposición de Chat',
  'app.close': 'Cerrar configuración',
  'app.settingsCategories': 'Categorías',
  'app.enabled': 'Superposición activada',
  'format.valueAdjusted': 'Valor ajustado a ',
  Reset: 'Restablecer',
  Export: 'Exportar',
  Import: 'Importar',
  Close: 'Cerrar',
  Done: 'Listo',
  'app.autoSave': 'Los cambios se guardan automáticamente',
  'reset.confirm': '¿Restablecer todas las opciones a los valores predeterminados?',
  Cancel: 'Cancelar',
  'import.invalidFormat': 'Error de importación: formato no válido',
  'import.success': 'Configuración importada correctamente',
  'import.invalidJson': 'Error de importación: JSON no válido',
  'app.settings': 'Configuración de superposición de chat',
  'reset.confirmDesc': 'Restablecer superposición',
  'app.reload': 'Recargar superposición',

  // ── Author grid ──
  Color: 'Color',
  'appearance.authorsNameColor': 'Color del nombre',
  Show: 'Mostrar',
  'appearance.authorsShowName': 'Mostrar nombre',
  Normal: 'Normal',
  Member: 'Miembro',
  Moderator: 'Moderador',
  Owner: 'Propietario',
  Verified: 'Verificado',
  SuperChat: 'SuperChat',
  'indicator.loading': 'Cargando historial de chat...',
  'format.shortMessagesShown': 'Mostrar mensajes cortos sin importar la longitud',

  // ── Toast / sync messages ──

  // ── Translation unsupported ──
  'translation.unsupported':
    'La traducción requiere un navegador con IA integrada. Usa Chrome 138+ o Edge 143+ Canary.',

  // ── Added 2026-07-04 ──
  'chat.messages': 'Mensajes del chat',
  'advanced.ignoreReducedMotion': 'Ignorar movimiento reducido',
  'advanced.ignoreReducedMotionDesc':
    'Forzar animaciones de desplazamiento incluso con movimiento reducido del SO activado (requiere recargar)',
};
