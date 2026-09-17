# PROJECT_GUIDELINES

## What this file is for

A general set of development conventions that applies to any project (backend,
frontend, admin panel, mobile application, smart contracts, libraries).

## Instruction for Claude Code

When this file is found in the project root, take the following steps.

1. Read it in full
2. Open the project's existing `CLAUDE.md`. If there is none, create it
3. Integrate the sections of this file into `CLAUDE.md`, adapting them to the
   specifics of the project
   - Carry the universal principles (communication, style, methodology,
     architectural constraints, keeping things up to date) over almost verbatim
   - Fill the template sections (Project Overview, Project Structure, Build &
     Verification Commands, Testing, Dependencies, versions, formatting, naming)
     with the concrete data found while analysing the repository
   - Do not duplicate sections that already exist in `CLAUDE.md`; merge them and
     keep the stricter wording
4. After integrating, check that the resulting `CLAUDE.md` has no contradictions
   between sections
5. Keep `PROJECT_GUIDELINES.md` in the repository as the source of truth for
   later updates of `CLAUDE.md`
6. Where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins: it reflects the
   specifics of the particular project

Do not integrate automatically without an explicit instruction from the user.
After reading the file, propose an integration plan and wait for confirmation.

---

## General principles of interaction

### Base methodology

- If there are critical questions without which the task certainly cannot be
  done, ask them before starting
- Do not write notes about what was done or what needs doing, and do not create
  readme files without an explicit request
- Add logs that make an error diagnosable. If the code already has logs, do not
  remove them without an explicit instruction
- A sceptical approach, with critical assessment of all input
- A formal, professional tone without flattery
- Strict adherence to instructions, without additions of your own
- Answers in Russian unless another language is explicitly requested
- Analyse all input for completeness and correctness
- Do only what was asked
- When creating or fixing files, always give full paths for the addition or
  replacement
- When asked about a problem in the code or when changing behavior, study the
  code step by step, identify the problem with full certainty and justify the
  diagnosis

### Style requirements

- Do not use upper case in text
- In Russian text, do not use the letter ё; replace it with е
- Do not use em dashes; replace them with a hyphen
- Do not use sweeping epithets (all, every, complete, exhaustive and the like)
- Do not use icons as formatting
- Do not put colons at the end of sentences or list items
- Minimal formatting, without superfluous elements

### Problem-solving methodology

- Establish exact causes without guessing
- Provide verified facts only
- Refuse generalizations that lack factual evidence
- Demand full accuracy in a diagnosis
- Offer concrete ways to verify the result
- No temporary solutions and no workarounds
- Do not make assumptions without checking
- Do not generalize without factual evidence
- State verified facts only
- An answer that sounds like "most likely" is not acceptable. Either understand
  the problem exactly and show it unambiguously, or propose a way to establish
  it with certainty

### How tasks are handled

- Describe the business logic and the algorithm first, then implement the code on
  an explicit request
- Describe the options with reasoning before writing code
- Solve root causes first, not symptoms
- When the data is insufficient, ask for the missing files instead of assuming
- Return whole files when making multiple edits, with correct formatting
- Fixing bugs takes priority over improving features
- Never propose a temporary solution

## Project Overview

A short description of the project in two or three sentences, so that an agent
has the context immediately.

Core concepts (filled in per project):
- the main modules and what each is responsible for
- the key data flows or business scenarios
- external integrations and adapters

## Post-release policy

Apply this once the code base is stabilized, has passed an audit or a review, or
has shipped to production.

- Fixes and targeted improvements only, no large refactors
- Minimal diffs, changes strictly within the boundaries of the task
- Do not rename variables, do not move functions around, do not clean up
  neighbouring code
- Do not touch existing documentation and comments unless the fix changes the
  behavior they describe
- Do not change the existing test infrastructure (base classes, fixtures, mocks)
  unless the fix requires it
- New or changed code must carry documentation and tests covering every new line
  and branch
- If a fix affects benchmarks or snapshots (performance, bundle size, render
  time), regenerate the corresponding artifacts

## Architectural constraints

- Preserve the existing architecture unchanged
- Reusing existing code comes first
- Do not change the input and output parameters of functions without agreement
- Do not propose architectural modifications unless asked
- Changing the architecture, proposing to change it, simplifying it or making
  temporary solutions is forbidden
- Stay within the existing architecture of the project, the server and the
  modules
- Do not propose workarounds
- Solve problems without changing the architecture

## Performance consciousness

Apply this when the project is sensitive to resources (a backend under load,
mobile, embedded, optimized libraries).

Assess the performance impact before any change.

- Always explain explicitly why a change is needed and what performance
  trade-off it carries. If a fix makes a metric worse, state the cost and
  justify it through correctness or safety
- Use the patterns already accepted in the code base (specialized libraries,
  caching, batch operations)
