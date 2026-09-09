// EventEmitter does not await promises returned by listeners.
function safeAsyncListener(handler, onError) {
  return (...args) => {
    return Promise.resolve().then(() => handler(...args)).catch(onError);
  };
}

module.exports = { safeAsyncListener };
