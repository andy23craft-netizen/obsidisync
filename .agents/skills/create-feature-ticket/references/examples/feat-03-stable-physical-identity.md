# Feat-03 - Stable physical identity and map-status contract

**Status:** Proposed  
**Owner:** Backend  
**Dependencies:** Feat-02 must be complete first.

## Goal

Give Shade a stable, versioned physical-library contract that a separate Kinbote service can consume without relying on shelf names or accessing Shade's database.

## Context

Shade remains authoritative for catalog and book placement data, while Kinbote is a separate consumer of physical-library state.

Human-readable shelf names are presentation data and may change. They therefore cannot safely serve as identifiers for physical shelves or as part of the Shade/Kinbote integration contract.

Physical-control capability must also remain a server-side trust decision. Browser-provided state must never be sufficient to grant access to physical controls.

## Scope

- Guarantee a canonical `book_id -> shelf_id` relationship for shelved copies.
- Represent unplaced, unshelved, Stashed, and other non-physical states explicitly and unambiguously.
- Expose stable `shelf_id` anywhere a physical shelf reference is required.
- Treat shelf names, display formatting, and sort order as presentation data only.
- Add versioned read models for:
  - map summary/revision
  - map freshness and stale reason
  - display capability
  - Kinbote availability
  - physical-session outcomes
- Align map-status reads with the v1 states:
  - `current`
  - `stale`
  - `unmapped`
  - `mapping`
  - `unavailable`
- Make physical-control capability a server decision derived from trusted router/proxy network context.
- Distinguish the v1 capability outcomes:
  - `disabled`
  - `not_on_home_lan`
  - `unauthorized`
  - `service_unavailable`
- Prevent map-status responses from exposing controller, calibration, provider, or other Kinbote-internal details.
- Document the resulting contract in OpenAPI and frontend guidance.

## Proposed architecture

Shade remains the source of truth for catalog identity and the canonical relationship between a book and its physical shelf.

Physical shelf identity is represented by stable `shelf_id` values. Mutable shelf attributes such as name, display formatting, and sort position must not participate in physical identity.

Kinbote consumes Shade's published contract rather than reading Shade's database directly.

Shade owns the externally visible capability decision. Whether a caller may access physical-control functionality is derived server-side from authenticated identity, configuration, trusted network context, and Kinbote availability as applicable.

Kinbote implementation details remain behind that boundary.

## Proposed contract

The physical-library contract is versioned.

### Physical placement

A shelved physical copy exposes its location through stable identity:

`book_id -> shelf_id`

A shelf rename, display-name change, or sort-order change must not alter that relationship.

Non-physical placement states must be represented explicitly rather than encoded through a synthetic or mutable shelf name.

### Map status

The v1 map-status state is one of:

- `current`
- `stale`
- `unmapped`
- `mapping`
- `unavailable`

When stale, the response may expose a safe stale reason defined by the public contract.

It must not expose controller identity, calibration state, provider implementation, credentials, or other Kinbote-internal information.

### Physical-control capability

Capability is determined by the server from trusted context.

The v1 response distinguishes:

- `disabled`
- `not_on_home_lan`
- `unauthorized`
- `service_unavailable`

Client/browser input may not grant physical-control capability or override the server's trust decision.

Exact endpoint and schema definitions should follow existing API versioning and authentication conventions and be published through OpenAPI.

## Acceptance criteria

- A consumer can identify the physical shelf of a shelved book using stable IDs only.
- Shelf rename, display-name formatting, and sort-order changes do not change physical identity.
- Unplaced, unshelved, Stashed, and other non-physical states are explicit and unambiguous.
- Kinbote can consume the required physical-library state without direct access to Shade's database.
- Map-status responses use only the documented v1 states.
- Stale-state responses expose only contract-safe stale reasons.
- Map-status and capability responses do not expose controller, calibration, provider, credential, or other Kinbote-internal details.
- Physical-control capability cannot be granted through browser-controlled input.
- Disabled, remote, unauthorized, and unavailable capability conditions are distinguishable according to the v1 contract.
- The published contract is versioned and authenticated as appropriate.
- OpenAPI and frontend guidance describe the resulting contract.

## Testing and validation

Backend coverage must verify at minimum:

- renaming a shelf does not change its `shelf_id` or a book's physical reference
- display-name and sort-order changes do not alter physical identity
- physical and non-physical placement states serialize unambiguously
- every documented v1 map-status state is represented correctly
- safe stale reasons do not leak Kinbote implementation detail
- capability behavior covers disabled callers
- capability behavior covers callers outside the trusted home-LAN context
- unauthorized callers cannot obtain physical-control capability
- browser-controlled request data cannot manufacture trusted network context
- unavailable Kinbote state produces the documented public capability/status behavior
- OpenAPI reflects the versioned public schemas

Use the repository's existing test level and fixture patterns where possible rather than introducing a parallel testing structure.

## Out of scope

- Kinbote storage
- controller implementation
- calibration
- display commands
- frontend screens
- placement invalidation
