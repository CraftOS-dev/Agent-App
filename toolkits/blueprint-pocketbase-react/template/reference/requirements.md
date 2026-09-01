# Requirements: PocketBase-React Agent App

## Overview
A task board on the PocketBase + React stack. A user manages tasks in a React UI;
an agent operates them through A2App.

## Features
- The user can add, view, update, and delete tasks in the React UI.
- The agent can list, create, update, and delete tasks through A2App.
- The app rejects an invalid status or a relative date at write time (guard).
- The agent can archive all done tasks in one operation (with approval).

## Data
- **tasks**: title (required), status (todo/doing/done), due (YYYY-MM-DD),
  created (server-set).

## Design
React single-page board grouped by status; PocketBase realtime keeps it live.

## Operations
- archive-done (destructive): archive every completed task.

## Quality of life
- The adapter's rules self-test runs in the gate, proving parity with the spec.
