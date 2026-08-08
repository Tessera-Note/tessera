# Realtime Session Security Design

## Goal

Prevent Socket.IO clients from forging page-tree events and ensure that revoked
sessions cannot establish or keep realtime connections.

## Scope

This delivery covers Socket.IO page-tree events and session-aware connection
validation. It does not change the Hocuspocus/Yjs protocol, token lifetimes, or
the HTTP mutation APIs.

## Approach

The server becomes the sole producer of page-tree Socket.IO events. Existing
client mutations continue to update local state and call the REST API, but stop
emitting `message` events. Page services publish the validated event after the
database mutation succeeds, using `WsService` to preserve filtering for
restricted pages.

Socket.IO authentication receives the same session checks as HTTP JWT
authentication: an access token must reference an active session owned by the
token user and workspace. The gateway stores the session ID on the socket. A
new `disconnectSession` method closes all sockets whose active session was
revoked; session revocation paths call it after the database update.

## Data Flow

1. A client calls an authorized page REST mutation.
2. The page service persists the mutation.
3. The page service emits a typed tree event through `WsService`.
4. `WsService` broadcasts only to allowed sockets, including the existing
   restricted-page filtering.
5. A Socket.IO handshake validates JWT signature, user membership and the
   backing active session.
6. Logout or session revocation marks the session revoked and disconnects its
   sockets immediately.

## Error Handling

- A missing, expired, revoked, mismatched, or disabled session causes the
  Socket.IO handshake to emit `Unauthorized` and disconnect.
- A client-sent `message` event is ignored; it cannot trigger a broadcast.
- Failure to disconnect a socket is logged but does not roll back a completed
  session revocation.

## Tests

- Gateway tests cover rejection of a token without an active matching session
  and acceptance of a valid active session.
- Gateway tests cover ignoring client-sent tree events.
- Session tests cover disconnection after revocation.
- Existing page mutation tests are extended where practical to assert that
  server-originated tree notifications are delegated to `WsService`.

## Compatibility

The REST endpoints and client-visible Socket.IO event payloads remain stable.
Only the event origin changes from browser to server, which removes the trust
boundary flaw without requiring a protocol migration.
