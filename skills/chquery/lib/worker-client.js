export function createWorkerClient(worker, { onEvent, workerError, cancelError }) {
  const pending = new Map();
  let sequence = 0;
  const rejectAll = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  worker.onmessage = ({ data }) => {
    if (data.event) { onEvent?.(data.event); return; }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(Object.assign(new Error(data.error.message), data.error));
    else request.resolve(data.result);
  };
  worker.onerror = () => rejectAll(workerError());

  return {
    call(action, data = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, action, ...data });
      });
    },
    stop() {
      worker.terminate();
      rejectAll(cancelError());
    }
  };
}
