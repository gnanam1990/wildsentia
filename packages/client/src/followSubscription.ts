interface FollowSocket {
  addEventListener(type: 'open', listener: () => void, options: { once: boolean }): void;
  send(data: string): void;
}

/** Reconnect restores the viewer subscription, not camera/replay state or simulation state. */
export function restoreFollowOnOpen(socket: FollowSocket, currentFollow: () => string | null): void {
  socket.addEventListener('open', () => {
    const actorId = currentFollow();
    if (actorId !== null) socket.send(JSON.stringify({ type: 'watch', actorId }));
  }, { once: true });
}