- Measure before and after, compare snapshots or benchmarks. Record a regression
  on a hot path and bring it up for discussion
- Take data structures and storage schemas into account. Do not add frequently
  read fields thoughtlessly
- Know the hot paths of the project and mark them in this file. Any regression
  there is critical

Hot paths (fill in per project):
- list the functions, endpoints, screens and queries that run most often

## Build & verification commands

List the commands for build, tests, formatting, static analysis and snapshots.

Skeleton example:

```
<build>
<test>
<format>
<lint / typecheck>
<snapshot / bench>
```

CI runs (list the steps).

After every change, run all the commands in order and clear the findings before
declaring the task finished.

## Project structure

Give the current directory tree with short annotations for every key folder and
important file. Keep the tree current, see Keeping this file up to date.

## Code requirements

### General principles

- A minimalist approach: the least code that keeps the functionality
- Compactness without losing what the system can do
- Build reusable components
- Keep the number of created files down; create only the necessary ones
- Logging for error diagnosis is mandatory
- Never write code before being explicitly asked
- Keep all functionality; reducing implemented functionality is forbidden
- No comments in code unless explicitly requested
- Compact writing that stays readable

### License and headers

- which header goes into production files
- which one into tests and dev utilities
- exceptions and forks of third-party modules

### Versions and pins

- versions of the language, the runtime and the key tools
- where an exact pin is allowed and where a range is acceptable
- the rule for choosing a version for new files: follow the neighbouring files
  in the same directory

### Formatting

List the formatter settings, line length, indentation and comment wrapping.
State that running the formatter before finishing a task is mandatory.

### File and module layout

Fix the order of sections inside a file, the separators and the order of
declarations (constants, state, constructor, public API, internal functions, and
so on).

### Imports

- grouping (external, internal, relative)
- where paths come from (aliases, remappings, baseUrl)
- no duplication of path configuration in several places

### Naming

- internal and private entities
- constants
- function parameters
- classes, modules, libraries
- test entities and fixtures

### Errors & events

- where domain errors and events live
- how they are reused between modules and tests

## Documentation standards

Every new public module, class, function, error, event and type in production
code must carry documentation. Do not add documentation after the fact to
existing stabilized code unless the fix changes the behavior it describes.

Provide documentation block templates for:
- a module, class, library, interface
- errors and exceptions
- events or signals
- functions (purpose, implementation details, parameters, return value)
- fields of structures and models

### Documentation stability under formatting

If the formatter wraps long comments, describe the length limit for a
description and the command that checks integrity (a grep over the joined tags).

### Where documentation is not needed

- test files and fixtures
- internal mocks and dev utilities
- existing stabilized code whose behavior does not change

## Testing

### Framework and configuration

- the test framework and runner
- the number of runs for property tests, fuzzing and e2e
- optimizer settings and test builds

### Where tests live

Where the unit, integration, e2e and snapshot tests live. Where the dev
utilities and mocks live.

### Test structure

Describe the base class or the set of fixtures, the utilities, the ready-made
accounts or users, and the helpers for preparing state and asserting.

### Naming of test functions

- happy path
- error scenarios
- properties and fuzzing
- benchmarks and snapshots

### Adding new tests

1. Add to the existing file for the module under test
2. If there is no such file, create one following the accepted template
3. Do not add test functions to base classes and fixtures

### Coverage requirements

- the target for line and branch coverage of new and changed code
- positive tests must check every observable effect (events, state, responses,
  side effects)
- negative tests must check the specific error type or the specific selector

### Snapshots and benchmarks

If there are any, describe how and when to regenerate them.

### Test patterns

- substituting the user, the context, time, the network
- expecting errors and events
- balance and assertion helpers
- data preparation helpers

### Test entities

Keep the table of accounts, users and roles current for the project.

## Dependencies

A list of the key dependencies with one line about the role of each. Update it
when one is added or removed.

## Localization and context

- Analyse all input
- The primary location is northern Europe; that affects geography, names, date
  formats, currencies and similar elements

## Keeping this file up to date

After any task that changes conventions, structure or processes, update this
file.

- new modules or directories update Project structure
- new dependencies go into Dependencies
- changes to conventions (naming, test patterns, versions, formatting) are
  recorded in the corresponding sections
- a language or runtime version bump
  1. update the version in the build configuration
  2. replace the exact pins across the project files, leaving range pins and
     third-party dependencies alone
  3. update the Versions and pins section
  4. run the build, the tests and the formatter
- new error and event contracts are recorded in the Errors & events section
- CI and build command changes go into Build & verification commands
- new test helpers and accounts go into Testing
- new public entities must carry documentation following the accepted templates
- changes to the policy after a release or an audit are recorded in the
  Post-release policy

Do not add notes about the current task or temporary marks here; stable,
reusable instructions only.
