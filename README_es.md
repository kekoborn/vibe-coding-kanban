[English](README.md) | [Русский](README_ru.md) | [Français](README_fr.md) | **Español** | [中文](README_zh.md)

---

# Claude Kanban

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-required-blueviolet.svg)](https://claude.ai/code)

**Vibe coding kanban para Claude Code** — orquesta múltiples sesiones de código IA desde una sola pestaña del navegador.

Agrega tus tareas, presiona Iniciar, y deja que Claude Code las ejecute una por una. ¿Límite de velocidad alcanzado? El tablero lo detecta, muestra una cuenta regresiva y continúa automáticamente cuando se restablece.

> 📸 Capturas de pantalla próximamente. **Dale una estrella** para recibir notificaciones.

---

## Características

**Gestión de tareas**
- Tablero kanban drag-and-drop: Backlog → In Progress → Review → Done
- Niveles de prioridad: High, Medium, Low, Hold — con indicadores visuales
- Búsqueda y filtrado por texto, prioridad o ruta del proyecto
- Archivos adjuntos: archivos y enlaces
- Devolver una tarea a In Progress con un nuevo prompt (reejecutar con contexto)

**Orquestación IA**
- Auto-queue: las tareas del Backlog se inician automáticamente en Claude Code
- Detección de límite de velocidad con cuenta regresiva y reanudación automática
- Modo auto-approve para los permisos de Claude Code
- `/compact` cada 10 tareas para conservar tokens de contexto
- La tarea permanece en **In Progress** durante el rate limit — pasa a Review solo al terminar de verdad

**Gestión de terminales**
- Terminales en tiempo real xterm.js con renderizado WebGL
- Un terminal por ruta de proyecto — múltiples proyectos en paralelo
- Terminal auxiliar para redactar prompts
- Sesiones PTY persistentes que sobreviven a la recarga del navegador
- Streaming de salida en tiempo real vía WebSocket

**UX**
- Temas oscuro y claro
- Panel dividido kanban/terminal redimensionable
- Columnas colapsables
- Panel de registros en tiempo real

---

## Inicio rápido

```bash
git clone https://github.com/kekoborn/claude-kanban.git
cd claude-kanban
npm install
npm start
```

Abre **http://localhost:3000** en tu navegador.

---

## Requisitos previos

- **Node.js 18+**
- **Claude Code CLI** instalado y autenticado (comando `claude` disponible en el PATH)
- **macOS o Linux** (requerido por `node-pty`)

---

## Cómo funciona

1. **Crea tareas** — agrega títulos y prompts de Claude Code al Backlog
2. **Presiona «▶ Start queue»** — las tareas pasan a In Progress y Claude Code comienza a trabajar
3. **Observa en vivo** — el panel de terminal transmite la salida de Claude Code en tiempo real
4. **Auto-completar** — cuando Claude regresa a su prompt (detección de inactividad), la tarea pasa a Review
5. **¿Límite de velocidad?** — el tablero muestra un temporizador, espera el restablecimiento, envía "continuar" automáticamente

---

## Arquitectura

```
claude-kanban/
├── server.js       — Servidor Express + WebSocket, gestión PTY, rate-limit y auto-approve
├── db.js           — Capa SQLite (better-sqlite3, modo WAL)
└── public/
    ├── index.html  — Shell de la aplicación SPA
    ├── app.js      — Lógica kanban, drag-and-drop, modales, cliente WS
    ├── terminal.js — Gestor de terminales (xterm.js, pestañas, ciclo de vida PTY)
    ├── styles.css  — Estilos completos temas oscuro/claro
    └── favicon.svg — Icono del tablero kanban
```

---

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Servidor | Node.js, Express, ws (WebSocket) |
| Base de datos | SQLite via better-sqlite3 (modo WAL) |
| Terminal | @lydell/node-pty, xterm.js v5 + WebGL |
| Frontend | Vanilla JS, SortableJS, CSS custom properties |
| Carga de archivos | Multer |

---

## Configuración

| Variable / Constante | Por defecto | Descripción |
|----------------------|-------------|-------------|
| `PORT` (env) | `3000` | Puerto del servidor HTTP |
| `IDLE_COMPLETE_DELAY` | `10000` ms | Inactividad antes de completar la tarea |
| `PROMPT_COMPLETE_DELAY` | `3000` ms | Tiempo tras detectar el prompt de Claude |
| `COMPACT_EVERY_N_TASKS` | `10` | Enviar `/compact` cada N tareas |

---

## Contribuir

¡Issues y pull requests son bienvenidos! Para cambios importantes, abre un issue primero.

---

## Licencia

MIT — ver [LICENSE](LICENSE)
