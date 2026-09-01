# Requirements: Playground Contacts

## Overview
A minimal contacts list demonstrating a runnable Agent App. One user manages
contacts; an agent operates them through A2App.

## Features
- The user can see all contacts.
- The agent can create a contact with a name and tier through A2App.
- The agent can read a contact back by id.
- The app rejects an invalid tier at write time (guard).
- The agent can count contacts in a tier via the count-by-tier operation.

## Data
- **contacts**: name (required), email, company, tier (lead/customer/vip),
  follow_up (YYYY-MM-DD), created (server-set).

## Design
Not applicable — the playground exposes the A2App surface and is driven by tests;
a View can be added later.

## Operations
- count-by-tier (read-only): count contacts in a tier.

## Quality of life
- Seeded with one example contact so reads return data immediately.
