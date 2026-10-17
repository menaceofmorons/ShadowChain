export interface Endpoint<Out, In> {
  post(message: Out): void;
  onMessage(handler: (message: In) => void): void;
  onError(handler: (reason: string) => void): void;
}

export function createMemoryChannel<A, B>(): { a: Endpoint<A, B>; b: Endpoint<B, A> } {
  let handlerA: ((message: B) => void) | null = null;
  let handlerB: ((message: A) => void) | null = null;
  const deliver = <T>(handler: ((message: T) => void) | null, message: T): void => {
    const copy = structuredClone(message);
    queueMicrotask(() => handler?.(copy));
  };
  return {
    a: {
      post: (message) => {
        deliver(handlerB, message);
      },
      onMessage: (handler) => {
        handlerA = handler;
      },
      onError: () => undefined,
    },
    b: {
      post: (message) => {
        deliver(handlerA, message);
      },
      onMessage: (handler) => {
        handlerB = handler;
      },
      onError: () => undefined,
    },
  };
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
}

export function endpointFromWorker<Out, In>(worker: WorkerLike): Endpoint<Out, In> {
  return {
    post: (message) => {
      worker.postMessage(message);
    },
    onMessage: (handler) => {
      worker.addEventListener('message', (event) => {
        handler(event.data as In);
      });
    },
    onError: (handler) => {
      worker.addEventListener('error', (event) => {
        handler(event instanceof ErrorEvent ? event.message : 'worker error');
      });
      worker.addEventListener('messageerror', () => {
        handler('worker message could not be deserialised');
      });
    },
  };
}
