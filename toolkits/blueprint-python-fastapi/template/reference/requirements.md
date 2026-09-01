# Requirements: FastAPI Agent App

## Overview
A personal to-do app on FastAPI. A user manages tasks; an agent operates them
through A2App.

## Features
- The user can add, view, update, and delete tasks (via the agent or a View you add).
- The agent can list, create, update, and delete tasks through A2App.
- The app rejects an invalid status or a relative date at write time (guard).
- The agent can count tasks via count-tasks.

## Data
- **tasks**: title (required), status (todo/doing/done), due (YYYY-MM-DD), notes,
  created (server-set).

## Design
Add a View (Jinja/HTMX/React) as needed; the starter ships the A2App surface.

## Operations
- count-tasks (read-only): return the number of tasks.

## Quality of life
- The adapter self-test runs in the gate, proving the Python rules match spec.
