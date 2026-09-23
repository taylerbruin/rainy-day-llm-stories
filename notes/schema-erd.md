# Rainy Day LLM Stories — Schema ER Diagram

Auto-generated from `server/schema/` on 2026-09-23. 12 tables.
Open this file with **Markdown Preview** (`Ctrl+K V`) — the diagram renders inline.

> **Note:** every table also carries the audit triple
> (`created_by`, `created_at`, `last_updated` + an `AFTER UPDATE` trigger)
> — omitted here to keep the diagram readable.

```mermaid
erDiagram
    %% ── Relationships ──────────────────────────────────────────
    world      ||--o{ place              : "has locations"
    world      ||--o{ character          : "has characters"
    world      ||--o{ chapter            : "has chapters"
    world      ||--|| world_state        : "1:1 live canon"
    world      ||--o{ save               : "has saves"

    place      }o--o{ character          : "live position (nullable)"
    character  ||--o{ location_association : "affiliated with (stable)"
    place      ||--o{ location_association : ""

    chapter    ||--o{ chapter_event      : "records events"
    chapter    ||--o{ chapter_character  : "involves characters"
    character  ||--o{ chapter_character  : "appears in"
    chapter    ||--o{ chapter_place      : "references places"
    place      ||--o{ chapter_place      : ""
    chapter    ||--o{ transcript         : "narrated in passages"

    chapter    }o--o{ save               : "last closed (nullable)"
    transcript }o--o{ save               : "resume point (nullable)"

    %% ── Table shapes ───────────────────────────────────────────
    world {
        INTEGER id PK
        TEXT    name
        TEXT    description
        JSON    tags
        TEXT    tone
        TEXT    era
    }

    place {
        INTEGER id PK
        INTEGER world_id FK
        TEXT    name
        TEXT    description
        TEXT    starting_mood  "immutable canon"
        TEXT    current_mood   "live, committed at chapter close"
        JSON    layout         "optional rooms/exits/notables graph"
    }

    character {
        INTEGER id PK
        INTEGER world_id FK
        TEXT    name
        INTEGER tier           "1 protagonist · 2 party · 3 NPC"
        TEXT    role
        TEXT    summary
        JSON    skills
        JSON    traits
        INTEGER current_location_id FK  "live position (nullable)"
        INTEGER is_love_interest
        TEXT    status
    }

    location_association {
        INTEGER character_id PK FK
        INTEGER place_id     PK FK
    }

    chapter {
        INTEGER id PK
        INTEGER world_id FK
        INTEGER seq          "1-based story order (app-assigned)"
        TEXT    title
        TEXT    summary
        INTEGER word_count   "close-gate = 5000"
        TEXT    closed_at    "NULL until closed"
    }

    chapter_event {
        INTEGER id PK
        INTEGER chapter_id FK
        TEXT    kind         "major | minor"
        TEXT    what
        TEXT    detail
        INTEGER seq          "within-chapter order"
    }

    chapter_character {
        INTEGER chapter_id PK FK
        INTEGER character_id PK FK
        TEXT    involvement  "what THIS char did, this chapter"
    }

    chapter_place {
        INTEGER chapter_id PK FK
        INTEGER place_id   PK FK
    }

    transcript {
        INTEGER id PK
        INTEGER chapter_id FK
        TEXT    player_action  "regen seed (nullable)"
        TEXT    content        "the prose — what the LLM reads"
        INTEGER tokens
    }

    world_state {
        INTEGER id PK FK "PK = world id"
        INTEGER current_location_id FK
        JSON    established_facts
        JSON    open_threads
    }

    save {
        INTEGER id PK
        INTEGER world_id FK
        TEXT    name
        INTEGER chapter_id FK
        INTEGER open_transcript_id FK
    }

    meta {
        TEXT key PK
        TEXT value
    }
```

## How to read it

- **Solid line ending in a crow's foot** = "one to many" (a world has many places).
- **`||`** = exactly one; **`o`** = zero-or-one (nullable FK); **`{`** = many.
- **Composite PK** (two `PK` badges) = a bridge table (`location_association`, `chapter_character`, `chapter_place`) — no surrogate `id`.
- **`world_state`** is a 1:1 satellite: its PK *is* the world id.
- `save` is pure FKs to `world` / `chapter` / `transcript` — latest-state-only resume, no snapshots.

## The three "flavors" of reference

| Bridge table | Kind | Why |
|---|---|---|
| `location_association` | stable affiliation | where a character *belongs* (density) |
| `chapter_character` | content child (composite PK + note) | what a character *did* per chapter |
| `chapter_place` | pure bridge | which places a chapter *references* |
| `character.current_location_id` | FK on the parent | live *position* (drives in-scene vs. truncated load) |
