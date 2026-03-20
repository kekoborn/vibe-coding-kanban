[English](README.md) | [Русский](README_ru.md) | **Français** | [Español](README_es.md) | [中文](README_zh.md)

---

# Vibe Coding Kanban

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-required-blueviolet.svg)](https://claude.ai/code)

**Vibe coding kanban pour Claude Code** — orchestrez plusieurs sessions de code IA depuis un seul onglet de navigateur.

Ajoutez vos tâches, appuyez sur Démarrer, et laissez Claude Code les traiter une par une. Limite de débit atteinte ? Le tableau la détecte, affiche un compte à rebours et reprend automatiquement dès la réinitialisation.

<video src="https://github.com/kekoborn/vibe-coding-kanban/releases/download/v0.1.0/kanban.preview.mp4" controls width="100%"></video>

---

## Fonctionnalités

**Gestion des tâches**
- Tableau kanban drag-and-drop : Backlog → In Progress → Review → Done
- Niveaux de priorité : High, Medium, Low, Hold — avec indicateurs visuels
- Recherche et filtrage par texte, priorité ou chemin de projet
- Pièces jointes : fichiers et liens
- Retour d'une tâche en In Progress avec un nouveau prompt (réexécution avec contexte)

**Orchestration IA**
- Auto-queue : les tâches du Backlog démarrent automatiquement dans Claude Code
- Détection de la limite de débit avec compte à rebours et reprise automatique
- Mode auto-approve pour les autorisations Claude Code
- `/compact` toutes les 10 tâches pour économiser les tokens
- La tâche reste en **In Progress** pendant la limite de débit — passe en Review uniquement après la fin réelle

**Gestion des terminaux**
- Terminaux temps réel xterm.js avec rendu WebGL
- Un terminal par chemin de projet — plusieurs projets en parallèle
- Terminal auxiliaire pour rédiger les prompts
- Sessions PTY persistantes qui survivent au rechargement du navigateur
- Streaming de la sortie via WebSocket

**UX**
- Thèmes sombre et clair
- Panneau divisé kanban/terminal redimensionnable
- Colonnes repliables
- Panneau de journaux en temps réel

---

## Démarrage rapide

```bash
git clone https://github.com/kekoborn/vibe-coding-kanban.git
cd vibe-coding-kanban
npm install
npm start
```

Ouvrez **http://localhost:3000** dans votre navigateur.

---

## Prérequis

- **Node.js 18+**
- **Claude Code CLI** installé et authentifié (commande `claude` disponible dans le PATH)
- **macOS ou Linux** (requis par `node-pty`)

---

## Comment ça fonctionne

1. **Créez des tâches** — ajoutez des titres et des prompts Claude Code dans le Backlog
2. **Appuyez sur «▶ Start queue»** — les tâches passent en In Progress et Claude Code commence
3. **Regardez en direct** — le panneau terminal diffuse la sortie de Claude Code en temps réel
4. **Auto-complétion** — quand Claude revient à son prompt (détection d'inactivité), la tâche passe en Review
5. **Limite de débit ?** — le tableau affiche un minuteur, attend la réinitialisation, envoie "continue" automatiquement

---

## Architecture

```
claude-kanban/
├── server.js       — Serveur Express + WebSocket, gestion PTY, rate-limit & auto-approve
├── db.js           — Couche SQLite (better-sqlite3, mode WAL)
└── public/
    ├── index.html  — Shell de l'application SPA
    ├── app.js      — Logique kanban, drag-and-drop, modales, client WS
    ├── terminal.js — Gestionnaire de terminaux (xterm.js, onglets, cycle de vie PTY)
    ├── styles.css  — Styles complets thèmes sombre/clair
    └── favicon.svg — Icône du tableau kanban
```

---

## Stack technique

| Couche | Technologie |
|--------|------------|
| Serveur | Node.js, Express, ws (WebSocket) |
| Base de données | SQLite via better-sqlite3 (mode WAL) |
| Terminal | @lydell/node-pty, xterm.js v5 + WebGL |
| Frontend | Vanilla JS, SortableJS, CSS custom properties |
| Upload de fichiers | Multer |

---

## Configuration

| Variable / Constante | Défaut | Description |
|----------------------|--------|-------------|
| `PORT` (env) | `3000` | Port du serveur HTTP |
| `IDLE_COMPLETE_DELAY` | `10000` ms | Inactivité avant complétion de la tâche |
| `PROMPT_COMPLETE_DELAY` | `3000` ms | Délai après détection du prompt Claude |
| `COMPACT_EVERY_N_TASKS` | `10` | Envoyer `/compact` toutes les N tâches |

---

## Contribuer

Issues et pull requests bienvenus ! Pour les changements majeurs, ouvrez d'abord une issue.

---

## Licence

MIT — voir [LICENSE](LICENSE)
