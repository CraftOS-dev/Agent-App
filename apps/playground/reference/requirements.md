# Requirements: Playground Contacts

## Overview
A small contacts CRM demonstrating a runnable Agent App. One user manages
contacts and the outreach logged against them; an agent operates them through
A2App by walking the app rather than by reading a list of every operation.

## Features
- The user can see all contacts and the companies they belong to.
- The agent can arrive at the app and see its modules without knowing anything
  about it first.
- The agent can walk from a module to an entity to one record.
- The agent can create a contact with a name and tier through A2App.
- The agent can read a contact back by id.
- The app rejects an invalid tier at write time (guard).
- The agent can count contacts in a tier via the count-by-tier operation.
- On one contact's record, the agent can see which operations apply to *that*
  contact and why the others do not.
- From a contact's record, the agent can open its touchpoints.

## Modules
- **directory** — people and the companies they belong to.
- **outreach** — every logged contact with a person.

The split is the app's organizing unit, not a cosmetic grouping: it is what the
root screen lists, and every entity and operation belongs to exactly one.

## Data
- **companies** (directory): name (required), domain, created (server-set).
- **people** (directory): name (required), email, company (→ companies), tier
  (lead/customer/vip), follow_up (YYYY-MM-DD), archived, touchpoints (list →
  touchpoints), created (server-set).
- **touchpoints** (outreach): person (→ people, required), channel
  (email/call/meeting), note, replied, created (server-set).

## Design
Not applicable — the playground exposes the A2App surface and is driven by the
`a2app` client; a View can be added later.

## Operations
- **count-by-tier** (directory, module-level, read-only): count contacts in a
  tier.
- **promote-to-customer** (directory → people): move a contact to the customer
  tier. Unavailable on a contact already in that tier.
- **archive-person** (directory → people, destructive): archive a contact.
  Unavailable on one already archived.
- **mark-replied** (outreach → touchpoints): record that a touchpoint got a
  reply. Unavailable on one already marked replied.

## Quality of life
- Seeded with two contacts, one company, and one touchpoint, so every level of
  the walk returns data immediately — including a record with a blocked
  operation (Ada is already a vip) and one without (Charles is a lead).
