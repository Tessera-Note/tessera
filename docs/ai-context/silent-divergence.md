# Silent divergence: how to look for it

A separate class of defects with a single definition: **a person considers done
what has not been done, and the product says nothing about it.**

This is not an observation or a moral, it is a way of searching. The most
harmful thing found in a day of work was never where it was being looked for,
and every time it turned out to be this class.

## Why the usual means do not find it

Tests check that the success path works. Here the success path does work; what
diverges is **the message about it and what actually happened**. There are no
errors in the logs, no failure codes, nothing red in the interface. The defect is
visible only to whoever later discovers that the result never happened, and by
then there is usually nothing left to connect the two.

So it has to be looked for deliberately, by going through the signs, rather than
waiting for a complaint.

## The signs to go through

### 1. The interface confirms success before the result is achieved

- state changes before the server's answer is awaited
- a "success" notification is shown where the server has not answered yet
- local state is cleared before a request that may not go through

**Found that way:** signing out cleared the local state and then revoked the
session on the server. A failure of the revocation was not handled: the
navigation did not happen, and the person was left looking signed out with a
live session.

### 2. A failure is swallowed where a person is waiting for it

- an empty `catch` around an action the person started themselves
- `.catch(() => {})` on a promise that changes data
- the same thing on the application side: `except Exception: pass`, and an
  `except` that returns a default value instead of a failure
- a handler that removes the loading indicator and says nothing

**Found that way:** attaching a file in the AI chat. The route served an empty
attachment with the look of success, the client swallowed the failure with an
empty `catch`, and the file disappeared with no explanation. Plus four of the
same kind in avatar and space icon uploads.

### 3. A stub that answers with success

- a route that returns an empty object instead of a result
- a function that is declared, does nothing, and does not fail

**Found that way:** the same upload in the chat. A review called it "existing
debt", meaning harmless. The debt turned out to be losing data.

### 4. A queued job with nothing to run it

- a job is put in a queue and has no handler
- a job is marked successful earlier than the result is obtained

**Found that way:** a job was queued while nothing consumed that queue at all.
And separately: the PDF export saved a file with the text of an error inside it
and marked the task successful.

**How to look:** compare in both directions. Walking from handlers to sources
misses a queued job with no runner; walking from sources to handlers misses the
converse. Be careful with handlers that do not inspect the job name: one that
takes its whole queue looks absent by a formal grep.

### 5. Described and not in force

- a variable is documented but never reaches the application
- a comment asserts a guarantee the code does not have
- a test is written and checks nothing
- a setting is saved and read nowhere

**Found that way:** `TRUST_PROXY_HOPS` was described in `STACK.md` while compose
did not pass it through. A comment promised that a decision was made once by
design, which the code did not do. Three guard tests were green and useless.

The "Full page width" and "Pinned editor toolbar" switches were saved to the
server, served back in the session and read by no screen at all: a person
toggled them, the server answered "saved", and neither the sheet nor the toolbar
changed. Checking for that is done not from the settings screen but backwards —
from the settings field to the place where it is applied.

### 6. A partial result presented as a complete one

- a set is processed, part of it is skipped, and the report is one for all
- "applied" instead of "four of seven applied"

**Found that way:** the PDF export stops at the limit of a hundred pages and says
nothing about it. A person who exported a space of a hundred and fifty pages gets
a file of one hundred and considers it complete. There is now a trace in the
server log only, and the message does not reach the person — not closed.

**How to look:** any place where a loop swallows the failure of an item, or stops
at a limit and keeps quiet. Going through the server gave eight such loops; seven
turned out to be legitimate: skipping a page without permissions matches what the
person sees in the tree, and probing file paths promises nothing. The fix is
almost always one of two: stop at the first failure, or name what was skipped.
Carrying on silently is not allowed.

### 7. A failure invisible to the operator

A separate subspecies: a divergence that is missed not by the person at the
screen but by whoever runs the system. Three `.catch(() => {})` in a row in
session activity accounting swallow a Redis and a database failure without a
single record: the marks stop being updated and there is nothing to notice it by.

This is not the same class — nobody here considers the action done — but the
mechanism is the same, and the cure is the same: silence is replaced by a record.

### 8. A change undone by a second source of the same state

- the same state is stored twice, and the write goes into one half
- the reader prefers the other, and the change rolls back at the next opening

**Found that way:** the page body lives both in `pages.content` (JSON) and in
`pages.ydoc` (the binary collaborative editing state), and `CollabService.load`
serves the neighbour `ydoc` while there is one. `PageService.update` wrote only
the JSON, so a change made through MCP, by an outside call or by maintenance held
until the page was first opened in the editor and then rolled back silently. A
change that goes outside the collaborative document must clear `ydoc`: there is
nothing to assemble the binary state with on the application side — the editor
node schema lives in `services/collab` on Node.

**How to look:** any field duplicated in another representation. There are three
such pairs in this repository: `content` and `ydoc`, `text_content` and
`content`, `pages.tsv` and `text_content`. The last pair is held by a database
trigger, the first two by the calling code. The sign: a write to one half without
the other.

## The order of the sweep

1. Find the places by the sign (grep, a walk, a comparison in both directions)
2. For each one answer a single question: **what does a person consider done
   after this action, and does that match what happened**
3. A divergence is fixed in one of three ways: do it for real, fail explicitly,
   or name the partialness. Silence is not on the list

## What an automatic check does not cover in this class

Only reading can tell "swallows for nothing" from "swallows deliberately". A
check for an empty `catch` would forbid the legitimate cases too, and a check for
the presence of a comment would be checking the presence of a comment rather than
its meaning. That is exactly the useless form described in
`verification-operations.md`.

So the sweep is done by hand and written down: what was looked through, what was
fixed, what was left and why.
