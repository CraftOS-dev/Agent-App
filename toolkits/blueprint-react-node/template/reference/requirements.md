# Requirements: React-Node Agent App

## Overview
A personal to-do app. A single user manages a list of tasks in the browser; an
agent can operate the same list on the user's behalf through A2App.

## Features
- The user can add a task with a title and an initial status.
- The user can see all tasks, most recent first.
- The user can change a task's status by clicking it (todo → doing → done).
- The user can delete a task.
- The agent can list, create, update, and delete tasks through A2App.
- The agent can clear all done tasks in one operation (with approval, since it is
  destructive).

## Data
- **tasks**: title (required), status (todo/doing/done), due (YYYY-MM-DD), notes,
  created (server-set).

## Design
Single centered column, system font, light/dark aware. Add form at the top, task
list below, a small count in the footer.

## Operations
- clear-done (destructive): delete every done task.
- count-tasks (read-only): return the number of tasks.

## Quality of life
- Keyboard submit on the add form.
- SPA fallback so deep links still load.
