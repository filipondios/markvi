// Eventos de disco (SSE) compartidos entre las ventanas del navegador.
//
// Cada `EventSource` ocupa una de las 6 conexiones HTTP/1.1 que el navegador
// permite por servidor: con 6 ventanas abiertas, la séptima (y todas sus peticiones
// `fetch`) se queda esperando. Por eso solo UNA ventana, la líder, abre el flujo y
// reenvía los eventos a las demás por un `BroadcastChannel`.
//
// La líder se elige con Web Locks: el navegador libera el candado solo cuando esa
// ventana se cierra o se descarta, y entonces la siguiente en la cola toma el relevo.
// Sin Web Locks o sin BroadcastChannel se abre un flujo propio, como antes.

export type DiskEventType = "change" | "delete";

export interface DiskEvent {
  type: DiskEventType;
  path: string;
}

export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
  request(name: string, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

export interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface SourceLike {
  addEventListener(type: "open" | "message", listener: (event: { data?: string }) => void): void;
  close(): void;
}

export interface EventHubOptions {
  url: string;
  /** Un archivo cambió o desapareció en disco. */
  onEvent(event: DiskEvent): void;
  /**
   * Puede haberse perdido algún evento y hay que revisar el estado. `full` es
   * `false` en la primera conexión (basta refrescar el índice) y `true` al
   * reconectar o al heredar el flujo de otra ventana (revisar también las pestañas).
   */
  onResync(full: boolean): void;
  /** Dependencias del navegador, sustituibles en pruebas. */
  locks?: LockManagerLike | null;
  createChannel?: ((name: string) => ChannelLike) | null;
  createSource?: (url: string) => SourceLike;
}

export interface EventHub {
  /** ¿Esta ventana es la que tiene el flujo abierto? */
  readonly leader: boolean;
  close(): void;
}

const CHANNEL_NAME = "markvi-events";
const LOCK_NAME = "markvi-events-leader";

type Relay = { kind: "event"; event: DiskEvent } | { kind: "resync" };

/** Valida un evento recibido (del servidor o de otra ventana). */
export function parseDiskEvent(value: unknown): DiskEvent | null {
  if (!value || typeof value !== "object") return null;
  const { type, path } = value as { type?: unknown; path?: unknown };
  if ((type !== "change" && type !== "delete") || typeof path !== "string") return null;
  return { type, path };
}

function parseRelay(value: unknown): Relay | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { kind?: unknown; event?: unknown };
  if (message.kind === "resync") return { kind: "resync" };
  if (message.kind === "event") {
    const event = parseDiskEvent(message.event);
    return event ? { kind: "event", event } : null;
  }
  return null;
}

export function createEventHub(options: EventHubOptions): EventHub {
  const locks =
    options.locks !== undefined
      ? options.locks
      : ((globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks ?? null);
  const makeChannel =
    options.createChannel !== undefined
      ? options.createChannel
      : typeof BroadcastChannel === "function"
        ? (name: string): ChannelLike => new BroadcastChannel(name) as unknown as ChannelLike
        : null;
  const makeSource =
    options.createSource ?? ((url: string): SourceLike => new EventSource(url) as unknown as SourceLike);

  let closed = false;
  let leader = false;
  let source: SourceLike | undefined;
  let release: (() => void) | undefined;
  let channel: ChannelLike | null = null;

  const hub: EventHub = {
    get leader() {
      return leader;
    },
    close() {
      closed = true;
      leader = false;
      source?.close();
      source = undefined;
      release?.();
      release = undefined;
      if (channel) channel.onmessage = null;
      channel?.close();
      channel = null;
    },
  };

  // Abre el flujo del servidor y lo reparte: a esta ventana directamente y al resto
  // por el canal (el emisor no recibe sus propios mensajes).
  function openStream(takeover: boolean) {
    if (closed) return;
    leader = true;
    let opened = false;
    const stream = makeSource(options.url);
    source = stream;

    const relay = (message: Relay) => {
      try {
        channel?.postMessage(message);
      } catch {
        // Un canal cerrado no debe romper el flujo propio.
      }
    };

    // Al conectar (o reconectar) se revisa el estado: puede haberse perdido algún
    // evento entre la carga inicial y la apertura del flujo, durante una
    // reconexión o mientras ninguna ventana tenía el flujo.
    stream.addEventListener("open", () => {
      const full = opened || takeover;
      opened = true;
      options.onResync(full);
      if (full) relay({ kind: "resync" });
    });

    stream.addEventListener("message", (message) => {
      let raw: unknown;
      try {
        raw = JSON.parse(message.data ?? "");
      } catch {
        return;
      }
      const event = parseDiskEvent(raw);
      if (!event) return;
      options.onEvent(event);
      relay({ kind: "event", event });
    });
  }

  if (!locks || !makeChannel) {
    openStream(false);
    return hub;
  }

  channel = makeChannel(CHANNEL_NAME);
  channel.onmessage = (message) => {
    const relay = parseRelay(message.data);
    if (!relay) return;
    // La líder reparte sus propios eventos: lo que llegue por el canal es ajeno.
    if (relay.kind === "event") options.onEvent(relay.event);
    else options.onResync(true);
  };

  // Primero se intenta tomar el candado sin esperar: si está libre esta ventana es
  // la primera líder. Si no, se encola y, cuando llegue su turno, heredará el flujo
  // (`takeover`) sin saber qué eventos pasaron entremedias.
  const hold = (takeover: boolean) => (): Promise<void> => {
    if (closed) return Promise.resolve();
    openStream(takeover);
    // El candado se mantiene mientras la promesa esté pendiente.
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };

  const acquire = async () => {
    try {
      let granted = false;
      await locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) return;
        granted = true;
        return hold(false)();
      });
      if (granted || closed) return;
      await locks.request(LOCK_NAME, hold(true));
    } catch {
      // Web Locks no funcionó: se abre un flujo propio en lugar de quedarse sin avisos.
      if (!closed && !source) openStream(false);
    }
  };
  void acquire();

  return hub;
}
