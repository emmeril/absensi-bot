function attachStatusAckFallback(socket, { isCurrent, onAck, onError }) {
  const ws = socket.ws;
  if (!ws?.on || !ws.off || !ws.listenerCount || !socket.sendNode || ws.listenerCount("CB:status")) {
    return () => {};
  }
  const handleStatus = (node) => {
    if (!isCurrent() || node?.tag !== "status" || !node.attrs?.id || !node.attrs.from) return;
    const attrs = { id: node.attrs.id, to: node.attrs.from, class: "status" };
    for (const key of ["participant", "recipient", "type"]) {
      if (node.attrs[key]) attrs[key] = node.attrs[key];
    }
    void Promise.resolve().then(() => {
      if (!isCurrent()) return;
      return socket.sendNode({ tag: "ack", attrs }).then(() => onAck?.());
    }).catch((error) => onError?.(error));
  };
  ws.on("CB:status", handleStatus);
  return () => ws.off("CB:status", handleStatus);
}

module.exports = { attachStatusAckFallback };
