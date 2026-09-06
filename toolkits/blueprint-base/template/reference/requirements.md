# Requirements: Base Agent App

## Overview
What this app is for, and who uses it. (Replace this — it is the binding spec the
gate and walk-verify check the app against.)

## Features
- The user can … (each feature a checkable capability — walk-verify drives them one
  by one, so phrase every item as something a user can observably do).

## Modules
Modules are the organizing unit: every entity and every operation belongs to
exactly one, and describe's root screen lists them. Declare them in
`manifest.json` BEFORE declaring anything that names one.
- **core** — this app's first area. Rename it as the app takes shape; split a
  module once its screen would exceed the 2,000-character describe budget.

## Data
Entities and the fields each must hold.

## Design
Layout, theme, any visual requirements.

## Operations
What the agent must be able to do on the user's behalf (maps to `operations.json`).

## Quality of life
Nice-to-haves, explicitly non-binding.
